// LIVE A/B: the SAME research fold with web_search OFF vs ON, to compare what we
// like/don't like. Real API calls (web_search adds a small per-search fee + tokens).
// Uses a throwaway DB. Run with:  node scripts/mcp-fold-compare.mjs

import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TMP_DB = "./.mcp-fold-compare.db";
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/mcp/server.js"],
  env: { ...process.env, CONVOTREE_DB: TMP_DB },
});
const client = new Client({ name: "mcp-fold-compare", version: "0.0.0" });
await client.connect(transport);

// A question whose accurate answer depends on current/external info — so web
// search should visibly change the result vs. the model answering from memory.
const base = {
  goal: "Check current MCP TypeScript SDK state",
  instructions:
    "In 3 short bullets: the current latest version of the npm package '@modelcontextprotocol/sdk', " +
    "and one notable recent change. State your confidence; cite a source if you have one.",
  branch_type: "research",
};

async function run(label, web_search) {
  console.log(`\n════════ ${label} ════════`);
  const t0 = Date.now();
  const res = await client.callTool({ name: "convo_fold", arguments: { ...base, web_search } });
  const ms = Date.now() - t0;
  const text = res.content?.[0]?.text ?? "";
  console.log(res.isError ? `ERROR: ${text}` : text);
  console.log(`(${(ms / 1000).toFixed(1)}s)`);
  return !res.isError;
}

const a = await run("WITHOUT web_search", false);
const b = await run("WITH web_search", true);

await client.close();
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}
console.log(`\n=== without ${a ? "OK" : "FAIL"} · with ${b ? "OK" : "FAIL"} === (temp DB cleaned up)`);
process.exit(a && b ? 0 : 1);
