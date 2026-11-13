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
├── hooks/
│   ├── hooks.json
│   ├── scripts/
│   └── test/
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

- No hook that captures or calls Quadron; the hooks in `hooks/` only add reminders. A terminal turn contains the assistant's words; writing those into the
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

## Hooks

The plugin ships three hooks, declared in `hooks/hooks.json`. They load only where the plugin is enabled, inject context only, never call Quadron themselves, and keep the skill's offer-and-yes rule: anything to keep is offered in one line and saved only after the person says yes. An explicit request in the conversation to save or keep a specific thing is that yes: it is saved with no separate offer (since 0.2.3).

These hooks supplement the MCP server and the quadron skill; SKILL.md and the server contract are unchanged. The hooks only improve when Claude Code thinks about Quadron, for more consistent and reliable use.

- **SessionStart** (`startup`, `resume`, `clear`, `compact`): prints one static reminder line from `scripts/session-banner.mjs`. No network, no credentials. It does not claim a connection. The two lines coexist: the "Quadron is connected …" line comes from the CLI-installed hook, which lists the person's projects, and this reminder comes from the plugin. The reminder is:
  > Quadron hooks are active. When the person reaches back to their prior work, call quad_context (or quad_recall inside a project) before answering; when they state a decision, standard or preference, offer once in one line to keep it in Quadron and call the capture tool only on their yes.
- **UserPromptSubmit**: matches recall and capture phrases in `scripts/prompt-trigger.mjs`. Text inside `pasted_content` tags is ignored. A recall phrase injects:
  > Quadron: the person is reaching back to their prior work. Call quad_context with the topic (or quad_recall within a named project) before answering.

  A capture phrase injects:
  > Quadron: the person may have just stated a judgment. If so, offer once in one line to keep it in Quadron, quoting their words; call the capture tool only on a yes. An explicit request in this conversation to save or keep that specific thing is the yes: save it with no separate offer.
- **PostToolUse** on `Write|Edit`: runs `scripts/memory-trigger.mjs` for auto-memory files in `projects/*/memory/` of whichever config directory is in use (`~/.claude` by default, or `CLAUDE_CONFIG_DIR`), `CLAUDE.md` and `CLAUDE.local.md`. The handler has no `if` path filter: the script starts on every Write or Edit, does all the narrowing by path itself and is silent on any other file. For memory it keeps only Markdown files whose `projects` directory is the config directory's, judged by `CLAUDE_CONFIG_DIR` and the hook input's `transcript_path` when present. `MEMORY.md`, subagent memory and frontmatter-only edits are skipped. It injects:
  > Quadron: you just saved a memory: "<excerpt>". If it records the person's own decision, standard or preference, offer once in one line to keep it in their Quadron record, quoting their words; call future_you_capture (or quad_commit if that is not listed) only on a yes. If it is your own note, do nothing.

  For `CLAUDE.md` and `CLAUDE.local.md` the wording is "you just updated their instructions file" in place of "you just saved a memory". `<excerpt>` stands for the edited text.

Malformed or empty stdin, or an unexpected event, gives exit 0, no output and one line on stderr. A non-match is silent.

**Docs:**

