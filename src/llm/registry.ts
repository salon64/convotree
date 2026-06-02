import { Config, LLMClient } from "../models/types.js";

// ─── Provider Registry ─────────────────────────────────────────────────────────
// Providers are plugins: register a factory by name, and createLLMClient resolves
// the active provider from config. Built-ins (anthropic, openai) self-register in
// ./client.js; adding a new provider is `registerProvider(name, factory)` — no
// edits to core code.

export type ProviderFactory = (config: Config) => LLMClient;

const registry = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  registry.set(name, factory);
}

export function listProviders(): string[] {
  return [...registry.keys()];
}

export function createLLMClient(config: Config): LLMClient {
  const factory = registry.get(config.provider);
  if (!factory) {
    const known = listProviders().join(", ") || "(none)";
    throw new Error(
      `Unknown provider "${config.provider}". Registered providers: ${known}.`
    );
  }
  return factory(config);
}
