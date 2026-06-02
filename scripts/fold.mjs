// Terminal "fold" — fire a convo_fold at the convotree MCP server from the shell.
// A convenience for dogfooding the fold on real tasks (folds persist in your tree).
//
// Usage:
//   node scripts/fold.mjs "<goal>" "<instructions>" [--web] [--type research]
//                          [--model claude-opus-4-8] [--provider anthropic]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(
  argv.filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const [goal, instructions] = positional;
if (!goal || !instructions) {
  console.error('usage: node scripts/fold.mjs "<goal>" "<instructions>" [--web] [--type T] [--model M] [--provider P]');
  process.exit(1);
}

const args = {
  goal,
  instructions,
  branch_type: flags.type ?? "research",
  web_search: !!flags.web,
};
if (flags.model) args.model = flags.model;
if (flags.provider) args.provider = flags.provider;

const transport = new StdioClientTransport({ command: "node", args: ["dist/mcp/server.js"] });
const client = new Client({ name: "fold-cli", version: "0.0.0" });
await client.connect(transport);

// Folds chain several model calls (brancher → chat [+ web search] → summarizer).
// Subscribe to progress and reset the timeout on each update so long folds
// survive; onprogress also makes the SDK attach a progressToken to the request.
const res = await client.callTool({ name: "convo_fold", arguments: args }, undefined, {
  timeout: 120000,
  resetTimeoutOnProgress: true,
  onprogress: (p) => process.stderr.write(`  … ${p.message ?? `${p.progress}/${p.total ?? "?"}`}\n`),
});
console.log("\n" + (res.content?.[0]?.text ?? ""));

await client.close();
process.exit(res.isError ? 1 : 0);