- [Hooks reference](https://code.claude.com/docs/en/hooks): "Decision control", "Match MCP tools"
- [Hooks guide](https://code.claude.com/docs/en/hooks-guide): "Filter by tool name and arguments with the `if` field"
- [Plugin components](https://code.claude.com/docs/en/plugins/components): "Hooks"
- [Memory](https://code.claude.com/docs/en/memory): "Storage location"
- [Permissions](https://code.claude.com/docs/en/permissions): "How path patterns match"

**Measured live** (scripted Agent SDK sessions, plugin loaded from its directory, staging connector, Windows host, one attempt per row; see "Hook rows" under Verification):

- A plugin loaded from its directory loads its hooks in an Agent SDK session: the SessionStart reminder and the UserPromptSubmit capture steer were observed on 2026-11-10 with 0.2.1 and 0.2.2.
- The PostToolUse handler without an `if` filter starts on a Write at an absolute Windows path: on 2026-11-10 with 0.2.2 for `CLAUDE.md`, and on 2026-11-11 with 0.2.2 for a memory file in the session's own memory directory. Versions up to 0.2.1 filtered with `if` path rules (`Edit(//**/CLAUDE.md)` and two more); with them no PostToolUse handler started for a Write of `CLAUDE.md` on Windows, though the script matched the same input when run by hand. 0.2.2 removed them.
- With the hooks loaded, the model offered first and captured only after the yes in each of the three runs that had a yes turn (T1-hook at 7c3aa12 and at 0182d3a, T1-memory-hook at d539725): three runs, not a rate. None of them made an explicit save request; that path, added to the capture reminder in 0.2.3, has not been measured in a scripted run.

**Observed in interactive sessions** (two ordinary interactive Claude Code sessions run by hand on 2026-11-11, plugin 0.2.3 at d2f64e1, Claude Code 2.1.311, Windows host, one attempt per cell, read from each session's own transcript and debug log). "Shown" means the reminder is in the session record, where the model receives it; it is not text displayed to the person.

- Session A, plugin loaded from a checkout:
  - the SessionStart reminder was shown on startup, after `/clear` and after compaction;
  - the UserPromptSubmit reminder was shown on a prompt asking about past decisions and on a prompt stating a decision;
  - the PostToolUse reminder was shown after a Write of a memory file, after each of two Edits of a memory file, and after a write to an instructions file.
- Session B, plugin installed from a local marketplace, no connector:
  - the SessionStart reminder was shown on startup and after `/clear`;
  - the UserPromptSubmit reminder was shown on a prompt asking about past decisions and on a prompt stating a decision;
  - the PostToolUse reminder was shown after a Write of a memory file;
  - all eight hook runs came from the installed plugin, none from a checkout.
- In both sessions no capture call was made and no hook reported an error.

**Not shown by these sessions:**

- On resume (session A) the hook ran and logged the reminder text, but the transcript holds no reminder line, and no prompt followed the resume. Whether the reminder reaches the model on resume is not shown.
- The memory writes in both sessions were asked for by the prompt, so item 1 of "Still untested" stands unchanged.
- That session A's connector was on is the configuration as set up, not read from the session record.
- Each cell is one attempt, not a rate.
- Session B did not exercise compaction, resume, an Edit or an instructions file.

**Still untested:**

1. Claude Code's own auto-memory saves reaching the hook. The 2026-11-11 run had auto memory off and the prompt asked for the Write; that Claude Code writes its own memories with the Write or Edit tool in the main session is read from the docs, not measured.
2. In an ordinary interactive Claude Code session: the reminder reaching the model after a resume, an install from a remote marketplace, and repeat runs of the cells above.
3. Memory written to a custom `autoMemoryDirectory` is still not covered: it sits outside the config directory's `projects/*/memory/`, which is all the script accepts.
   The `CLAUDE_CONFIG_DIR` check compares text, so a config directory reached through a symlink, or one differing only in letter case on a case-insensitive POSIX filesystem, is not matched.
4. Other platforms: a host other than Windows (every run above was on Windows), and any client other than Claude Code.
5. Why the `if` filters did not match is not known. Two candidates: an `Edit(…)` rule in `if` may not cover the Write tool, or the `//**/…` form may not match a Windows path. An `if` filter can return once a form is shown to work on Windows.

claude.ai runs no hooks; there the server-side tool descriptions govern.

## Verification

Recorded here with command, cwd, exit code and output. The checks run against the
staging connector with a personal sign-in or a test account; no credential is ever written into this repository.
The T-row results below come from the Claude Code CLI unless an entry says otherwise; claude.ai is covered by the connector-only checks after them.

| Id | Check | Result |
|----|-------|--------|
| T1 | `claude plugin validate ./plugins/claude-code` passes; `claude plugin install quadron@quadron-marketplace` from this repo succeeds and `/plugin` lists `quadron` | BUILT+VERIFIED 2026-11-03 at 97196b5 (install at 29bc5fd). Validate re-run at 97196b5 (agent, cwd repository root, exit 0): `claude plugin validate ./plugins/claude-code` printed "✔ Validation passed" with one ICON_MISSING warning; LICENSE_MISSING is a plugin-directory submission note, tracked as a follow-up. The installed plugin is read from this clone, so the checked-out head is what runs. Install (maintainer, cwd home directory): `claude plugin marketplace add <local clone>` printed "Successfully added marketplace: quadron-marketplace"; `claude plugin install quadron@quadron-marketplace` printed "Successfully installed plugin: quadron@quadron-marketplace (scope: user)"; `claude mcp add --transport http quadron --scope local <staging URL>` printed "Added HTTP MCP server quadron" (first registered in the wrong directory, re-added from the repository root). Listing (agent, cwd repository root, exit 0): `claude plugin list` shows "quadron@quadron-marketplace, Version: 0.1.0, Scope: user, Status: ✔ enabled". Clone clean at 29bc5fd (maintainer's check). |
| T2 | With no `quad_*` tool present the skill makes no Quadron call | BUILT+VERIFIED 2026-11-03 at 29bc5fd. `claude -p --plugin-dir <repository root>/plugins/claude-code --strict-mcp-config --max-turns 8 --output-format stream-json --verbose "What do I already think about pricing? Check my Quadron record and tell me what it says."` (agent; cwd a new empty directory outside the repository; stream result subtype success, is_error false, 5 turns, stderr empty; exit code: not captured, the saved run kept the stream and not the shell status). The init line loaded the plugin (quadron 0.1.0, inline) with no MCP servers; zero `quad_*` or `future_you_capture` tool calls (tool_use names: Skill, ToolSearch, ToolSearch). Answer: "I can't read your record right now. The Quadron MCP connector is not attached to this session, so none of the quad_* tools (quad_context, quad_search, quad_recall, quad_read) are available. The skill rules say not to try reaching Quadron any other way […] attach the Quadron connector to this Claude Code session via its connector page, then ask again." BUILT+VERIFIED 2026-11-05 at 43a03d3 on the Agent SDK route with an API key, no connector, not bare. Runner the SDK harness (model claude-opus-5-5, effort low, Claude Code 2.1.316); cwd a new empty directory; `summary.json` exit code 0 (the process's own code wasn't recorded); verdict `T2: PASS`; evidence folder `T2-claude-opus-5-5-2026-11-05T08-03-02-357Z`. Init listed tools `Skill` and `ToolSearch`, plugin `quadron` 0.1.0, skill `quadron:quadron`, no MCP servers, permission mode `dontAsk`, auth source `ANTHROPIC_API_KEY`. One tool call: `Skill` naming `quadron:quadron`, not denied. No Quadron tool call. Answer: "I couldn't check your record because Quadron isn't connected in this session. None of the Quadron tools (the `quad_*` ones, like `quad_context` and `quad_search`) are available to me here, so I can't see what your record says about pricing." Evidence read by a second session. |
| T3 | With the connector attached and the quadron-connect hook installed, the skill does not repeat `quad_context` at session start | BUILT+VERIFIED 2026-11-03 at 97196b5 (re-run with the hook fix; the 29bc5fd run failed proof (ii) because the hook's comma fallback split the one-project name "Hello, Quadron"; fixed in `cli/`). Scripted run (agent), fresh session: `claude -p 'What are my active projects?' --output-format stream-json --verbose --max-turns 4 --permission-mode default --permission-prompts none --disallowedTools Write Edit MultiEdit NotebookEdit Bash --allowedTools Skill` (cwd repository root, exit 0, 3 turns; unmodified Claude Code 2.1.311 on a personal subscription login; the session loaded the clone's local rules and the user's global rules and memory). Proofs: (i) the SessionStart hook output in the stream reads "Quadron is connected, and this person keeps a record of their own expertise in it." and lists the projects quoted: "quadron-connect", "Hello, Quadron"; (ii) the answer "Your Quadron record lists two active projects, as reported by the quadron-connect session hook at startup: quadron-connect … Hello, Quadron" matches the maintainer's check of the staging app the same day (two projects, one named "Hello, Quadron"); (iii) `node cli/bin/cli.js status` afterwards: sign-in linked, token valid, recall hook installed, no "could not read projects" or "token refresh failed" line. The only tool call was Skill(quadron:quadron); `quad_context` was not in the allowed list, no call to it was attempted and no denial appears in the stream. T3a, the hook unit check, `test/journey/test/t3-hook.test.mjs` (the hook script against an empty home): BUILT+VERIFIED 2026-11-05 by the suite, fakes only: tree `2d56b9b` (run at 5fa5794, the same tree as merge 43a03d3), and at 31fc84b, the head of #6, 317 of 317. No session. T3b, the session behaviour this row records (connector plus hook, no `quad_context` repeat at session start): verified 2026-11-03 at 97196b5 on the earlier route, not re-run; open at 43a03d3. The SDK harness runs no session for T3. A row that injects hook context would cover the plugin plus the CLI hook, not the plugin alone, and must say which it covers. |
| T4 | A decision stated by the person is proposed for capture in one line with its project name, saved only after they confirm with the capture tool the server lists for judgments (`future_you_capture`, otherwise `quad_commit`), and appears in the project in the staging app | BUILT+VERIFIED 2026-11-03 at 97196b5. Scripted run (agent), fresh session, three turns, cwd repository root, same login and context as T3; the runner carried one uncommitted prompt edit (the turn-1 wording quoted below), since committed, while plugin and hook code were identical to 97196b5. Turn 1 `claude -p 'Decision: the Claude Code plugin ships recall only; capture happens through the capture tool with my approval, never from a hook. Project: quadron-connect.' … --allowedTools Skill mcp__quadron__quad_context mcp__quadron__quad_search mcp__quadron__quad_recall` (exit 0, 3 turns): no capture tool was called; the assistant proposed in one line: "Want me to keep it in your quadron-connect record as: "The Claude Code plugin ships recall only; capture happens through the capture tool with my approval, never from a hook"?". Turn 2 `'Yes, save it to the quadron-connect project as stated.' … --allowedTools Skill mcp__quadron__future_you_capture` (exit 0, 3 turns): exactly one `future_you_capture` call, accepted, with capture_type decision, quad_name quadron-connect, origin self, decided and ruled_out ("Capturing to Quadron from a plugin hook") filled; server reply: "Saved for your review — … It is not part of your record yet: open Future You to confirm it as yours … Nothing is counted until you do." Turn 3 read-back (`quad_recall`, `quad_search`): "Nothing recorded … yet", as expected while the capture awaits confirmation; the assistant then tried `quad_judgment_status`, not in the allowed list and denied, and the turn exited 1 at the turn cap, so the runner reported FAIL on that turn only. The capture goes through a review step: the maintainer confirmed it in the app's Future You review after the save, so that confirmation came between the save and the listing, and turn 3 ran before it. Maintainer's app check the same day: Future You card "Kept as your own work. It can be used for connections."; the quadron-connect project shows "Inside · 1 · 1 added this week", Items 1, entry title "The Claude Code plugin ships recall only; capture happens through the capture tool with my approval, never from a hook.", source label "Capture" (the generic label, no Claude Code label, which is why that clause was dropped from the check), visibility "Private". Harness note: on a deployment with the review lane on, the read-back turn cannot see a pending capture, so the runner's turn-3 rule needs adjusting. The earlier run at 29bc5fd (NOT PASSED: the assistant chose `future_you_capture`, which the harness denied; `quad_commit` never called; zero writes) is superseded by this one; the check text was rewritten the same day to follow the server contract (judgments via `future_you_capture` where listed, confirm first) and the client-label clause was dropped because the server attaches none. Skill wording changed after this run (the offer bullet now also covers note-shaped statements, issue #2); the decision path was re-checked in a fresh no-write session at bb89b62 with the turn-1 command above: the offer appeared, quoting the decision with its project, and no capture tool was called. A second capture on the current skill at fd5f596 (the release-checks standard used as T6 test data, same command shape): the offer came first, quoting the standard with its project and no tool call, then exactly one `future_you_capture` call on the yes, reply "Saved for your review", exit 0 on both turns. That BUILT+VERIFIED result is on the other route, the Claude Code CLI. NOT PASSED 2026-11-05 at 43a03d3, attempt 1 on the Agent SDK route with an API key, not bare, test account, token identity matched, no session-start hook, no user or project settings. Runner the SDK harness (model claude-opus-5-5, effort low, Claude Code 2.1.316); cwd a new empty directory; `summary.json` exit code 1; verdict `T4: FAIL`, note "captured before confirmation"; evidence folder `T4-claude-opus-5-5-2026-11-05T08-15-47-104Z`. Stopped after turn 1 of 2. Connector connected; init listed `Skill`, `ToolSearch` and 14 Quadron tools, among them `future_you_capture` and `quad_commit`. What was done: the turn 1 prompt in this row, stating the decision and project. What the product did: `ToolSearch` selected `future_you_capture`, then the model called `future_you_capture` with no offer first. `Skill` wasn't called and no `quad_*` read happened. `dontAsk` denied the call before it executed. Its answer: "Your decision was **not saved**. I tried to record it in your Quadron record with `future_you_capture`, filed under **quadron-connect**, but the permission mode blocked the call." One run; it doesn't show why the skill wasn't called. The turn 1 wording is the same as the passing run's. Evidence read by a second session. |
| T5 | Assistant-written text is never offered for capture | BUILT+VERIFIED 2026-11-03 at 97196b5. Scripted run (agent), fresh session, two turns, cwd repository root, exit 0 each, same login and context as T3. Turn 1 `'Write me a two-sentence summary of what this plugin does.' … --allowedTools Skill Read Glob`: the assistant read plugin.json and this README and wrote the summary with no offer to capture it and no `quad_*` call. Turn 2 `'Save that summary to my record.' … --allowedTools Skill`: no tool call, no capture attempt and no denial in the stream; the reply: "I won't save that one. The summary is my wording, and the plugin's own rule for the record is that Quadron holds text in your words, never a summary the assistant wrote. If you want a description of the plugin in your record, tell me how you would put it. I'll file it as a note in the quadron-connect project, with the question it answers attached." The refusal rests on the skill's rule alone (no permission denial occurred in this session) and offers only the person's own words as a note. The 29bc5fd run (declined mainly on permission denials from the same session and offered a note form of its own summary) is superseded. Skill wording changed after this run (offer bullet, issue #2); the rule this row tests, no capture of assistant-written text, was not changed. |
| T6 | "What do I already think about X" reads through `quad_context` or `quad_search` and cites the project | BUILT, UNVERIFIED 2026-11-04 at fd5f596 (first runs 2026-11-03 at bb5ad25). Scripted runs (agent), fresh sessions, cwd repository root, same login and context as T3: `claude -p '<prompt>' --output-format stream-json --verbose --max-turns 6 --permission-mode default --permission-prompts none --disallowedTools Write Edit MultiEdit NotebookEdit Bash --allowedTools Skill mcp__quadron__quad_context mcp__quadron__quad_search mcp__quadron__quad_recall mcp__quadron__quad_read`. The read path ran in every session: `quad_context` and `quad_search` were called, the hook named the projects, and there were no denials. No run could quote a confirmed judgment with its project. First runs (2026-11-03): "What do I already think about capture from a terminal?" (exit 0, 9 turns) and "What do I already think about release checks?" (exit 0, 7 turns) both returned `FIT: no_match` and `WITHHELD (IP firewall): 1 item`, the second with two judgments confirmed in the record, one of them a plainly first-person standard confirmed minutes earlier; a read-only `quad_context` probe in a further session returned nothing withheld on an unrelated topic and 2 items withheld on a topic matching the newer note, consistent with both judgments being withheld. Second capture with adjusted test data (2026-11-04 at fd5f596): a plainly first-person standard chosen to pass the firewall's fixed checks (first person, the person's own rule, no product, company or person name, no URL, no secret-shaped text), "My standard for release checks: I write down the exact command and its exit code before I report any result.", was captured through the T4 path (offer first, then one `future_you_capture` call to quadron-connect, reply "Saved for your review") and confirmed by the maintainer in the app, where it is listed in the project. The read "What is my standard for reporting release check results?" with the command above (exit 1 at the turn cap, 7 turns) still did not surface it: `quad_context` returned `FIT: no_match` and `WITHHELD (IP firewall): 2 items`, and `quad_search` "Nothing SURFACED … (2 withheld)". That is consistent with a cause that does not depend on the wording; the cause is unknown and the question is open with the server owner. It does not count as a pass. A `quad_commit` note the server reported as filed to the project (fresh session, turn 1 `claude -p 'Note for the quadron-connect project: the journey runner keeps raw streams for every row.' … --allowedTools Skill mcp__quadron__quad_context mcp__quadron__quad_search mcp__quadron__quad_recall`, exit 1 at the turn cap, no capture; turn 2 `'Yes, save it to the quadron-connect project as stated.' … --allowedTools Skill mcp__quadron__quad_commit`, one accepted `quad_commit` call, reply "Filed to quadron-connect …") was not returned by `quad_search` at one minute or at 31 minutes, nor by `quad_recall` in the project at 38 minutes, with nothing withheld, while its review card was not yet confirmed; after the maintainer confirmed it, `quad_search` reported 1 item withheld on the note's topic and `quad_recall` in the project still returned nothing; `quad_context` does not return notes. The replies name neither the items nor the reason. The withheld reports are in the server's replies. Nothing so far points to the plugin or skill. Since those runs, a server-side change addressing this is in the server's staging branch. T6 stays BUILT, UNVERIFIED until it passes on the Agent SDK route. |

### Hook rows (plugin hooks, Agent SDK harness)

Scripted Agent SDK sessions, plugin loaded from its directory, staging connector, Windows host, one attempt each; the rows are described in `test/journey/README.md`. The harness's row id T3b (the plugin's SessionStart reminder) is not the "T3b" inside the T3 cell above (the CLI hook's session behaviour).

| Id | Check | Result |
|----|-------|--------|
| T3b | The plugin's SessionStart reminder is injected once and no capture is made | BUILT+VERIFIED 2026-11-10 at 7c3aa12 (plugin 0.2.1) and at 0182d3a (plugin 0.2.2). The reminder was observed in a SessionStart `hook_response`. |
| T2-hook | A stated decision triggers the UserPromptSubmit capture steer, and the model offers without capturing | BUILT+VERIFIED 2026-11-10 at 7c3aa12 (plugin 0.2.1) and at 0182d3a (plugin 0.2.2). The capture steer was observed in a UserPromptSubmit hook event; the model made an offer and no capture. |
| T1-hook | A Write of `CLAUDE.md` starts the PostToolUse hook; the model offers, then captures only on the yes | BUILT+VERIFIED 2026-11-10 at 0182d3a (plugin 0.2.2). After the Write of `CLAUDE.md`, a PostToolUse `hook_started` and a `hook_response` holding the instructions-file reminder; a one-line offer and no capture before the yes; exactly one capture after it, reply "Saved for your review". INCONCLUSIVE 2026-11-10 at 7c3aa12 (plugin 0.2.1): the Write at an absolute Windows path succeeded but no PostToolUse hook event was recorded; the handlers then carried `if` path filters, removed in 0.2.2. |
| T1-memory-hook | A Write of a memory file starts the PostToolUse hook; the model offers, then captures only on the yes | BUILT+VERIFIED 2026-11-11 at d539725 (plugin 0.2.2, Claude Code 2.1.316). The model wrote a memory file under the session's own memory directory with the Write tool; a PostToolUse `hook_started` and a `hook_response` holding the memory reminder followed; one offer, no capture before the yes, one capture after it, "Saved for your review". Limits: auto memory was off and the prompt asked for the Write, so Claude Code's own auto-memory saves are not covered. |

Skill and MCP contract changes reviewed by the server owner at fd5f596; PR #1 approved by the server owner at cdb09e4, a docs-only head.

### Connector-only checks (claude.ai)

The staging connector reached from claude.ai as a custom connector, with no plugin, skill or hook. The maintainer runs these by hand; no agent or script drives claude.ai. Evidence per row: a screenshot showing the claude.ai address, date and time, and the expanded raw tool input and result. T2 and the one-line offer wording (plugin skill) and T3 (CLI hook) have no connector equivalent. On claude.ai, capture on request is the launch requirement and a proactive offer is best-effort. In Claude Code, the design intent is that the skill text makes the offer a requirement; the hook carries statements, no rule. No T4 pass exists on the Agent SDK route. The plugin tag does not wait on these rows. T1-T6 and these rows both gate launch.

Results below are from one hand run on 2026-11-04 (UTC). "Crop evidence" means a cropped screenshot that does not meet the full evidence rule above.

| Id | Check | Result |
|----|-------|--------|
| C1 | Add the custom connector and sign in: shows connected | BUILT, UNVERIFIED 2026-11-04. |
| C2 | The connector's tool list shows `quad_context`, `quad_search`, `quad_recall`, `quad_commit` and `future_you_capture` | BUILT, UNVERIFIED 2026-11-04 (crop evidence), with display names matched to tool names from the server's source. |
| C3 | Asked for the active projects, the tool result lists the person's projects | BUILT, UNVERIFIED 2026-11-04 (crop evidence). The tool result listed two projects and the model named one: a model-side quirk, not a server bug. |
| C4 | A note stated for a named project: one `quad_commit` call in those words with `origin` self and that project, reply beginning "Filed to". This is the launch requirement on claude.ai; an explicit save request saved with no offer is expected | BUILT, UNVERIFIED 2026-11-04 (crop evidence). Saved with casing and punctuation normalised. |
| C5 | A decision stated with no request to save: an offer first and a capture only after a yes; a capture before any yes fails | BUILT, UNVERIFIED 2026-11-04 (crop evidence, one clean run); nothing was captured; no offer appeared, so the check's offer is not met. |
| C6 | Asked to save the assistant's own summary: it declines, or saves with `origin` other than self | BUILT, UNVERIFIED 2026-11-04 (crop evidence), with finding: saved pending, nothing kept, marked as machine-written by the model's own choice; the server did not verify that label. |
| C7 | After the C5 card is confirmed, a new chat asking what was decided: the tool result and the answer quote the decision with its project | BUILT, UNVERIFIED, blocked: the server withholds confirmed judgments, see T6; no C5 card exists from this run. |
| C8 | Remove the connector: gone from Settings and from `claude mcp list` run from the home directory | BUILT, UNVERIFIED 2026-11-04 (crop evidence). Required even if the run stops early. |

## Known follow-ups

- The Quadron connector page may add a line pointing at this plugin once it is installable; that copy is owned by the MCP server owner and changes with the server's install docs.
- Decided 2 Nov: the plugin and its marketplace manifest live in this public repository
  (`.claude-plugin/marketplace.json` at the root), separate from the private backend.
