# Cursor

Status: BUILT, UNVERIFIED. From Cursor's public docs, read 2026-11-05. Nobody has run these steps end to end.

## Get the settings

```
quadron-connect config cursor
```

This only prints. It writes nothing. Keep the `config` argument: the bare command runs install, which signs in and writes `~/.claude/settings.json`.

`config` is new. If your installed version reports an unknown command, run it from a clone of this repository: `node cli/bin/cli.js config cursor`. The same warning applies: without `config`, that command runs install.

With the connector URL the [repository README](../../README.md) names, the settings are:

```json
{
  "mcpServers": {
    "quadron": {
      "url": "https://mcp.quadron.tech/mcp"
    }
  }
}
```

The screen also shows a `targets:` line, and a warning if your copy is pointed away from production. Neither is part of the settings.

## Where the output goes

The output goes to the screen. Merge it by hand. Never redirect it over an existing file, because that replaces the file.

- **Editor:** [Cursor's MCP docs](https://cursor.com/docs/mcp) currently show `~/.cursor/mcp.json` for tools available everywhere and `.cursor/mcp.json` for one project. If the file exists, add the `quadron` entry under `mcpServers`.
- **CLI:** the [CLI MCP docs](https://cursor.com/docs/cli/mcp) currently say it follows the same configuration precedence as the editor.
- **Cloud agents:** the [capabilities docs](https://cursor.com/docs/cloud-agent/capabilities) currently show no such file step. Personal servers go through the MCP dropdown in cursor.com/agents, and team admins use Dashboard -> Plugins & MCPs. Use the URL from the output.

## Sign-in

Nobody has run this sign-in against Quadron. No bearer token is added by hand.

- **Editor:** the [MCP docs](https://cursor.com/docs/mcp) currently say sign-in uses the authorization code flow with PKCE, and that with dynamic client registration Cursor registers as a public client with no client secret.
- **CLI:** the [CLI MCP docs](https://cursor.com/docs/cli/mcp) currently describe a login flow with automatic callback handling.
- **Cloud agents:** the [capabilities docs](https://cursor.com/docs/cloud-agent/capabilities) currently say OAuth is per user.

## The session hook

The recall hook in [`cli/README.md`](../../cli/README.md) is Claude Code only. Quadron ships nothing for Cursor's own events, and this page has no hook steps.

- **Editor:** the [hooks docs](https://cursor.com/docs/hooks) currently show a `sessionStart` event of Cursor's own.
- **CLI:** whether `sessionStart` runs there is not stated on the pages read.
- **Cloud agents:** no equivalent. The [hooks docs](https://cursor.com/docs/hooks) currently show no `sessionStart` there, apart from self-hosted workers.

## Behaviour guidance

Behaviour guidance reaches Cursor through the server's instructions, as far as Cursor uses them, which is not confirmed.
