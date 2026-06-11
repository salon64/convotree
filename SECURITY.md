# Security Policy

## Reporting a vulnerability

Please report security issues **privately** via
[GitHub Security Advisories](https://github.com/salon64/convotree/security/advisories/new).
Please don't open a public issue for a security report. We aim to acknowledge reports within
a few days.

## How convotree handles your API keys

- convotree is a **local** tool: no backend, no telemetry.
- API keys are read from `<PROVIDER>_API_KEY` environment variables, a local `.env`, or
  `~/.convotree/config.json`.
- `convotree config set-key` stores the key **in plaintext** in `~/.convotree/config.json`.
  On shared machines, prefer environment variables. On POSIX systems you can
  `chmod 600 ~/.convotree/config.json`.
- Keys are sent only to the provider endpoint you configure (Anthropic, OpenAI, or an
  OpenAI-compatible base URL) — nowhere else.
- The MCP server speaks JSON-RPC over **stdio only**; it opens no network port.

## Supported versions

convotree is pre-1.0; security fixes land on the latest `0.x` release.
