# Eval suite for the Quadron plugin

Cases for `claude plugin eval`, which "loads the target plugin's skills, hooks, and agents and
runs its eval suite on your machine, as you" (Q10). They check routing and reminders only:
whether the `quadron` skill loads on natural phrasing, whether it stays unused on unrelated
requests, and whether the hooks' reminder lines reach the session.

**This suite has never been run.** It was authored without running it, and every fact in it
about the eval format rests on the public page https://code.claude.com/docs/en/plugin-evals,
quoted under "Sources" below. Where that page does not settle a point, this README says "not
determinable from the docs". No case has a measured result, pass rate or cost yet.

## Run it

`claude plugin eval` runs the suite (Q10). Its arguments and options (how to name the plugin,
set three runs per case, or cap the cost) and where it writes results are not determinable from
the docs as quoted here; read the page before the first run. `.gitignore` keeps
`plugins/claude-code/evals/results/` out of git in case results land there; confirm the path on
the first run.

## Cost

- Agent runs: 9 cases x 3 runs with the plugin, and the same number again for the no-plugin
  baseline (Q7) = 54 agent runs, each capped at 10 turns (`max_turns: 10`, the documented
  default, Q8).
- Judge calls: three per `llm` grader per run (Q7). There are 2 `llm` graders
  (`capture-remember-this/asks-or-says-not-connected`, `capture-explicit-save/honest-no-save`),
  so 2 x 3 x 3 = 18 judge calls if only the with-plugin arm is judged, up to 36 if both arms
  are. It is not determinable from the docs which applies. Whether an `arm: both` grader in the
  same case changes how many judge calls the without-plugin arm makes is also not determinable
  from the docs.
- Every other grader is `tool_used` or `regex`; Q7 counts judge calls only for `llm` and
  `baseline` graders.
- No dollar figure: none has been measured.

## Cases

Each case is a directory with a `prompt.md` and a `graders/` directory. A grader's name is its
filename without `.md` (Q1).

| Case | Checks | Graders |
|---|---|---|
| `recall-what-did-i-decide` | "what did I decide" loads a skill; recall reminder present, capture reminder absent | `skill-fired`, `recall-reminder`, `no-capture-reminder` |
| `recall-names-quadron` | naming Quadron with no hook phrase loads a skill from its description; no reminder | `skill-fired`, `no-recall-reminder`, `no-capture-reminder` |
| `capture-remember-this` | bare "remember this" loads a skill and gets the capture reminder; asks in plain text; claims no save | `skill-fired`, `capture-reminder`, `no-ask-tool`, `no-save-claim`, `asks-or-says-not-connected` (llm) |
| `capture-explicit-save` | "save this to my Quadron record" loads a skill and gets the capture reminder; claims no save | `skill-fired`, `capture-reminder`, `no-save-claim`, `honest-no-save` (llm) |
| `capture-stated-decision` | a decision stated as "we'll go with" loads a skill and gets the capture reminder; claims no save | `skill-fired`, `capture-reminder`, `no-ask-tool`, `no-save-claim` |
| `quiet-coding-task` | a coding request calls no skill and gets no prompt reminder; SessionStart reminder present | `skill-not-fired`, `session-banner`, `no-recall-reminder`, `no-capture-reminder` |
| `quiet-decision-records` | a general question about team decision records calls no skill | `skill-not-fired`, `no-recall-reminder`, `no-capture-reminder` |
| `quiet-git-keep-changes` | near-miss wording ("remind me", "keep the changes") calls no skill and gets no reminder | `skill-not-fired`, `no-recall-reminder`, `no-capture-reminder` |
| `quiet-mcp-explainer` | a general MCP question calls no skill | `skill-not-fired`, `no-recall-reminder`, `no-capture-reminder` |

Case conventions:

