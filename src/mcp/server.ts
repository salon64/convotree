#!/usr/bin/env node
// convotree MCP server (stdio). Exposes the engine as tools any MCP host can call.
//
//   convo_fold    — run a sub-task in one isolated branch on a (per-fold) model,
//                   return only the structured summary (the "fold").
//   branch_open   — open a branch for multi-turn manual work; returns a short id.
//   branch_chat   — send one turn within a branch (addressed by short id).
//   branch_park   — summarize a branch back to its parent; returns the summary.
//   branch_merge  — inject a branch's outcome into a target as one patch message.
//   branch_resume — reopen a branch: returns its indexed message history.
//   branch_rollback — fork a branch from an earlier message index.
//   convo_tree    — inspect the session tree (read-only).
//   convo_status  — current session / root (read-only).
//
// Branches are addressed by short id (stateless — no server "active node" the
// host must track); ids are echoed in responses and visible in convo_tree.
//
// stdout is the JSON-RPC channel: NEVER console.log here — log to stderr only.

import { config as loadEnv } from "dotenv";
loadEnv({ quiet: true }); // load .env before reading the API key; quiet => no stdout noise

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  loadConfig, getDB, createLLMClient, createTree, openTree, Orchestrator,
} from "../index.js";
import type { Config, BranchType, ConvoNode, LLMClient } from "../index.js";

// ─── Session state (created once per process) ──────────────────────────────────

const baseConfig: Config = loadConfig();
const db = getDB(baseConfig.db_path);

// Start even without an API key: read-only tools (convo_tree/convo_status) still
// work, and fold/branch tools return a clear "set a key" error when called.
function missingKeyClient(provider: string): LLMClient {
  return {
    provider,
    model: baseConfig.model,
    async complete() {
      throw new Error(
        `No API key for provider "${provider}". Set ${provider.toUpperCase()}_API_KEY ` +
        `or run: convotree config set-key <your-key>${provider !== "anthropic" ? ` --provider ${provider}` : ""}`
      );
    },
  };
}

let baseClient: LLMClient;
try {
  baseClient = createLLMClient(baseConfig);
} catch (e: any) {
  console.error(
    `⚠ convotree: ${e?.message ?? e}\n  Read-only tools work; fold/branch tools will error until a key is set.`
  );
  baseClient = missingKeyClient(baseConfig.provider);
}

// `base` owns the session tree and serves the read-only tools. Each operation
// gets its own Orchestrator (possibly a different model) over the same db + tree.
const base = createTree(db, baseClient, {
  name: `mcp-session-${new Date().toISOString()}`,
  goal: "MCP fold session",
  // Stateless server: never move the shared trees.active_node_id pointer (every
  // tool addresses its node by id), so a later CLI `open` of this tree still
  // resumes at the root instead of a random parked/merged branch.
  persistActive: false,
});
const treeId = base.getTreeId();
const rootId = base.getActiveNode().id;

const BRANCH_TYPES = ["research", "debug", "docs", "experiment", "tangent"] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// An Orchestrator over the session tree, on a chosen model (defaults to base).
function orchFor(model?: string, provider?: string): Orchestrator {
  const cfg: Config = {
    ...baseConfig,
    provider: provider ?? baseConfig.provider,
    model: model ?? baseConfig.model,
  };
  return openTree(db, createLLMClient(cfg), treeId, { persistActive: false });
}

function resolveOrThrow(orch: Orchestrator, prefix: string): ConvoNode {
  const node = orch.resolveNode(prefix);
  if (!node) throw new Error(`No node matches id "${prefix}". Use convo_tree to list ids.`);
  return node;
}

const errResult = (e: any) => ({
  content: [{ type: "text" as const, text: `Error: ${e?.message ?? String(e)}` }],
  isError: true,
});

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

// Emit progress on a 20s heartbeat *while* `fn` runs, so progress-aware clients
// keep resetting their request timeout through long phases (e.g. web_search).
// No-ops unless the client requested progress (sent a progressToken).
async function withHeartbeat<T>(
  extra: any,
  startMessage: string,
  fn: (ping: (message: string) => void) => Promise<T>
): Promise<T> {
  const progressToken = extra?._meta?.progressToken;
  let step = 0;
  const ping = (message: string) => {
    if (progressToken === undefined) return;
    step++;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: step, message },
      })
      .catch(() => {});
  };
  ping(startMessage);
  const heartbeat = setInterval(() => ping("still working…"), 20000);
  try {
    return await fn(ping);
  } finally {
    clearInterval(heartbeat);
  }
}

// ─── Server + tools ─────────────────────────────────────────────────────────────

const server = new McpServer({ name: "convotree", version: "0.1.0" });

