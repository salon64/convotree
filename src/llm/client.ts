import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { LLMClient, LLMMessage, LLMResponse, CompleteOptions } from "../models/types.js";
import { getApiKey } from "../config.js";
import { registerProvider } from "./registry.js";

// ─── Anthropic ───────────────────────────────────────────────────────────────

class AnthropicClient implements LLMClient {
  provider = "anthropic";
  model: string;
  private client: Anthropic;
  private maxTokens: number;

  constructor(apiKey: string, model: string, maxTokens: number) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
    this.maxTokens = maxTokens;
  }

  async complete(
    messages: LLMMessage[],
    systemPrompt?: string,
    opts?: CompleteOptions
  ): Promise<LLMResponse> {
    const apiMessages: Anthropic.MessageParam[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Prompt caching: drop a cache breakpoint on the last message so the
    // conversation prefix is reused across turns. Only worth it for multi-turn
    // calls (chat) — one-shot agent calls would just pay the write premium.
    // Below the model's minimum cacheable prefix this silently no-ops, which is
    // fine: short branches don't cache, long ones do.
    if (opts?.cache && apiMessages.length > 0) {
      const last = apiMessages[apiMessages.length - 1];
      if (typeof last.content === "string") {
        last.content = [
          { type: "text", text: last.content, cache_control: { type: "ephemeral" } },
        ];
      }
    }

    // Server-side web search (Anthropic-hosted). `allowed_callers: ["direct"]`
    // makes it work on models that lack programmatic tool calling (e.g. Haiku) —
    // it forgoes the code-based dynamic result filtering those models can't run
    // anyway, so web_search folds work across cheap and frontier models alike.
    const tools = opts?.webSearch
      ? ([{ type: "web_search_20260209", name: "web_search", allowed_callers: ["direct"] }] as any)
      : undefined;

    const textParts: string[] = [];
    const sources = new Map<string, string>(); // url -> title (deduped web-search citations)
    let inTok = 0, outTok = 0, cacheRead = 0, cacheCreate = 0;
    let stopReason: string | null = null;
    let guard = 0;

    // Server tools run a loop on Anthropic's side and may return stop_reason
    // "pause_turn"; re-send with the assistant turn appended to continue.
    do {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: opts?.maxTokens ?? this.maxTokens,
        system: systemPrompt,
        messages: apiMessages,
        ...(tools ? { tools } : {}),
      });

      for (const b of response.content as any[]) {
        if (b.type === "text") {
          textParts.push(b.text);
          // Citations the model attached to its prose (web_search_result_location)
          if (Array.isArray(b.citations)) {
            for (const c of b.citations) if (c?.url) sources.set(c.url, c.title || c.url);
          }
        } else if (b.type === "web_search_tool_result") {
          // Raw results the search tool returned
          if (Array.isArray(b.content)) {
            for (const r of b.content) if (r?.url) sources.set(r.url, r.title || r.url);
          }
        }
      }
      inTok += response.usage.input_tokens;
      outTok += response.usage.output_tokens;
      cacheRead += response.usage.cache_read_input_tokens ?? 0;
      cacheCreate += response.usage.cache_creation_input_tokens ?? 0;

      stopReason = response.stop_reason;
      if (stopReason === "pause_turn") {
        apiMessages.push({ role: "assistant", content: response.content });
      }
      guard++;
    } while (stopReason === "pause_turn" && guard < 6);

    // Keep web-search sources attached to the text so the cited URLs survive into
    // the branch and its summary (otherwise they're lost when the turn is distilled).
    let content = textParts.join("");
    if (opts?.webSearch && sources.size > 0) {
      const list = [...sources.entries()]
        .slice(0, 10)
        .map(([url, title]) => `- ${title} — ${url}`)
        .join("\n");
      content += `\n\nSources:\n${list}`;
    }

    return {
      content,
      usage: {
        input_tokens: inTok,
        output_tokens: outTok,
        cache_read_input_tokens: cacheRead || undefined,
        cache_creation_input_tokens: cacheCreate || undefined,
      },
    };
  }
}

