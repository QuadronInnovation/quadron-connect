# Codex

Status: BUILT, UNVERIFIED. From the Codex public docs, read 2026-11-05. Nobody has run these steps end to end.

## Get the settings

```
quadron-connect config codex
```

This only prints. It writes nothing. Keep the `config` argument: the bare command runs install, which signs in and writes `~/.claude/settings.json`.

`config` is new. If your installed version reports an unknown command, run it from a clone of this repository: `node cli/bin/cli.js config codex`. The same warning applies: without `config`, that command runs install.

With the connector URL the [repository README](../../README.md) names, the settings are:

```toml
[mcp_servers.quadron]
url = "https://mcp.quadron.tech/mcp"
```

The screen also shows a `targets:` line, and a warning if your copy is pointed away from production. Neither is part of the settings.

## Where the output goes

The output goes to the screen. Merge it by hand. Never redirect it over an existing file, because that replaces the file.

The [Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) currently show two places: `~/.codex/config.toml`, or `.codex/config.toml` in a trusted project. They say the ChatGPT desktop app, the Codex CLI and the IDE extension share this configuration. The [config reference](https://learn.chatgpt.com/docs/config-file/config-reference) lists `url` as the server's endpoint.

The same docs currently show `codex mcp add` only in its stdio form, so this page does not use it for a remote server. Remote MCP servers in Codex cloud are not stated on the pages read, and this page does not cover them.

## Sign-in

**Sign-in through URL-only discovery is unverified.** Nobody has run it against Quadron, and the pages read do not state how Codex finds the sign-in server from a URL alone.

The [Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) currently say Codex supports dynamic client registration, and show `codex mcp login <server-name>`. With the settings above, the name is `quadron`:

```
codex mcp login quadron
```

No bearer token or header is added by hand.

## The session hook

The recall hook in [`cli/README.md`](../../cli/README.md) is Claude Code only. Quadron ships nothing for Codex's own events, and this page has no hook steps.

- **CLI:** the [hooks docs](https://learn.chatgpt.com/docs/hooks) currently show a `SessionStart` event of Codex's own.
- **IDE extension and cloud:** not stated on the pages read.

## Behaviour guidance

Behaviour guidance reaches Codex through the server's instructions, as far as Codex uses them, which is not confirmed.
