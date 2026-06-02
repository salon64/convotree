// LIVE test of branch_resume + branch_rollback (one cheap chat turn).
// Run with:  node scripts/rollback-live.mjs

import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TMP_DB = "./.rollback-live.db";
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/mcp/server.js"],
  env: { ...process.env, CONVOTREE_DB: TMP_DB },
});
const client = new Client({ name: "rollback-live", version: "0.0.0" });
await client.connect(transport);
const call = (name, args = {}) =>
  client.callTool({ name, arguments: args }, undefined, {
    timeout: 120000,
    resetTimeoutOnProgress: true,
    onprogress: (p) => process.stderr.write(`    … ${p.message ?? p.progress}\n`),
  });
const text = (r) => r.content?.[0]?.text ?? "";

const open = await call("branch_open", { goal: "test rollback", branch_type: "experiment" });
console.log("# branch_open\n" + text(open));
const id = text(open).match(/branch ([0-9a-f]{8})/)[1];

console.log("\n# branch_chat (turn 1)");
console.log(text(await call("branch_chat", { branch_id: id, message: "Reply with one word: a color." })));

console.log("\n# branch_resume (indexed messages)");
console.log(text(await call("branch_resume", { branch_id: id })));

console.log("\n# branch_rollback to index 0 (drop the assistant reply)");
console.log(text(await call("branch_rollback", { branch_id: id, message_index: 0 })));

console.log("\n# convo_tree (original should be deprecated; new fork active)");
console.log(text(await call("convo_tree")));

await client.close();
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
