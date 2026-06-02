# convotree

Give your AI agent a `fold` tool. It runs a sub-task in its own isolated context and hands back a clean structured summary, so the agent's main context window doesn't fill up with the messy intermediate work.

![CI](https://github.com/salon64/convotree/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-green.svg)

convotree is a local **MCP server**. Any MCP-capable agent (Claude Code, Cursor, Cline, Windsurf) can hand off a sub-task, like research, analysis, or a design exploration, and get back only the result. The branching conversation lives in one local SQLite file, works with any of eight built-in providers, and needs no hosting.

The idea is [context folding](https://arxiv.org/abs/2510.11967): branch into a sub-task, do the work, then fold it back into a summary. convotree does this as a plain tool, with no model training involved.

---

## Why

Long agent runs tend to die from context exhaustion. Every sub-task, dead end, and tangent piles into the same window. convotree lets the agent fold a sub-task away: it does the work in a branch and keeps only a short summary in the main thread. The main context stays clean, runs last longer, and every branch is saved so you can go back and see what was tried.

## Add it to your agent (about 2 min)

```bash
pnpm install && pnpm run build          # build the server (Node ≥22, pnpm)
npm link                                # optional: puts `convotree` on PATH
convotree config set-key sk-ant-...     # or: export ANTHROPIC_API_KEY=...
```

Register the MCP server. The same `mcpServers` shape works across clients:

```json
{
  "mcpServers": {
    "convotree": { "command": "node", "args": ["/abs/path/to/convotree/dist/mcp/server.js"] }
  }
}
```

Per-client config locations (Claude Code, Cursor, Cline, Windsurf, Claude Desktop) are in [docs/mcp-setup.md](docs/mcp-setup.md).

## The tools your agent gets

| Tool | What it does |
|------|--------------|
| **`convo_fold`** | One-shot: run a sub-task in an isolated branch and return only a structured summary. Optional `web_search`, `context`, and a per-fold `model`/`provider`. |
| `branch_open` / `branch_chat` / `branch_park` / `branch_merge` | Multi-turn manual branches. Open one, chat a few turns, then summarize it (`park`) or fold the outcome into the parent (`merge`). Addressed by short id. |
| `branch_resume` / `branch_rollback` | Reopen a branch with its message history, or fork it from an earlier point. |
| `convo_tree` / `convo_status` | Inspect the session tree (read-only). |

## See it work

A research fold. The agent offloads a lookup and keeps only the answer:

```text
convo_fold({ goal: "Check current fact",
             instructions: "What is the current Node.js LTS version?",
             web_search: true })

→ [fold · anthropic/claude-sonnet-4-6 · type=research · web_search · 21s · 16.1k in / 314 out]

  QUESTION: What is the current latest LTS version of Node.js?
  FINDINGS:
  - Node.js v24.x ("Krypton") is the current LTS line ...
  RECOMMENDATION: ...
  SOURCES:
  - https://nodejs.org/en/about/previous-releases
  - https://nodejs.org/en/blog/release/v24.11.0
```

Only that summary enters the agent's context. The search churn stays folded away in the branch.

A multi-turn branch. Think in isolation, then merge just the conclusion:

```text
branch_open(goal="Decide the API shape")          → branch 7ccf1ed5
branch_chat(7ccf1ed5, "draft 3 options, terse")
branch_chat(7ccf1ed5, "pick the best and why")    ← remembers turn 1
branch_merge(7ccf1ed5)                            → one-paragraph conclusion injected into the parent
```

## What it does well

- Pick a model per fold: `anthropic`, `openai`, `ollama` (local), `groq`, `openrouter`, `gemini`, `deepseek`, `xai`. Use a frontier model for the hard folds and a cheap or local one for light work.
- Folds reason over what you give them. They have no file or shell access by design, so you pass material in through `context` or turn on `web_search`. Your host agent keeps the tool-using work; convotree distills the thinking.
- Everything is saved. Each branch, summary, and token count sits in one SQLite file you can open anytime.
- Heavy folds emit MCP progress, so they don't trip client timeouts.

## How it works

A conversation is a tree of nodes, not a flat log. Each node is a focused branch with a `goal`, a `branch_type` (research, debug, docs, experiment, or tangent), a `context_mode` (a `summary` seed or the `full_context` lineage), and its own messages. You **branch** to explore, **park** to summarize and step back, **merge** to fold an outcome into the parent as one patch message, and **rollback** to fork from an earlier point (the old path is kept, just marked deprecated). `convo_fold` rolls all of that into a single call.

## Library

The engine is importable for your own workflows:

```ts
import { createTree, getDB, createLLMClient, loadConfig } from "convotree";

const config = loadConfig();
const orch = createTree(getDB(config.db_path), createLLMClient(config), { name: "demo", goal: "..." });

await orch.chat("hello");
const branch = await orch.branch("investigate X", "research", "summary");
await orch.chat("...");
const { summary } = await orch.park();
```

Add a provider without touching the core: `registerProvider("my-llm", (cfg) => /* an LLMClient */)`.

## Configuration

Manage it with `convotree config` (`show`, `set <field> <value>`, `set-key <key> [--provider X]`), or edit `~/.convotree/config.json` directly: `provider`, `model`, `max_tokens`, `fold_provider`/`fold_model`, `api_keys`. Keys are also read from `<PROVIDER>_API_KEY` env vars. Everything is stored under `~/.convotree/`.

## CLI

convotree also ships a CLI that drives the same engine interactively. `convotree init <name> <goal>` drops you into a branch / park / merge / rollback REPL (`convotree --help` for the rest).

## Status

Early, but working and dogfood-tested: the MCP server above, an importable library, a CLI, and a model-agnostic backend with eight providers. MIT licensed.
