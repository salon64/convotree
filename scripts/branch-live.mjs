// LIVE test of the Design A manual tools — real API calls (a few cents).
// Proves: stateless short-id addressing, multi-turn memory within a branch
// across separate tool calls, and merge injecting a patch into the parent.
//
// Run with:  node scripts/branch-live.mjs

import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TMP_DB = "./.branch-live.db";
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/mcp/server.js"],
  env: { ...process.env, CONVOTREE_DB: TMP_DB },
});
const client = new Client({ name: "branch-live", version: "0.0.0" });
await client.connect(transport);

const call = (name, args = {}) =>
  client.callTool({ name, arguments: args }, undefined, {
    timeout: 120000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => process.stderr.write(`    … ${p.message ?? p.progress}\n`),
  });
const text = (r) => r.content?.[0]?.text ?? "";

console.log("\n# branch_open");
const open = await call("branch_open", { goal: "Decide convotree's one-line pitch", branch_type: "experiment" });
console.log(text(open));
const id = text(open).match(/branch ([0-9a-f]{8})/)?.[1];
if (!id) { console.error("FAIL: could not parse branch id"); process.exit(1); }

console.log("\n# branch_chat — turn 1");
console.log(text(await call("branch_chat", {
  branch_id: id,
  message: "Propose exactly 3 one-line pitches for convotree (a CLI + MCP tool that folds agent sub-tasks into summaries). Number them 1-3, nothing else.",
})));

console.log("\n# branch_chat — turn 2 (must remember turn 1 → tests cross-call branch memory)");
console.log(text(await call("branch_chat", {
  branch_id: id,
  message: "Pick the best of those three and say why in one sentence.",
})));

console.log("\n# branch_merge (into parent root)");
console.log(text(await call("branch_merge", { branch_id: id })));

console.log("\n# convo_tree");
console.log(text(await call("convo_tree")));

await client.close();
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
console.log("\n=== done (temp DB cleaned up) ===");
process.exit(0);
