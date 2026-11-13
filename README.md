# quadron-connect

Connect AI clients to your Quadron record over the Quadron MCP connector (`https://mcp.quadron.tech/mcp`).

| Path | What it is |
|---|---|
| `plugins/claude-code/` | Claude Code plugin: a skill that says when to read your record and what may be written to it |
| `.claude-plugin/marketplace.json` | Marketplace manifest, so the plugin installs straight from this repository |
| `cli/` | `@quadron/connect`: signs a terminal in (device-code OAuth), registers the MCP server, installs the recall-at-session-start hook |
| `docs/clients/` | Install notes for ChatGPT, Cursor, Codex and Gemini: recipes from vendor docs, not yet run end to end |

## Install the Claude Code plugin

```
claude plugin marketplace add QuadronInnovation/quadron-connect
claude plugin install quadron@quadron-marketplace
claude mcp add --transport http quadron https://mcp.quadron.tech/mcp
```

Sign in through `/mcp` inside Claude Code. The skill does nothing until a `quad_*` tool is present.

## Rules for this repository

- No secrets, tokens or client credentials, ever. Sign-in is OAuth with dynamic client registration.
- Semantic version in `plugins/claude-code/.claude-plugin/plugin.json` and `cli/package.json`; tag each release (`plugin-vX.Y.Z`, `cli-vX.Y.Z`).
- Changes to the MCP contract (tool names, capture rules) are reviewed with the server owner in `quadron-retail-backend` before release.

Owner: Henry (@hndeau). The MCP server itself lives in the private `quadron-retail-backend` repository (`mcp-server/`).
