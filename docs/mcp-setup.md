# Add convotree to your AI agent (≈2 minutes)

> **convotree** lets an AI agent *fold* a sub-task into a clean summary — branch off, do the work in
> isolation, get back only the distilled result — so your main context window never fills up.

It runs as a local **MCP server** over stdio, so it works in any MCP-capable client (Claude Code,
Cursor, Cline, Windsurf, Claude Desktop). Setup is three steps: build, give it a key, register it.

---

## 1. Build it (once)

```bash
pnpm install
pnpm run build      # produces dist/mcp/server.js
```

## 2. Give it an API key

The server runs the model itself, so it needs a key. Put it where the server finds it **regardless of
which app launches it** — your global config:

`~/.convotree/config.json`
```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "api_keys": { "anthropic": "sk-ant-..." }
}
```

> Alternatively, a `.env` (`ANTHROPIC_API_KEY=...`) in the repo works **if** your client launches the
> server with the repo as its working directory (Claude Code does). The global config above is the
> robust choice for every client.

## 3. Register the server

Every client uses the same shape — an `mcpServers` map of `{ command, args }`. Use an **absolute path**
to the built server (most clients don't launch from the repo):

```json
{
  "mcpServers": {
    "convotree": {
      "command": "node",
      "args": ["/absolute/path/to/convotree/dist/mcp/server.js"]
    }
  }
}
```

Where that JSON goes, per client:

| Client | Config file | Notes |
|---|---|---|
| **Claude Code** | `.mcp.json` (repo root, shareable) or `~/.claude.json` (user) | Restart to pick it up; **approve** the project server when prompted (`claude mcp reset-project-choices` re-triggers the prompt). `"type": "stdio"` is **not** required. |
| **Cursor** | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) | The top-level `mcpServers` key must be present. |
| **Cline** | VS Code globalStorage: `…/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` | Optional per-server `disabled` (bool) and `autoApprove` (array) fields. |
| **Windsurf** | `~/.codeium/windsurf/mcp_config.json` | Global only (no per-project config). |
| **Claude Desktop** | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json` · Windows: `%APPDATA%\Claude\claude_desktop_config.json` | Requires a full app restart after editing. |

> **Windows paths** in JSON: use forward slashes (`C:/Users/you/convotree/dist/mcp/server.js`) or
> escaped backslashes (`C:\\Users\\you\\...`).

Project-scoped config (committable for a team) is supported by **Claude Code** (`.mcp.json`) and
**Cursor** (`.cursor/mcp.json`); the others are global-only.

---

## Verify

- Restart the client and confirm `convotree` is connected (Claude Code: `/mcp`).
- Sanity-check the server alone — it should print one line to stderr and wait:
  ```bash
  node dist/mcp/server.js
  # → convotree MCP server running on stdio
  ```
  Any startup error (e.g. missing key) shows here.

## Use it

| Tool | What it does |
|---|---|
| `convo_fold` | One-shot: run a sub-task in an isolated branch, get back a structured summary. The fold can `web_search` and run on its own `model`. |
| `branch_open` / `branch_chat` / `branch_park` / `branch_merge` | Multi-turn manual branches — open one, chat several turns, then summarize (`park`) or fold the outcome into the parent (`merge`). Addressed by short id. |
| `convo_tree` / `convo_status` | Inspect the session tree (read-only). |

Just ask your agent to use it, e.g.:

> "Use `convo_fold` to research the current pricing of X (enable `web_search`) and hand me back a summary."

> "Open a branch to draft the API design, iterate a few turns, then merge the conclusion back."

---

## Good to know

- **The fold has no access to your files or shell** — that's deliberate. It reasons over what you give
  it: pass material via `context`, or enable `web_search` to let it gather from the web. Tool-using
  work (editing files, running code) stays with your host agent; convotree distills the *thinking*.
- **Folds can be slow** (several model calls, plus web search). The server emits progress so clients
  that reset their timeout on progress stay alive. If your client has a fixed MCP tool timeout and
  cuts long folds off, raise it (Claude Code: set `MCP_TOOL_TIMEOUT`, e.g. `300000`).
- **Per-fold model.** Pass `model` / `provider` to spend more on hard questions (`claude-opus-4-8`) or
  less on light ones — set `fold_model` / `fold_provider` in `~/.convotree/config.json` for a default.
