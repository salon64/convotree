// LIVE MCP fold round-trip — makes real API calls (a few cents) via the server's
// own configured key (loaded from .env). Proves convo_fold end-to-end AND per-fold
// model selection. Uses a throwaway DB so ~/.convotree/tree.db stays clean.
//
// Run with:  node scripts/mcp-fold-live.mjs

import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TMP_DB = "./.mcp-fold-live.db";
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/mcp/server.js"],
  env: { ...process.env, CONVOTREE_DB: TMP_DB },
});
const client = new Client({ name: "mcp-fold-live", version: "0.0.0" });
await client.connect(transport);

async function fold(label, args) {
  console.log(`\n──── ${label} ────`);
  const res = await client.callTool({ name: "convo_fold", arguments: args });
  const text = res.content?.[0]?.text ?? "";
  console.log(res.isError ? `ERROR: ${text}` : text);
  return !res.isError;
}

// 1) default model (from config — claude-sonnet-4-6)
const ok1 = await fold("fold #1 — default model", {
  goal: "Pick a tagline for convotree",
  instructions:
    "In 2 sentences max: propose one concise tagline for convotree (a CLI + MCP tool that lets AI agents fold sub-tasks into summaries), plus a one-line rationale.",
  branch_type: "research",
});

// 2) per-fold model override → claude-opus-4-8 (the "deep research" example)
const ok2 = await fold("fold #2 — model override: claude-opus-4-8", {
  goal: "Deep-research variant",
  instructions:
    "In 2 sentences max: name the single biggest risk to convotree's market positioning and one mitigation.",
  branch_type: "research",
  model: "claude-opus-4-8",
});

// show the persisted tree (two parked research branches off root)
console.log("\n──── convo_tree ────");
const tree = await client.callTool({ name: "convo_tree", arguments: {} });
console.log(tree.content?.[0]?.text ?? "");

await client.close();
for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}
console.log(`\n=== folds: #1 ${ok1 ? "OK" : "FAIL"}, #2 ${ok2 ? "OK" : "FAIL"} === (temp DB cleaned up)`);
process.exit(ok1 && ok2 ? 0 : 1);
