// MCP server smoke test — spawns the real server over stdio with a real MCP
// client and exercises tool listing + the two read-only tools. ZERO API cost
// (no fold is run). Proves server startup, tool registration, and engine wiring.
//
// Run with:  pnpm test:mcp   (after pnpm run build)
// Requires an API key in .env / config (the server creates its base LLM client
// at startup) but makes no model calls here.

import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TMP_DB = "./.mcp-smoke.db";
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}

let failures = 0;
const assert = (cond, label) => {
  console.log(`   ${cond ? "PASS ✅" : "FAIL ❌"}  ${label}`);
  if (!cond) failures++;
};

// Spawn the server against a throwaway DB (CONVOTREE_DB) so the smoke test never
// touches ~/.convotree/tree.db. The server still loads its API key from .env.
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/mcp/server.js"],
  env: { ...process.env, CONVOTREE_DB: TMP_DB },
});
const client = new Client({ name: "mcp-smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
console.log("tools:", names.join(", "), "\n");
assert(
  ["convo_fold", "convo_tree", "convo_status"].every((n) => names.includes(n)),
  "all 3 tools registered"
);

const status = await client.callTool({ name: "convo_status", arguments: {} });
const statusText = status.content?.[0]?.text ?? "";
assert(statusText.includes("tree_id"), "convo_status returns session info");

const tree = await client.callTool({ name: "convo_tree", arguments: {} });
const parsed = JSON.parse(tree.content?.[0]?.text ?? "null");
assert(Array.isArray(parsed) && parsed.length >= 1, "convo_tree returns a node array (root present)");

await client.close();
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}
console.log(`\n=== ${failures === 0 ? "ALL PASS" : failures + " FAILED"} === (no API calls made, temp DB cleaned up)`);
process.exit(failures === 0 ? 0 : 1);