server.registerTool(
  "convo_fold",
  {
    description:
      "Run a sub-task in an isolated branch and return ONLY a distilled, branch-type-structured " +
      "summary — without polluting your main context. Use for reasoning/research/synthesis " +
      "sub-questions; the fold has no access to your files or shell, so pass any needed material " +
      "via `context` (or enable `web_search` to let it gather from the web). Each fold can run on its own model.",
    inputSchema: {
      goal: z.string().describe("Why this sub-task exists — the anchor that keeps the fold on track."),
      instructions: z.string().describe("What to do or answer in the fold."),
      branch_type: z.enum(BRANCH_TYPES).default("research").describe("Shapes the structured summary format."),
      context: z.string().optional().describe("Material the fold should reason over (you gather this with your own tools)."),
      provider: z.string().optional().describe("Override the provider for this fold (must be registered and have a key)."),
      model: z.string().optional().describe("Override the model for this fold, e.g. claude-opus-4-8 for deep research."),
      web_search: z
        .boolean()
        .default(false)
        .describe("Let the fold gather from the web via Anthropic server-side search. Requires the Anthropic provider."),
    },
  },
  async ({ goal, instructions, branch_type, context, provider, model, web_search }, extra) => {
    const foldConfig: Config = {
      ...baseConfig,
      provider: provider ?? baseConfig.fold_provider ?? baseConfig.provider,
      model: model ?? baseConfig.fold_model ?? baseConfig.model,
    };

    let foldOrch: Orchestrator;
    try {
      foldOrch = openTree(db, createLLMClient(foldConfig), treeId, { persistActive: false });
    } catch (e: any) {
      return errResult(e);
    }

    try {
      return await withHeartbeat(extra, "starting fold", async (ping) => {
        const t0 = Date.now();
        // web_search is Anthropic-only; don't advertise it for other providers.
        const webSearch = web_search && foldConfig.provider === "anthropic";
        foldOrch.resume(rootId); // folds branch off the session root
        const branchNode = await foldOrch.branch(goal, branch_type as BranchType, "summary");
        ping(`running sub-task on ${foldConfig.model}${webSearch ? " (web search)" : ""}`);
        const input = (context ? `${context}\n\n` : "") + instructions;
        await foldOrch.chat(input, { webSearch: webSearch });
        ping("summarizing");
        const { summary } = await foldOrch.park();

        // Re-read the branch for accrued chat token usage; report wall time too.
        const fresh = foldOrch.resolveNode(branchNode.id);
        const secs = Math.round((Date.now() - t0) / 1000);
        const header =
          `[fold · ${foldConfig.provider}/${foldConfig.model} · type=${branch_type}` +
          `${webSearch ? " · web_search" : ""} · ${secs}s · ` +
          `${fmtTokens(fresh?.input_tokens ?? 0)} in / ${fmtTokens(fresh?.output_tokens ?? 0)} out]`;
        return { content: [{ type: "text" as const, text: `${header}\n\n${summary}` }] };
      });
    } catch (e: any) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "branch_open",
  {
    description:
      "Open a NEW branch for multi-turn manual work and return its short id. Send turns with " +
      "branch_chat(branch_id, ...), then close with branch_park (summarize back to parent) or " +
      "branch_merge (inject the outcome into the parent). Branches are addressed by short id — " +
      "echoed here and in convo_tree; pass it back on each call. Default parent is the session root.",
    inputSchema: {
      goal: z.string().describe("Why this branch exists — keeps it anchored."),
      branch_type: z.enum(BRANCH_TYPES).default("tangent").describe("Shapes the summary you get on park/merge."),
      full_context: z
        .boolean()
        .default(false)
        .describe("Carry the parent's full conversation into the branch (vs a distilled seed). Use for hard questions that need the whole thread."),
      parent_id: z.string().optional().describe("Short id of the parent to branch from (default: session root)."),
      model: z.string().optional(),
      provider: z.string().optional(),
    },
  },
  async ({ goal, branch_type, full_context, parent_id, model, provider }, extra) => {
    try {
      return await withHeartbeat(extra, "opening branch", async () => {
        const orch = orchFor(model, provider);
        orch.resume(parent_id ? resolveOrThrow(orch, parent_id).id : rootId);
        const node = await orch.branch(goal, branch_type as BranchType, full_context ? "full_context" : "summary");
        const short = node.id.slice(0, 8);
        const mode = full_context ? "full_context" : "summary";
        return {
          content: [{
            type: "text" as const,
            text:
              `Opened branch ${short} [${branch_type} · ${mode}] — "${goal}".\n` +
              `Chat: branch_chat(branch_id="${short}", message=…). ` +
              `Close: branch_park("${short}") or branch_merge("${short}").`,
          }],
        };
      });
    } catch (e: any) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "branch_chat",
  {
    description:
      "Send one turn within an open branch and get the reply. The exchange stays in the branch, " +
      "not your main context. Address the branch by short id.",
    inputSchema: {
      branch_id: z.string().describe("Short id of the branch (from branch_open / convo_tree)."),
      message: z.string().describe("The message to send in the branch."),
      web_search: z.boolean().default(false).describe("Let this turn gather from the web (Anthropic provider)."),
      model: z.string().optional(),
      provider: z.string().optional(),
    },
  },
  async ({ branch_id, message, web_search, model, provider }, extra) => {
    try {
      return await withHeartbeat(extra, "thinking", async () => {
        const orch = orchFor(model, provider);
        orch.resume(resolveOrThrow(orch, branch_id).id);
        const reply = await orch.chat(message, { webSearch: web_search });
        return { content: [{ type: "text" as const, text: reply }] };
      });
    } catch (e: any) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "branch_park",
  {
    description:
      "Close a branch: summarize it (branch-type-structured) and return to its parent. Returns the summary.",
    inputSchema: {
      branch_id: z.string().describe("Short id of the branch to park."),
      model: z.string().optional(),
      provider: z.string().optional(),
    },
  },
  async ({ branch_id, model, provider }, extra) => {
    try {
      return await withHeartbeat(extra, "summarizing", async () => {
        const orch = orchFor(model, provider);
        orch.resume(resolveOrThrow(orch, branch_id).id);
        const { summary } = await orch.park();
        return { content: [{ type: "text" as const, text: summary }] };
      });
    } catch (e: any) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "branch_merge",
  {
    description:
      "Merge a branch's outcome into a target node (default: the branch's parent) as one patch " +
      "message, and mark the branch merged. Returns the patch.",
    inputSchema: {
      branch_id: z.string().describe("Short id of the branch to merge."),
      target_id: z.string().optional().describe("Short id of the node to merge into (default: the branch's parent)."),
      model: z.string().optional(),
      provider: z.string().optional(),
    },
  },
  async ({ branch_id, target_id, model, provider }, extra) => {
    try {
      return await withHeartbeat(extra, "merging", async () => {
        const orch = orchFor(model, provider);
        const branch = resolveOrThrow(orch, branch_id);
        const targetNodeId = target_id ? resolveOrThrow(orch, target_id).id : branch.parent_id;
        if (!targetNodeId) throw new Error("Branch has no parent to merge into; specify target_id.");
        const patch = await orch.merge(branch.id, targetNodeId);
        return { content: [{ type: "text" as const, text: patch }] };
      });
    } catch (e: any) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "branch_resume",
  {
    description:
      "Reopen a branch: returns its goal, status, and full indexed message history so you can " +
      "continue it (with branch_chat) or pick a message index to roll back to. Read-only.",
    inputSchema: {
      branch_id: z.string().describe("Short id of the branch (from branch_open / convo_tree)."),
    },
  },
  async ({ branch_id }) => {
    try {
      const node = resolveOrThrow(base, branch_id);
      const view = {
        id: node.id.slice(0, 8),
        goal: node.goal,
        branch_type: node.branch_type,
        status: node.status,
        messages: node.messages.map((m, i) => ({ index: i, role: m.role, content: m.content })),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(view, null, 2) }] };
    } catch (e: any) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "branch_rollback",
  {
    description:
      "Fork a new branch from message[index] of a branch; messages after that point are deprecated " +
      "(kept, not deleted). Returns the new branch's short id. Use branch_resume to see indices.",
    inputSchema: {
      branch_id: z.string().describe("Short id of the branch to roll back."),
      message_index: z
        .number()
        .int()
        .describe("Index of the last message to keep (0-based; see branch_resume)."),
      as_type: z.enum(BRANCH_TYPES).optional().describe("Optionally change the branch type of the fork."),
      model: z.string().optional(),
      provider: z.string().optional(),
    },
  },
  async ({ branch_id, message_index, as_type, model, provider }) => {
    try {
      const orch = orchFor(model, provider);
      orch.resume(resolveOrThrow(orch, branch_id).id);
      const newNode = await orch.rollback(message_index, as_type as BranchType | undefined);
      const short = newNode.id.slice(0, 8);
      return {
        content: [{
          type: "text" as const,
          text:
            `Rolled back to message[${message_index}] → new branch ${short} [${newNode.branch_type}]. ` +
            `Continue with branch_chat(branch_id="${short}", …); the old forward path is deprecated.`,
        }],
      };
    } catch (e: any) {
      return errResult(e);
    }
  }
);

server.registerTool(
  "convo_tree",
  {
    description: "Inspect the session's tree (read-only). Returns the nodes as JSON.",
    inputSchema: {},
  },
  async () => {
    const nodes = base.getTreeData().map((n) => ({
      id: n.id.slice(0, 8),
      parent: n.parent_id ? n.parent_id.slice(0, 8) : null,
      branch_type: n.branch_type,
      status: n.status,
      goal: n.goal,
      messages: n.messages.length,
      tokens: { in: n.input_tokens, out: n.output_tokens },
      summary: n.summary ?? undefined,
    }));
    return { content: [{ type: "text", text: JSON.stringify(nodes, null, 2) }] };
  }
);

server.registerTool(
  "convo_status",
  {
    description: "Current session info: tree id/name and the session root (read-only).",
    inputSchema: {},
  },
  async () => {
    const node = base.getActiveNode();
    const status = {
      tree_id: treeId.slice(0, 8),
      tree_name: base.getTreeName(),
      root: {
        id: node.id.slice(0, 8),
        goal: node.goal,
        branch_type: node.branch_type,
        status: node.status,
        messages: node.messages.length,
        tokens: { in: node.input_tokens, out: node.output_tokens },
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
);

// ─── Connect over stdio ─────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("convotree MCP server running on stdio");
}

main().catch((e) => {
  console.error("convotree MCP fatal:", e);
  process.exit(1);
});
