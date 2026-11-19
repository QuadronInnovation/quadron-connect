# quadron-connect

Wire a terminal coding agent — Claude Code, and anything else that reads `~/.claude/settings.json` — to your Quadron record.

```bash
npx @quadron/connect              # sign in, register the MCP server, turn recall on
npx @quadron/connect status       # what is wired, and is the sign-in good
npx @quadron/connect uninstall    # remove exactly what was installed
```

## What this is not

**It is not the MCP server.** `mcp.quadron.tech` is a remote HTTP server; nothing is downloaded and nothing runs locally to serve it. You point a client at a URL.

This package is the glue that does the two things a URL cannot:

1. **registers** that URL with your agent, and
2. **installs the lifecycle hooks** your agent runs — the part MCP structurally cannot do, because an MCP server can only answer, never initiate.

## The two hooks

### Recall — `SessionStart`, on by default

A new session already knows your active projects. You did not ask for it; it is simply there, before your first prompt.

This is the half of the loop MCP cannot reach on its own. `quad_context` can answer *"what do I already think about pricing?"* — but only once you ask. A hook runs first.

The injected text is phrased as **statements of record**, never instructions. Text framed as an out-of-band command can trip the host's prompt-injection defences, which surfaces it to you instead of using it as context. Telling the model what to *do* is the MCP server's `instructions` field, which it already sends once at `initialize`.

### Capture — removed before merge

There is no capture hook, deliberately.

The first version posted `last_assistant_message` — **the model's words** — into the person's
record as though it were their own judgment. A terminal turn contains the assistant's output,
and writing that as the person's own decision is the wrong attribution no matter what provenance
level it carries.

Whose words a terminal turn contains is a design question and it needs answering before any
hook writes from that surface. Recall ships; capture waits.

## Sign-in

Device-code OAuth. A URL and a code; no browser callback, no localhost listener, no pasted token.

Auth-code + PKCE (what the browser extension uses) needs somewhere to receive a redirect. Binding a port for that prompts the macOS firewall, breaks over `ssh`, and fails in a container. Device code needs only outbound HTTPS — the one thing a terminal always has.

The client registers itself dynamically, so there is no client secret in this package and nothing to rotate.

Credentials live in `~/.quadron/credentials.json`, mode `0600`. **Never** in `settings.json` — the `/hooks` menu displays the full command of every registered hook, so anything on that command line is shoulder-surfable.

## Pointing it at a different Quadron

Set the endpoints when you install. `install` remembers them in `~/.quadron/config.json`, and the hook reads that file.

```
QUADRON_ISSUER=https://staging.app.quadron.tech/auth/realms/quadron \
QUADRON_API=https://staging.app.quadron.tech \
QUADRON_MCP_URL=https://staging.mcp.quadron.tech/mcp \
  quadron-connect install
```

Resolution is **env → `config.json` → production default**, so a one-off override needs no file edit.

The config file is what makes this work at all. The hook is run by your agent, in an environment where none of those variables are set — so with env alone, a connector installed against staging would go on recalling from production at every session start, silently.

Two consequences worth knowing:

- **`status` always names the environment.** Once it is remembered, a terminal can stay pointed somewhere non-production long after you have forgotten, so "linked" on its own would be the most misleading word on that screen.
- **A credential belongs to the environment that minted it.** Sign-ins and dynamic client registrations are stamped with their issuer and are never reused against a different one — you sign in again when you switch, rather than sending a staging credential to production. There is a single `~/.quadron`, so switching replaces the previous sign-in rather than keeping both.

## What it does to your settings

`~/.claude/settings.json` is your file. Other tools register hooks in it too. So:

- **Merges, never replaces.** Hook events hold an array of matcher groups and multiple groups per event are valid, so ours is appended as its own group. Your existing hooks are untouched.
- **Idempotent.** Re-running does not add a second copy.
- **Backed up** before the first write, timestamped.
- **Removable.** `uninstall` takes out exactly what `install` put in and nothing adjacent.
- **Refuses to touch a file it cannot parse.** If your settings are mid-edit and invalid, it tells you rather than rewriting them.

## When something is wrong

```bash
node cli/bin/cli.js status
```

Hooks **fail open** by design — a timeout, a non-zero exit, or a mistyped path are all non-blocking, and a JSON parse failure on exit 0 is invisible in the transcript. So silence does not prove success. Two places to look:

- `~/.quadron/hook.log` — every skipped or failed capture, with the reason
- `/hooks` inside your agent — confirms the hooks are registered at all

If they do not appear within a few seconds of installing, restart the session to force a config reload.

## Other clients

For ChatGPT, Cursor, Codex and Gemini, see [`docs/clients/`](../docs/clients/README.md). `quadron-connect config <cursor, codex, chatgpt, gemini or antigravity>` prints the connection settings and writes nothing. Those recipes come from vendor docs and nobody has run them end to end. Always include the `config` argument: without it the command runs install. Merge the output by hand; do not redirect it over an existing file.

## Requirements

Node 18 or newer (for global `fetch`). No dependencies.

## Tests

```bash
npm test        # node test/run.mjs
```

Weighted toward the thing that could damage a machine: the settings merger. Negative controls — clobbering an existing hook, losing idempotence, and injecting a directive into session context all fail the suite.

## MCP scope migration and memory boundaries

Older helper registrations did not request `quadron-mcp`. Run the explicit installer again to sign in with consent. It creates a scoped registration once and leaves old credentials intact until sign-in succeeds. An old or foreign-issuer credential is not silently refreshed into a new grant. This local registration state does not prove the server will accept a token: the server validates its signed audience and current OAuth session.

Quadron is separate from ChatGPT or Claude memory. This helper does not read or change those products' memory settings. The optional SessionStart hook reads Quadron context only; it does not capture conversations. Recall gives up silently within two seconds, including a stalled request. Explicit saves must name their destination. A pending Quadron review is not a completed save; check its native status before reporting retention.

Run `npm test` for settings/recall and scoped-registration migration controls. Real ChatGPT/Claude connector qualification is separate; this terminal helper is not their hosted OAuth client.
