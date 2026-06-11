# Contributing to convotree

Thanks for your interest! convotree is an early (v0.x) project — issues, ideas, and PRs are
all welcome.

## Development setup

Requires **Node ≥ 22** and **pnpm**.

```bash
pnpm install
pnpm run build      # tsc -> dist/
```

## Tests

```bash
pnpm test:lib       # library + provider-plugin smoke test — no API key needed (mock provider)
pnpm test:mcp       # boots the MCP server, checks tool registration — no API key needed
pnpm test:phase0    # end-to-end against a real model — needs an API key (ANTHROPIC_API_KEY)
```

CI runs `build`, `test:lib`, and `test:mcp` on Linux / macOS / Windows; please make sure
those pass locally before opening a PR.

## Pull requests

- Branch off `main`, keep the change focused, and describe **what** and **why**.
- Match the surrounding code style (TypeScript, ES modules, 2-space indent).
- Adding a provider is a single line: `registerProvider(name, factory)` — no core edits
  needed (see `src/llm/client.ts`).
- No secrets in commits. `.env` and `private/` are gitignored for a reason.