// ─── OpenAI ──────────────────────────────────────────────────────────────────
// OpenAI caches eligible prefixes server-side automatically, so `opts.cache` is
// a no-op here — it only affects the Anthropic path.

class OpenAIClient implements LLMClient {
  provider = "openai";
  model: string;
  private client: OpenAI;
  private maxTokens: number;

  constructor(apiKey: string, model: string, maxTokens: number, baseURL?: string) {
    this.client = new OpenAI(baseURL ? { apiKey, baseURL } : { apiKey });
    this.model = model;
    this.maxTokens = maxTokens;
  }

  async complete(
    messages: LLMMessage[],
    systemPrompt?: string,
    opts?: CompleteOptions
  ): Promise<LLMResponse> {
    // Server-side web search is Anthropic-only; warn (to stderr — safe for the
    // stdio MCP server) rather than silently producing an answer with no web access.
    if (opts?.webSearch) {
      console.error(
        `⚠ convotree: web_search is only supported on the Anthropic provider; ignoring it for model "${this.model}".`
      );
    }

    const fullMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      fullMessages.push({ role: "system", content: systemPrompt });
    }
    fullMessages.push(...messages.map((m) => ({ role: m.role, content: m.content })));

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: opts?.maxTokens ?? this.maxTokens,
      messages: fullMessages,
    });

    // OpenAI's prompt_tokens already INCLUDES the cached tokens, whereas the
    // orchestrator treats input/cache_read/cache_creation as disjoint and sums
    // them. Report only the non-cached remainder as input_tokens so cached turns
    // aren't double-counted (matching Anthropic's semantics).
    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;

    return {
      content: response.choices[0]?.message?.content ?? "",
      usage: {
        input_tokens: promptTokens - cachedTokens,
        output_tokens: response.usage?.completion_tokens ?? 0,
        cache_read_input_tokens: cachedTokens || undefined,
      },
    };
  }
}

// ─── Built-in provider registration ───────────────────────────────────────────
// Registered at module load, so any import of this file makes the built-ins
// available. The public entry (src/index.ts) and the CLI both import it.

registerProvider("anthropic", (config) =>
  new AnthropicClient(getApiKey(config), config.model, config.max_tokens)
);

registerProvider("openai", (config) =>
  new OpenAIClient(getApiKey(config), config.model, config.max_tokens)
);

// ─── OpenAI-compatible providers ───────────────────────────────────────────────
// Most inference APIs expose an OpenAI-compatible endpoint, so they reuse
// OpenAIClient with a custom baseURL — adding one is a single line. The key comes
// from `api_keys.<name>` or the `<NAME>_API_KEY` env var (see getApiKey).
function registerOpenAICompatible(
  name: string,
  baseURL: string,
  opts: { requiresKey?: boolean } = {}
): void {
  registerProvider(name, (config) => {
    const apiKey =
      opts.requiresKey === false
        ? config.api_keys[name] ?? "no-key-required"
        : getApiKey(config);
    return new OpenAIClient(apiKey, config.model, config.max_tokens, baseURL);
  });
}

registerOpenAICompatible("ollama", "http://localhost:11434/v1", { requiresKey: false }); // local
registerOpenAICompatible("groq", "https://api.groq.com/openai/v1");
registerOpenAICompatible("openrouter", "https://openrouter.ai/api/v1");
registerOpenAICompatible("gemini", "https://generativelanguage.googleapis.com/v1beta/openai/");
registerOpenAICompatible("deepseek", "https://api.deepseek.com/v1");
registerOpenAICompatible("xai", "https://api.x.ai/v1");

// Re-export so existing `import { createLLMClient } from "../llm/client.js"` keeps working.
export { createLLMClient } from "./registry.js";
