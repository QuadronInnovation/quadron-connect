# Quadron plugin for Claude Code

The behaviour half of the Quadron MCP connector for Claude Code: a skill that tells Claude
when to read the person's Quadron record and what it may write to it. The transport half
(registering the connector URL and signing in) stays with `claude mcp add` or
`npx @quadron/connect`; the recall-at-session-start hook lives in `cli/` of this repository.

## Layout

```
plugins/claude-code/
├── .claude-plugin/plugin.json   # name, version, description
├── skills/quadron/SKILL.md      # when to recall, what may be captured
└── README.md                    # this file
```

The repo root carries `.claude-plugin/marketplace.json` so the plugin can be installed from
this repository. The two files are independent: the marketplace manifest only points at
`plugins/claude-code` and can move without changing the plugin.

## Install

```
claude plugin marketplace add QuadronInnovation/quadron-connect
claude plugin install quadron@quadron-marketplace
```

Then connect the record (local scope keeps the registration inside one project directory):

```
claude mcp add --transport http quadron --scope local https://mcp.quadron.tech/mcp
```

Sign in through `/mcp` inside Claude Code. The skill does nothing until a `quad_*` tool is
present.

## What is deliberately not here

- No capture hook. A terminal turn contains the assistant's words; writing those into the
  person's record as their own judgment is the wrong attribution (see `cli/README.md`,
  "Capture — removed before merge"). Capture goes through the skill and `quad_commit`, which
  saves text the person approves.
- No bundled `.mcp.json`. Which URL a published plugin should carry (production
  `mcp.quadron.tech`) and whether the plugin or `quadron-connect` owns registration is an open
  decision for the MCP owner.
- No `remember`/`forget`-style tool names. The Quadron server exposes `quad_commit`,
  `quad_create`, `quad_context`, `quad_recall`, `quad_search` and `quad_read` to every client;
  the rest appear where the server turns them on.

## Verification still to run

Recorded here when done, with command, cwd, exit code and output. The checks run against the
staging connector with a personal sign-in; no credential is ever written into this repository.

| Id | Check | Result |
|----|-------|--------|
| T1 | `claude plugin validate ./plugins/claude-code` passes; `claude plugin install quadron@quadron-marketplace` from this repo succeeds and `/plugin` lists `quadron` | not run |
| T2 | With no `quad_*` tool present the skill makes no Quadron call | not run |
| T3 | With the connector attached and the quadron-connect hook installed, the skill does not repeat `quad_context` at session start | not run |
| T4 | A decision stated by the person is offered for capture with its project name, saved with `quad_commit`, and appears in the Inbox or project with the Claude Code client label | not run |
| T5 | Assistant-written text is never offered for capture | not run |
| T6 | "What do I already think about X" reads through `quad_context` or `quad_search` and cites the project | not run |

## Known follow-ups

- The Quadron connector page may add a line pointing at this plugin once it is installable; that copy is owned by the MCP server owner and changes with the server's install docs.
- Decided 2 Nov: the plugin and its marketplace manifest live in this public repository
  (`.claude-plugin/marketplace.json` at the root), separate from the private backend.