- Every `prompt.md` sets only `max_turns: 10` (the default, stated explicitly) and
  `allowed_tools` (Q8). Every case lists `Skill`
  (Q8, Q9), so the Skill tool is available because the docs say listed read-only tools are
  granted, not by assumption. `capture-remember-this` and `capture-stated-decision` also list
  `AskUserQuestion` (Q9), so that `no-ask-tool` checks a call that could happen.
- What each case checks is in the table above; no other frontmatter fields are set, since no
  others are determinable from the docs.

Grader conventions:

- `skill-fired`: `tool_used` on `Skill`, `min: 1` (Q12 names `min` and `max`). Which skill was
  called is not checked: no key for matching a tool's input is determinable from the docs. In a
  two-arm run the docs report every `tool_used` grader whose `tool` is `Skill` with
  `scored: false` and leave it out of the score in both arms (Q4), so read this row in the
  report, not the score.
- `skill-not-fired`: `tool_used` on `Skill`, `min: 0`, `max: 0` (Q12), `arm: both` (Q5), so it is
  scored in both arms. It forbids any Skill call, not only `quadron`.
- `no-ask-tool`: `tool_used` on `AskUserQuestion`, `min: 0`, `max: 0` (Q12).
- Reminder graders (all rest on the unverified assumption that hook output appears in the
  trace; see "Assumptions not yet checked by a run"): `regex` (Q11) on `target: trace` (Q13)
  for the start of each hook line, which
  holds no quotes, since quotes inside the trace are JSON-escaped (Q13). `match: not_contains`
  (Q11) where the line must be absent; where it must be present the default applies (the pattern
  "is found in the target", Q11). The patterns are the start of the texts in
  `hooks/scripts/session-banner.mjs` and `hooks/scripts/prompt-trigger.mjs`; change them with
  those scripts. Which prompts trigger which reminder was checked against `classifyPrompt` in
  `prompt-trigger.mjs`.
