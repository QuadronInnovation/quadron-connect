# quadron-connect

Connect AI clients to your Quadron record over the Quadron MCP connector (`https://mcp.quadron.tech/mcp`).

| Path | What it is |
|---|---|
| `plugins/claude-code/` | Claude Code plugin: a skill and three context-only hooks that say when to read your record and what may be written to it |
| `.claude-plugin/marketplace.json` | Marketplace manifest, so the plugin installs straight from this repository |
| `cli/` | `@quadron/connect`: signs a terminal in (device-code OAuth), registers the MCP server, installs the recall-at-session-start hook |
| `docs/clients/` | Install notes for ChatGPT, Cursor and Codex: recipes from vendor docs, not yet run end to end |

## Install the Claude Code plugin

```
claude plugin marketplace add QuadronInnovation/quadron-connect
claude plugin install quadron@quadron-marketplace
claude mcp add --transport http quadron --scope user https://mcp.quadron.tech/mcp
```

User scope matches `npx @quadron/connect`: the plugin's hooks run in every project, so the server is registered where they run.

Sign in through `/mcp` inside Claude Code. The hooks still add their reminders; with no `quad_*` tool the skill says Quadron is not connected.

## Rules for this repository

- No secrets, tokens or client credentials, ever. Sign-in is OAuth with dynamic client registration.
- Semantic version in `plugins/claude-code/.claude-plugin/plugin.json` and `cli/package.json`; tag each release on its merge commit (`plugin-vX.Y.Z`, `cli-vX.Y.Z`); see "Release" in `plugins/claude-code/README.md`.
- Changes to the MCP contract (tool names, capture rules) are reviewed with the MCP server owner before release.

Owner: Henry (@hndeau). The MCP server itself is not in this repository.
