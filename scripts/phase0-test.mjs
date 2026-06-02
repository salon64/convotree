// Phase 0 live smoke test — runs the Orchestrator directly (not the REPL).
// Run with:  pnpm test:phase0   (or: node scripts/phase0-test.mjs)
// Loads .env for the API key and uses a throwaway temp DB so it never
// touches ~/.convotree/tree.db.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { loadConfig } from "../dist/config.js";
import { getDB, insertTree, insertNode } from "../dist/db/queries.js";
import { createLLMClient } from "../dist/llm/client.js";
import { Orchestrator } from "../dist/agents/orchestrator.js";

const TMP_DB = "./.phase0-test.db";
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}

const config = loadConfig();
config.db_path = TMP_DB; // isolate test data
const db = getDB(config.db_path);
const llm = createLLMClient(config);
console.log(`provider=${llm.provider} model=${llm.model}\n`);

const now = new Date().toISOString();
const treeId = randomUUID();
const root = {
  id: randomUUID(), parent_id: null, branch_point_index: null,
  branch_type: "main", context_mode: "full_context", status: "active",
  goal: "Phase 0 test root", context_seed: null, messages: [], summary: null,
  input_tokens: 0, output_tokens: 0, created_at: now, updated_at: now,
};
const tree = {
  id: treeId, name: "phase0-test", root_node_id: root.id,
  active_node_id: root.id, created_at: now, updated_at: now,
};
insertTree(db, tree);
insertNode(db, treeId, root);
const orch = new Orchestrator(db, llm, tree);

const CODEWORD = "PURPLE-PARROT-42";
let pass = true;

// ── 1 + 2. Establish context in main, check token accrual ───────────────────
console.log("→ [main] turn 1: plant codeword");
await orch.chat(`Please remember this codeword for later: ${CODEWORD}. Just acknowledge it.`);
console.log("→ [main] turn 2: add a detail");
await orch.chat("Also note: we're building a CLI tool in TypeScript called convotree.");
const mainNode = orch.getActiveNode();
console.log(`   main tokens → in:${mainNode.input_tokens} out:${mainNode.output_tokens}`);
const tokensOk = mainNode.input_tokens > 0 && mainNode.output_tokens > 0;
console.log(`   token tracking: ${tokensOk ? "PASS ✅" : "FAIL ❌"}\n`);
pass &&= tokensOk;

// ── full_context carry ───────────────────────────────────────────────────────
console.log("→ branch(full_context) off main");
const child = await orch.branch("Recall earlier context", "research", "full_context");
console.log(`   child branch_point_index=${child.branch_point_index} (expect 3, not -1)`);
console.log("→ [child] ask for the codeword (only answerable if parent context carried)");
const answer = await orch.chat("What codeword did I ask you to remember earlier? Reply with ONLY the codeword.");
console.log(`   child answer: ${JSON.stringify(answer.trim())}`);
const carried = answer.includes(CODEWORD);
console.log(`   full_context carry: ${carried ? "PASS ✅" : "FAIL ❌"}\n`);
pass &&= carried;

const childNode = orch.getActiveNode();
console.log(`   child tokens → in:${childNode.input_tokens} out:${childNode.output_tokens}\n`);

// ── 3. Caching (bonus): reuse a large prefix, look for a cache read ──────────
console.log("→ caching check: two calls sharing a ~3k-token prefix");
const bigPrefix = "REFERENCE MATERIAL (ignore the content): " +
  "The quick brown fox jumps over the lazy dog. ".repeat(300);
const r1 = await llm.complete([{ role: "user", content: bigPrefix + "\n\nReply with just: OK" }], undefined, { cache: true });
const r2 = await llm.complete([
  { role: "user", content: bigPrefix + "\n\nReply with just: OK" },
  { role: "assistant", content: r1.content },
  { role: "user", content: "Reply with just: OK again" },
], undefined, { cache: true });
console.log(`   r1 usage:`, r1.usage);
console.log(`   r2 usage:`, r2.usage);
const cacheRead = (r2.usage?.cache_read_input_tokens ?? 0) > 0;
console.log(`   cache read on 2nd call: ${cacheRead ? "PASS ✅" : "no read (prefix may be below model minimum)"}\n`);

// ── Summary + cleanup ────────────────────────────────────────────────────────
console.log("=== RESULT ===");
console.log(`full_context carry : ${carried ? "PASS" : "FAIL"}`);
console.log(`token tracking     : ${tokensOk ? "PASS" : "FAIL"}`);
console.log(`prompt caching      : ${cacheRead ? "PASS" : "inconclusive"}`);

db.close();
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}
console.log("\n(temp DB cleaned up)");
process.exit(pass ? 0 : 1);
