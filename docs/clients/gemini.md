# Gemini

Status: BUILT, UNVERIFIED. From Google's public help and docs pages, read 2026-11-13. Nobody has run these steps end to end. Google's terms were not read, and nothing here rests on them.

Check your plan and account. The pages read name availability limits for the Gemini app, quoted below, and no plan for the others.

## Which Gemini

"Gemini" is several products, and they take a remote MCP server in different ways:

| Surface | Takes the connector URL | Where |
|---|---|---|
| The Gemini app at gemini.google.com | Yes, typed into the app | Settings, Connected Apps, Add a custom app |
| Antigravity (Google's agent IDE) | Yes, in a settings file | `~/.gemini/config/mcp_config.json` |
| Gemini CLI | Yes, in a settings file, but see the note | `~/.gemini/settings.json` |
| Gemini Enterprise | Only with a client id pre-registered by an administrator | Not covered here |

The [Gemini CLI transition post](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) on Google's developer blog, read 2026-11-13, says that on 18 June 2026 Gemini CLI stopped serving requests for Google AI Pro and Ultra subscribers and for free individual use, that access through paid Gemini Code Assist licences is unchanged, and that the CLI remains reachable with paid API keys. So for a personal Google account the terminal path is Antigravity, and the Gemini CLI section below is for organization licences.

## Get the URL or the settings

```
quadron-connect config gemini
quadron-connect config antigravity
```

Each only prints. It writes nothing. Keep the `config` argument: the bare command runs install, which signs in and writes `~/.claude/settings.json`.

These two clients are new. If your installed version reports an unknown client, run from a clone of this repository: `node cli/bin/cli.js config gemini`. The same warning applies: without `config`, that command runs install.

With the connector URL the [repository README](../../README.md) names, `config gemini` prints the URL to type into the Gemini app:

```
https://mcp.quadron.tech/mcp
```

and `config antigravity` prints the settings for Antigravity's file (the Gemini CLI form below is typed by hand):

```json
{
  "mcpServers": {
    "quadron": {
      "serverUrl": "https://mcp.quadron.tech/mcp"
    }
  }
}
```

The screen also shows a `targets:` line for Antigravity, and a warning if your copy is pointed away from production. Neither is part of the output.

## Where the URL goes

### The Gemini app

The [custom apps help page](https://support.google.com/gemini/answer/17209137), read 2026-11-13, currently shows these steps on a computer:

1. Go to gemini.google.com and sign in.
2. At the bottom, click Settings, then Connected Apps. If Connected Apps is not listed, click Personal Intelligence first.
3. Under Custom apps, click Add a custom app.
4. Enter the connector URL above as the app's MCP server URL.
5. Leave Advanced features closed. That section is for servers without dynamic client registration; Quadron registers the app itself (see Sign-in).

The same page states the requirements as of that date: "Be 18 or over and in the US.", "For now, this feature isn't available if you sign in with a work or school Google Account.", "Only available in English." and "Have Keep Activity on." It names no plan. If Settings shows no Custom apps section, one of those limits applies, not a Quadron fault.

How to add a custom app on the mobile apps is not stated on the page read.

### Antigravity

The [Antigravity MCP docs](https://antigravity.google/docs/mcp.md), read 2026-11-13, currently describe a global file at `~/.gemini/config/mcp_config.json` and say "Remote MCP servers must use the Streamable HTTP transport." The connector uses that transport. The entry is:

```json
{
  "mcpServers": {
    "quadron": {
      "serverUrl": "https://mcp.quadron.tech/mcp"
    }
  }
}
```

The docs say `url` also works for the endpoint key. Merge this into the file by hand. Never redirect anything over an existing file, because that replaces the file.

### Gemini CLI (organization licences)

The [Gemini CLI MCP docs](https://geminicli.com/docs/tools/mcp-server/), read 2026-11-13, put servers under `mcpServers` in `~/.gemini/settings.json`, with `httpUrl` for a Streamable HTTP endpoint (`url` there means SSE, which the connector does not serve):

```json
{
  "mcpServers": {
    "quadron": {
      "httpUrl": "https://mcp.quadron.tech/mcp"
    }
  }
}
```

The [Gemini Code Assist agent mode docs](https://docs.cloud.google.com/gemini/docs/codeassist/use-agentic-chat-pair-programmer), read 2026-11-13, point at the same file for the VS Code extension.

## Sign-in

Nobody has run this sign-in against Quadron. No bearer token or credentials are typed by hand.

Quadron signs in with OAuth and lets clients register themselves (dynamic client registration), so there is nothing to register on the server side before you connect. Each client's docs, read 2026-11-13, describe that path:

- The Gemini app's [help page](https://support.google.com/gemini/answer/17209137) says credentials are typed under Advanced features only "If the server doesn't support Dynamic Client Registration". Quadron does, so leave that section closed.
- The [Antigravity MCP docs](https://antigravity.google/docs/mcp.md) say the IDE "Registers a client dynamically if the authorization server metadata includes a `registration_endpoint`."
- The [Gemini CLI MCP docs](https://geminicli.com/docs/tools/mcp-server/) list `clientId` as optional with dynamic registration, show the redirect arriving on `http://localhost:<random-port>/oauth/callback`, and give `/mcp auth quadron` to start the sign-in.

Expect your browser to open on Quadron's sign-in page, then a consent screen, then a return to the client.

## Tool approval

- Gemini app: the help page says "Currently, Gemini requires manual confirmation for any write actions". Expect a prompt before any tool that saves to your record.
- Antigravity: the MCP docs say tools not configured otherwise run in Ask mode, "requiring your approval before execution."
- Gemini CLI: the MCP docs say every tool call is confirmed unless `trust` is set to `true` for the server; the prompt offers once, always allow, or cancel.

## The session hook

The recall hook in [`cli/README.md`](../../cli/README.md) is Claude Code only. Quadron ships nothing for Gemini's own events, and this page has no hook steps.

## Behaviour guidance

Behaviour guidance reaches a client through the server's instructions, as far as the client uses them. The Gemini CLI MCP docs say "Gemini CLI supports MCP server instructions, which will be appended to the system instructions." For the Gemini app and Antigravity this is not stated on the pages read, so whether they follow the capture rule is unknown until someone checks.

## Disconnect

Remove the entry from the settings file (Antigravity, Gemini CLI) or remove the custom app under Settings, Connected Apps (Gemini app). Where the app's remove control sits is not stated on the pages read.