- `no-save-claim`: `regex` on `target: last_message` (Q3), `match: not_contains` (Q11),
  `arm: both` (Q5), for affirmative save wording ("saved it to your Quadron record", "Quadron
  received it"); a lookbehind excludes negated forms ("Nothing was saved to Quadron", "I haven't
  saved it to your record"). The pattern is a JavaScript regex (Q11); capital letters are spelled
  out as character classes because no regex-flags key is determinable from the docs. It is a
  heuristic; the `llm` graders cover what it cannot.
- `llm` graders: the file body is the criteria, and a judge model votes PASS in at least two of
  three votes (Q2).
- Arms: apart from Q4 (Skill graders) and Q5 (`arm: both`), how a grader is treated in the
  without-plugin arm is not determinable from the docs. The reminder, `no-ask-tool` and `llm`
  graders set no `arm`; if the without-plugin arm scores them, the reminder graders that expect
  a line fail there by construction. Check the first run's report before reading the score.

## What runs see

A run loads this plugin's skills, hooks and agents and runs on your machine, as you (Q10). What
else it loads (user settings, CLAUDE.md, memory, other plugins, MCP servers) is not
determinable from the docs. A run allows only the read-only tools the case lists, from a fixed
set that has no MCP tools (Q9), and this plugin declares no MCP server (there is no
`.mcp.json`; see "What is deliberately not here" in `../README.md`), so a run has no `quad_*`
tools. The skill's rule for that state is to say Quadron is not connected. The should-fire
cases therefore grade only that a skill loaded and that the reply claims no save.

## Not covered, and why

- Sign-in, tokens, OAuth, credentials and connector setup: out of scope for this suite. The
  `session-banner` grader looks for the plugin's static SessionStart line, not a sign-in prompt.
  The CLI's own hook ("Quadron is connected ...") belongs to `cli/` and is not part of the
  plugin; since a run is "as you" (Q10), whether a hook installed in your own settings also runs
  is not determinable from the docs, and it is not graded.
- Reading from or writing to the record (`quad_context`, `quad_recall`, `quad_commit`,
  `future_you_capture` and the rest): no `quad_*` tool exists in a run (Q9).
- The PostToolUse reminder (`hooks/scripts/memory-trigger.mjs`): it fires only after a Write or
  Edit of a memory file or CLAUDE.md, and a run allows only read-only tools from the Q9 list.
  Whether any option grants Write or Edit is not determinable from the docs; left for later.
- The offer-then-yes flow over two turns, and the skill's resume behaviour: each case is one
  prompt.

## Assumptions not yet checked by a run

- Unverified: that hook output (`additionalContext` from UserPromptSubmit and the SessionStart
  stdout) appears in the run trace the `trace` target reads. Q10 says hooks load, and Q13 says the trace
  holds the session one message per line, but the docs do not say hook output appears in
  `trace`. The first run must check this: if it does not appear, every reminder grader that
  expects a line fails and every one that expects none passes vacuously.
- That the skill loads for a stated decision with no save request (`capture-stated-decision`);
  the skill's description lists that trigger, but it is the least explicit of the should-fire
  prompts.

## Where this directory sits

`evals/` sits inside `plugins/claude-code`, and the marketplace entry's source is
`./plugins/claude-code`, so a marketplace install ships this directory with the plugin. It is
inert: no skill, hook or agent reads it. Its size is 42 files, 21504 bytes (measured
with `git ls-files plugins/claude-code/evals` and a byte sum of those files). That
`claude plugin eval` reads `evals/` by default is not determinable from the docs. Q6 says the
suite's location can be given as "a relative path of plain directory names", which still sits
below the plugin root and so would not keep the suite out of an install either; it would also
add a manifest key that the pinned validator in CI has not been checked against. The npm
package (`cli/package.json` `files`) does not include `plugins/`.

## Sources

All from https://code.claude.com/docs/en/plugin-evals, quoted verbatim.

- Q1: "Every grader file under `graders/` takes these keys in frontmatter, plus the options for
  its type. The grader's name is the filename without `.md`"
- Q2 (grader types table, `llm` row): "A judge model votes PASS on the rubric in at least two
  of three votes. In the `.md` layout the file body is the criteria"
- Q3 (target table): "`last_message` | Claude's final response text. This is the default"
- Q4 (graders reported with `scored: false` in a two-arm run, excluded from the score in both
  arms): "Every `tool_used` grader whose `tool` is `Skill`"
- Q5: "**`arm: both`**: set `arm: both` on a grader to score it in both arms regardless, which
  is what you want for a "must not invoke the skill" check with `min: 0` and `max: 0`."
- Q6: "Give a relative path of plain directory names such as `qa` or `quality/evals`."
- Q7: "In model calls, a suite makes roughly cases × runs agent runs with the plugin and the
  same number again for the no-plugin baseline, plus three short judge calls per `llm` or
  `baseline` grader per run."
- Q8 (`prompt.md` fields): "`max_turns` | `10` | Turn cap, up to 200" and "`allowed_tools` |
  `[]` | Tools the case wants, such as `[Read, Glob, Grep, Skill]`. Read-only tools are granted
  when listed here"
- Q9: "A run allows only the read-only tools the case lists in `allowed_tools`, from `Read`,
  `Glob`, `Grep`, `NotebookRead`, `Skill`, `AskUserQuestion`, `Agent`, `TodoWrite`, and the task
  tools"
- Q10: "`claude plugin eval` loads the target plugin's skills, hooks, and agents and runs its
  eval suite on your machine, as you."
- Q11 (`regex` grader): "The JavaScript regex `pattern` is found in the target. Set
  `match: not_contains` to require absence or `match: "count:N"` to require exactly N matches."
- Q12 (`tool_used` grader): "To assert a tool was never called, set both `min: 0` and `max: 0`"
- Q13 (`trace` target): "The session as JSON, one message per line. A `regex` grader sees every
  message ... Quotes and newlines inside it are JSON-escaped"
