// Library API + provider-plugin smoke test — ZERO API cost.
// Registers a deterministic mock provider and drives the public library API
// (createTree → chat → branch → chat → park → merge → resolveNode) against a
// throwaway temp DB. Proves the engine is usable as a library without the CLI
// and without a real model.
//
// Run with:  pnpm test:lib   (or: node scripts/lib-smoke.mjs)

import fs from "node:fs";
import {
  registerProvider, createLLMClient, listProviders,
  createTree, getDB, loadConfig,
} from "../dist/index.js";

const TMP_DB = "./.lib-smoke.db";
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}

let failures = 0;
function assert(cond, label) {
  console.log(`   ${cond ? "PASS ✅" : "FAIL ❌"}  ${label}`);
  if (!cond) failures++;
}

// ── Provider plugin: register a deterministic mock ───────────────────────────
registerProvider("mock", (config) => ({
  provider: "mock",
  model: config.model,
  async complete(messages /*, systemPrompt, opts */) {
    const last = messages[messages.length - 1]?.content ?? "";
    const text = typeof last === "string" ? last : JSON.stringify(last);
    return {
      content: `[mock reply to: ${String(text).slice(0, 40)}]`,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  },
}));
console.log("registered providers:", listProviders().join(", "), "\n");

const config = loadConfig();
config.provider = "mock";
config.db_path = TMP_DB;
const db = getDB(config.db_path);
const llm = createLLMClient(config); // resolves "mock" via the registry
assert(llm.provider === "mock", "createLLMClient resolved the mock plugin from the registry");

// unknown provider should throw a helpful error
try {
  createLLMClient({ ...config, provider: "does-not-exist" });
  assert(false, "unknown provider throws");
} catch {
  assert(true, "unknown provider throws");
}

// ── Drive the library API ────────────────────────────────────────────────────
const orch = createTree(db, llm, { name: "lib-smoke", goal: "verify the library API" });
assert(!!orch.getTreeId() && orch.getTreeName() === "lib-smoke", "createTree returned a usable Orchestrator");

await orch.chat("hello from main");
const rootAfterChat = orch.getActiveNode();
assert(rootAfterChat.messages.length === 2, "chat appended user+assistant to root");
assert(rootAfterChat.input_tokens === 10 && rootAfterChat.output_tokens === 5, "token usage accrued on root");

const branch = await orch.branch("dig into the mock", "research", "summary");
assert(!!branch.context_seed, "summary-mode branch generated a context seed (brancher ran)");

await orch.chat("what should I check?");
const branchAfterChat = orch.getActiveNode();
assert(branchAfterChat.id === branch.id && branchAfterChat.input_tokens === 10, "chat ran inside the branch with token accrual");

const { summary } = await orch.park();
assert(typeof summary === "string" && summary.length > 0, "park produced a summary");
assert(orch.getActiveNode().id !== branch.id, "park returned to the parent node");

const patch = await orch.merge(branch.id);
assert(typeof patch === "string" && patch.length > 0, "merge produced a patch message");

// ── Inspect final tree state ─────────────────────────────────────────────────
const nodes = orch.getTreeData();
const branchNode = nodes.find((n) => n.id === branch.id);
const rootNode = nodes.find((n) => n.parent_id === null);
assert(branchNode?.status === "merged", "branch is marked merged");
assert(typeof branchNode?.summary === "string" && branchNode.summary.length > 0, "branch summary persisted");
assert(rootNode?.messages.at(-1)?.role === "assistant", "merge patch injected into root as an assistant message");

const resolved = orch.resolveNode(branch.id.slice(0, 8));
assert(resolved?.id === branch.id, "resolveNode finds a node by short-id prefix");

// ── Summary + cleanup ────────────────────────────────────────────────────────
db.close();
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}
console.log(`\n=== ${failures === 0 ? "ALL PASS" : failures + " FAILED"} === (temp DB cleaned up)`);
process.exit(failures === 0 ? 0 : 1);
