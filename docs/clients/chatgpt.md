# ChatGPT

Status: BUILT, UNVERIFIED. From OpenAI's public developer docs, read 2026-11-05. Nobody has run these steps end to end. OpenAI's terms and help pages were not read, and nothing here rests on them.

Check your plan. This page makes no claim about what any plan allows.

## Get the URL

```
quadron-connect config chatgpt
```

This only prints. It writes nothing. Keep the `config` argument: the bare command runs install, which signs in and writes `~/.claude/settings.json`.

`config` is new. If your installed version reports an unknown command, run it from a clone of this repository: `node cli/bin/cli.js config chatgpt`. The same warning applies: without `config`, that command runs install.

With the connector URL the [repository README](../../README.md) names, the output is:

```
https://mcp.quadron.tech/mcp
```

The screen also shows a warning if your copy is pointed away from production. That is not part of the URL.

## Where the output goes

The output goes to the screen. ChatGPT has no file to edit, so you enter the URL in its interface. The [connect-to-ChatGPT docs](https://developers.openai.com/plugins/deploy/connect-chatgpt) currently show these steps:

1. Go to [ChatGPT Plugins](https://chatgpt.com/plugins).
2. Select the plus button, then **Add custom MCP server**.
3. Enter the URL, including the `/mcp` path.
4. Configure authentication, as described under Sign-in below.
5. Review the risk warning and select **I understand and want to continue**.
6. Select **Create as a plugin**. That is a step on ChatGPT's screen. Quadron ships no plugin package for ChatGPT.

How to add a custom MCP server on mobile is not stated on the pages read.

## Sign-in

Nobody has run this sign-in against Quadron. No bearer token is added by hand.

Quadron signs in with OAuth. The [authentication docs](https://developers.openai.com/apps-sdk/build/auth) currently describe an OAuth 2.1 authorization-code flow with PKCE. The [quickstart](https://developers.openai.com/plugins/quickstart) also shows a **No authentication** choice, which is not the one to use here.

Nothing is registered on the server side before you connect. The [plugin authentication docs](https://developers.openai.com/plugins/build/auth), read 2026-11-13, say dynamic client registration is supported, and Quadron accepts it, so ChatGPT registers itself when you add the server. The redirect URI ChatGPT shows on the server's management page is for your information only.

## Tool approval

The [Apps SDK changelog](https://developers.openai.com/apps-sdk/changelog), read 2026-11-13, says in its entry of 12 June 2026 that ChatGPT users can choose when connected apps ask for permission: always, before making changes, or only before important changes, with personal accounts setting global and per-app preferences and workspace admins setting defaults. Check that setting for the Quadron server before you rely on a prompt. Where it sits on the screen is not stated on the pages read.

## The session hook

The recall hook in [`cli/README.md`](../../cli/README.md) is Claude Code only. Quadron ships nothing for ChatGPT, and this page has no hook steps.

- **Web:** no equivalent on the pages read. The [plugin docs](https://learn.chatgpt.com/docs/plugins) currently say installing a plugin on the web doesn't deploy hook scripts.
- **Desktop:** the [plugin build docs](https://developers.openai.com/plugins/build/plugins) currently mention lifecycle hooks for plugins installed manually in Codex desktop. Quadron ships no such plugin.

## Behaviour guidance

Behaviour guidance reaches ChatGPT through the server's instructions. The [Apps SDK changelog](https://developers.openai.com/apps-sdk/changelog) entry of 26 May 2026, read 2026-11-13, says ChatGPT reads MCP server instructions returned during initialization, and the [MCP server docs](https://developers.openai.com/plugins/build/mcp-server) say to keep the most important details in the first 512 characters. How fully ChatGPT follows them is not confirmed.

## Disconnect

Remove the custom MCP server from the Plugins page. The [plugin docs](https://learn.chatgpt.com/docs/plugins), read 2026-11-05, say that uninstalling a plugin removes the plugin bundle and that separately connected MCP server integrations remain connected until you disconnect them there. Where the control for a custom server sits is not stated on the pages read.
