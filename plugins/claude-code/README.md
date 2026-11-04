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
  "Capture — removed before merge"). Capture goes through the skill: a judgment the person
  states goes to `future_you_capture` where the server lists it, other material to
  `quad_commit`, both with text the person approves.
- No bundled `.mcp.json`. Which URL a published plugin should carry (production
  `mcp.quadron.tech`) and whether the plugin or `quadron-connect` owns registration is an open
  decision for the MCP owner.
- No `remember`/`forget`-style tool names. The Quadron server exposes `quad_commit`,
  `quad_create`, `quad_context`, `quad_recall`, `quad_search` and `quad_read` to every client;
  the rest appear where the server turns them on.

## Verification

Recorded here with command, cwd, exit code and output. The checks run against the
staging connector with a personal sign-in; no credential is ever written into this repository.
All results below come from the Claude Code CLI; claude.ai was not checked on this build.

| Id | Check | Result |
|----|-------|--------|
| T1 | `claude plugin validate ./plugins/claude-code` passes; `claude plugin install quadron@quadron-marketplace` from this repo succeeds and `/plugin` lists `quadron` | BUILT+VERIFIED 2026-11-03 at 97196b5 (install at 29bc5fd). Validate re-run at 97196b5 (agent, cwd repository root, exit 0): `claude plugin validate ./plugins/claude-code` printed "✔ Validation passed" with one ICON_MISSING warning; LICENSE_MISSING is a plugin-directory submission note, tracked as a follow-up. The installed plugin is read from this clone, so the checked-out head is what runs. Install (maintainer, cwd home directory): `claude plugin marketplace add <local clone>` printed "Successfully added marketplace: quadron-marketplace"; `claude plugin install quadron@quadron-marketplace` printed "Successfully installed plugin: quadron@quadron-marketplace (scope: user)"; `claude mcp add --transport http quadron --scope local <staging URL>` printed "Added HTTP MCP server quadron" (first registered in the wrong directory, re-added from the repository root). Listing (agent, cwd repository root, exit 0): `claude plugin list` shows "quadron@quadron-marketplace, Version: 0.1.0, Scope: user, Status: ✔ enabled". Clone clean at 29bc5fd (maintainer's check). |
| T2 | With no `quad_*` tool present the skill makes no Quadron call | BUILT+VERIFIED 2026-11-03 at 29bc5fd. `claude -p --plugin-dir <repository root>/plugins/claude-code --strict-mcp-config --max-turns 8 --output-format stream-json --verbose "What do I already think about pricing? Check my Quadron record and tell me what it says."` (agent; cwd a new empty directory outside the repository; stream result subtype success, is_error false, 5 turns, stderr empty; exit code: not captured, the saved run kept the stream and not the shell status). The init line loaded the plugin (quadron 0.1.0, inline) with no MCP servers; zero `quad_*` or `future_you_capture` tool calls (tool_use names: Skill, ToolSearch, ToolSearch). Answer: "I can't read your record right now. The Quadron MCP connector is not attached to this session, so none of the quad_* tools (quad_context, quad_search, quad_recall, quad_read) are available. The skill rules say not to try reaching Quadron any other way […] attach the Quadron connector to this Claude Code session via its connector page, then ask again." |
| T3 | With the connector attached and the quadron-connect hook installed, the skill does not repeat `quad_context` at session start | BUILT+VERIFIED 2026-11-03 at 97196b5 (re-run with the hook fix; the 29bc5fd run failed proof (ii) because the hook's comma fallback split the one-project name "Hello, Quadron"; fixed in `cli/`). Scripted run (agent), fresh session: `claude -p 'What are my active projects?' --output-format stream-json --verbose --max-turns 4 --permission-mode default --permission-prompts none --disallowedTools Write Edit MultiEdit NotebookEdit Bash --allowedTools Skill` (cwd repository root, exit 0, 3 turns; unmodified Claude Code 2.1.311 on a personal subscription login; the session loaded the clone's local rules and the user's global rules and memory). Proofs: (i) the SessionStart hook output in the stream reads "Quadron is connected, and this person keeps a record of their own expertise in it." and lists the projects quoted: "quadron-connect", "Hello, Quadron"; (ii) the answer "Your Quadron record lists two active projects, as reported by the quadron-connect session hook at startup: quadron-connect … Hello, Quadron" matches the maintainer's check of the staging app the same day (two projects, one named "Hello, Quadron"); (iii) `node cli/bin/cli.js status` afterwards: sign-in linked, token valid, recall hook installed, no "could not read projects" or "token refresh failed" line. The only tool call was Skill(quadron:quadron); `quad_context` was not in the allowed list, no call to it was attempted and no denial appears in the stream. |
| T4 | A decision stated by the person is proposed for capture in one line with its project name, saved only after they confirm with the capture tool the server lists for judgments (`future_you_capture`, otherwise `quad_commit`), and appears in the project in the staging app | BUILT+VERIFIED 2026-11-03 at 97196b5. Scripted run (agent), fresh session, three turns, cwd repository root, same login and context as T3; the runner carried one uncommitted prompt edit (the turn-1 wording quoted below), since committed, while plugin and hook code were identical to 97196b5. Turn 1 `claude -p 'Decision: the Claude Code plugin ships recall only; capture happens through the capture tool with my approval, never from a hook. Project: quadron-connect.' … --allowedTools Skill mcp__quadron__quad_context mcp__quadron__quad_search mcp__quadron__quad_recall` (exit 0, 3 turns): no capture tool was called; the assistant proposed in one line: "Want me to keep it in your quadron-connect record as: "The Claude Code plugin ships recall only; capture happens through the capture tool with my approval, never from a hook"?". Turn 2 `'Yes, save it to the quadron-connect project as stated.' … --allowedTools Skill mcp__quadron__future_you_capture` (exit 0, 3 turns): exactly one `future_you_capture` call, accepted, with capture_type decision, quad_name quadron-connect, origin self, decided and ruled_out ("Capturing to Quadron from a plugin hook") filled; server reply: "Saved for your review — … It is not part of your record yet: open Future You to confirm it as yours … Nothing is counted until you do." Turn 3 read-back (`quad_recall`, `quad_search`): "Nothing recorded … yet", as expected while the capture awaits confirmation; the assistant then tried `quad_judgment_status`, not in the allowed list and denied, and the turn exited 1 at the turn cap, so the runner reported FAIL on that turn only. The capture goes through a review step: the maintainer confirmed it in the app's Future You review after the save, so that confirmation came between the save and the listing, and turn 3 ran before it. Maintainer's app check the same day: Future You card "Kept as your own work. It can be used for connections."; the quadron-connect project shows "Inside · 1 · 1 added this week", Items 1, entry title "The Claude Code plugin ships recall only; capture happens through the capture tool with my approval, never from a hook.", source label "Capture" (the generic label, no Claude Code label, which is why that clause was dropped from the check), visibility "Private". Harness note: on a deployment with the review lane on, the read-back turn cannot see a pending capture, so the runner's turn-3 rule needs adjusting. The earlier run at 29bc5fd (NOT PASSED: the assistant chose `future_you_capture`, which the harness denied; `quad_commit` never called; zero writes) is superseded by this one; the check text was rewritten the same day to follow the server contract (judgments via `future_you_capture` where listed, confirm first) and the client-label clause was dropped because the server attaches none. Skill wording changed after this run (the offer bullet now also covers note-shaped statements, issue #2); the decision path was re-checked in a fresh no-write session at bb89b62 with the turn-1 command above: the offer appeared, quoting the decision with its project, and no capture tool was called. |
| T5 | Assistant-written text is never offered for capture | BUILT+VERIFIED 2026-11-03 at 97196b5. Scripted run (agent), fresh session, two turns, cwd repository root, exit 0 each, same login and context as T3. Turn 1 `'Write me a two-sentence summary of what this plugin does.' … --allowedTools Skill Read Glob`: the assistant read plugin.json and this README and wrote the summary with no offer to capture it and no `quad_*` call. Turn 2 `'Save that summary to my record.' … --allowedTools Skill`: no tool call, no capture attempt and no denial in the stream; the reply: "I won't save that one. The summary is my wording, and the plugin's own rule for the record is that Quadron holds text in your words, never a summary the assistant wrote. If you want a description of the plugin in your record, tell me how you would put it. I'll file it as a note in the quadron-connect project, with the question it answers attached." The refusal rests on the skill's rule alone (no permission denial occurred in this session) and offers only the person's own words as a note. The 29bc5fd run (declined mainly on permission denials from the same session and offered a note form of its own summary) is superseded. Skill wording changed after this run (offer bullet, issue #2); the rule this row tests, no capture of assistant-written text, was not changed. |
| T6 | "What do I already think about X" reads through `quad_context` or `quad_search` and cites the project | BUILT, UNVERIFIED 2026-11-03 at bb5ad25. Scripted runs (agent), fresh sessions, cwd repository root, exit 0, same login and context as T3: `claude -p '<prompt>' --output-format stream-json --verbose --max-turns 6 --permission-mode default --permission-prompts none --disallowedTools Write Edit MultiEdit NotebookEdit Bash --allowedTools Skill mcp__quadron__quad_context mcp__quadron__quad_search mcp__quadron__quad_recall mcp__quadron__quad_read`, first with the prompt "What do I already think about capture from a terminal?" (9 turns), then "What do I already think about release checks?" (7 turns). The read path ran: `quad_context` and `quad_search` were called, the hook named the projects, and there were no denials. Neither run could quote a confirmed decision with its project. Both returned `FIT: no_match` and `WITHHELD (IP firewall): 1 item`, the second with two decisions confirmed in the record, one of them a plainly first-person standard confirmed minutes earlier. A read-only `quad_context` probe in one further session returned nothing withheld on an unrelated topic and 2 items withheld on a topic matching the newer note, which is consistent with both decisions being withheld. A `quad_commit` note the server reported as filed to the project was not returned by `quad_context` or `quad_search` at one minute or at 31 minutes, nor by `quad_recall` in the project at 38 minutes, with nothing withheld (write: fresh session, turn 1 `claude -p 'Note for the quadron-connect project: the journey runner keeps raw streams for every row.' … --allowedTools Skill mcp__quadron__quad_context mcp__quadron__quad_search mcp__quadron__quad_recall` (exit 1 at the turn cap, no capture), turn 2 `'Yes, save it to the quadron-connect project as stated.' … --allowedTools Skill mcp__quadron__quad_commit`, one accepted `quad_commit` call, server reply "Filed to quadron-connect … Hash: …"; reads: two fresh sessions with the T6 command above and the prompt "What do I already think about the journey runner's raw streams?", exit 0 at one minute, exit 1 at the turn cap at 31 minutes, both `FIT: no_match` and `WITHHELD (IP firewall): nothing withheld`). The reply does not name the items or the reason, so the cause is unresolved. The withholding comes from the server's response, not from the plugin or skill; it needs the server owner's check. |

## Known follow-ups

- The Quadron connector page may add a line pointing at this plugin once it is installable; that copy is owned by the MCP server owner and changes with the server's install docs.
- Decided 2 Nov: the plugin and its marketplace manifest live in this public repository
  (`.claude-plugin/marketplace.json` at the root), separate from the private backend.
