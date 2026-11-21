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

From the plugin root (`plugins/claude-code`), run every case under `evals/` (Q19, Q20):

```
claude plugin eval . --max-cost-usd <cap>
```

From the repository root, the target is the plugin directory (Q20):

```
claude plugin eval ./plugins/claude-code --max-cost-usd <cap>
```

Each case runs three times with the plugin and three times without it (Q19). To iterate on one
case with a single run and no without-plugin arm, from the plugin root (Q19):

```
claude plugin eval . --case <case-name> --runs 1 --ablation none
```

Each run writes `evals/results/` (`plugins/claude-code/evals/results/` from the repository
root), which `.gitignore` keeps out of git (Q21). `--max-cost-usd <cap>` caps the run's
list-price cost estimate, not plan usage; it is checked before each run starts, so runs already
started finish and spend can pass the cap by those runs (Q25). `<cap>` is for the operator to
fill in.

## Cost

- Agent runs: 9 cases x 3 runs x 2 arms (with and without the plugin; "one case is six runs",
  Q7, Q19) = 54 agent runs, each capped at 10 turns (`max_turns: 10`, the documented
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
| `recall-what-did-i-decide` | "what did I decide" loads the quadron skill; recall reminder present, capture reminder absent | `skill-fired`, `recall-reminder`, `no-capture-reminder` |
| `recall-names-quadron` | naming Quadron with no hook phrase loads the quadron skill from its description; no reminder | `skill-fired`, `no-recall-reminder`, `no-capture-reminder` |
| `capture-remember-this` | bare "remember this" loads the quadron skill and gets the capture reminder; asks in plain text; claims no save | `skill-fired`, `capture-reminder`, `no-ask-tool`, `no-save-claim`, `asks-or-says-not-connected` (llm) |
| `capture-explicit-save` | "save this to my Quadron record" loads the quadron skill and gets the capture reminder; claims no save | `skill-fired`, `capture-reminder`, `no-save-claim`, `honest-no-save` (llm) |
| `capture-stated-decision` | a decision stated as "we'll go with" loads the quadron skill and gets the capture reminder; claims no save | `skill-fired`, `capture-reminder`, `no-ask-tool`, `no-save-claim` |
| `quiet-coding-task` | a coding request leaves the quadron skill unused and gets no prompt reminder; SessionStart reminder present | `skill-not-fired`, `session-banner`, `no-recall-reminder`, `no-capture-reminder` |
| `quiet-decision-records` | a general question about team decision records leaves the quadron skill unused | `skill-not-fired`, `no-recall-reminder`, `no-capture-reminder` |
| `quiet-git-keep-changes` | near-miss wording ("remind me", "keep the changes") leaves the quadron skill unused and gets no reminder | `skill-not-fired`, `no-recall-reminder`, `no-capture-reminder` |
| `quiet-mcp-explainer` | a general MCP question leaves the quadron skill unused | `skill-not-fired`, `no-recall-reminder`, `no-capture-reminder` |

Case conventions:

- Every `prompt.md` sets `max_turns: 10` (the default, stated explicitly) and
  `allowed_tools` (Q8). Every case lists `Skill`
  (Q8, Q9), so the Skill tool is available because the docs say listed read-only tools are
  granted, not by assumption. `capture-remember-this` and `capture-stated-decision` also list
  `AskUserQuestion` (Q9), so that `no-ask-tool` checks a call that could happen.
- Every `prompt.md` also sets `description` and `tags` (Q16). The description, which is for
  humans and not used at run time, says what the case checks; the tags (`should-fire`,
  `should-not-fire`, `recall`, `capture`, `hook-reminder` and so on) are labels for `--tag`
  filtering. `name` is not set, so it defaults to the directory name (Q16).

Grader conventions:

- `skill-fired`: `tool_used` on `Skill` with
  `input_match: '"skill"\s*:\s*"(?:[\w-]+:)?quadron"'` and `min: 1` (Q14, Q15). `quadron` is
  the skill's directory name under `skills/` (`skills/quadron/SKILL.md`), the name Claude
  invokes it by; the optional `[\w-]+:` prefix also matches the namespaced
  `plugin-name:quadron` form (Q15). In a two-arm run the docs report every `tool_used` grader
  whose `tool` is `Skill` with `scored: false` and leave it out of the score in both arms (Q4),
  so read this row in the report, not the score.
- `skill-not-fired`: the same `input_match` with `min: 0`, `max: 0` (Q12, Q14) and `arm: both`
  (Q5, Q18), so it is scored in both arms. It forbids only calls to the quadron skill.
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
  saved it to your record"). The pattern is a JavaScript regex (Q11), matched
  case-insensitively with `flags: i`, since inline `(?i)` isn't supported (Q17). It is a
  heuristic; the `llm` graders cover what it cannot.
- `llm` graders: the file body is the criteria, and a judge model votes PASS in at least two of
  three votes (Q2).
- Arms: apart from Q4 (Skill graders) and Q5, Q18 (`arm: both`, `arm: with-only`), how a grader is treated in the
  without-plugin arm is not determinable from the docs. The reminder, `no-ask-tool` and `llm`
  graders set no `arm`; if the without-plugin arm scores them, the reminder graders that expect
  a line fail there by construction. Check the first run's report before reading the score.

## What runs see

A run loads this plugin's skills, hooks and agents and runs on your machine, as you (Q10).
Nothing personal or project-level loads: your user settings, hooks, `CLAUDE.md` files, MCP
servers, other installed plugins, memory and skills are absent (Q22). A run never starts a
plugin's real MCP servers unless asked (Q23), and this plugin declares none (there is no
`.mcp.json`; see "What is deliberately not here" in `../README.md`). A run allows only the
read-only tools the case lists, from a fixed set that has no MCP tools (Q9), so a run has no
`quad_*` tools. The skill's rule for that state is to say Quadron is not connected. The
should-fire cases therefore grade only that the quadron skill loaded and that the reply claims
no save.

## Not covered, and why

- Sign-in, tokens, OAuth, credentials and connector setup: out of scope for this suite. The
  `session-banner` grader looks for the plugin's static SessionStart line, not a sign-in prompt.
  The CLI's own hook ("Quadron is connected ...") belongs to `cli/` and is not part of the
  plugin; a run loads none of your own hooks (Q22), so it does not run and is not graded.
- Reading from or writing to the record (`quad_context`, `quad_recall`, `quad_commit`,
  `future_you_capture` and the rest): no `quad_*` tool exists in a run (Q9).
- The PostToolUse reminder (`hooks/scripts/memory-trigger.mjs`): it fires only after a Write or
  Edit of a memory file or CLAUDE.md, and a run allows only read-only tools from the Q9 list
  unless the operator grants more with `--allow-tools` (Q26). Left for later: it would need a
  Write or Edit grant.
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
`./plugins/claude-code`, so a marketplace install ships this directory with the plugin (an
inference from this repo's layout, not a claim on the docs page). It is inert Markdown: no
skill, hook or agent reads it. Its size is 42 files, 28345 bytes (measured
with `git ls-files plugins/claude-code/evals` and a byte sum of those files). `evals/` is
the default location: `claude plugin eval .` runs "every case under `evals/`" (Q19). The
manifest key `experimental.evals` can move the suite (Q24), but only to "a relative path of
plain directory names" (Q6), which still sits inside the plugin root and so would still ship
with an install. The npm
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
- Q14 (`tool_used` options row): "`tool_used` | `tool`, `input_match`, `min`, `max` | The
  number of calls to `tool` whose JSON-encoded input matches the optional `input_match` regex is
  between `min`, default 1, and `max`, default unlimited."
- Q15 (Write a case manually): "Create `evals/first-case/graders/skill-fired.md`, replacing
  `your-skill-name` with the skill's directory name under `skills/`, which is the name Claude
  invokes it by:" followed by the example frontmatter `type: tool_used` / `tool: Skill` /
  `input_match: '"skill"\s*:\s*"(?:[\w-]+:)?your-skill-name"'`, and "This passes when Claude
  invoked that skill at least once during the run, including by its namespaced
  `plugin-name:skill-name` form."
- Q16 (`prompt.md` fields): "`name` | The directory name | Case name." / "`description` | |
  For humans. Not used at run time" / "`tags` | `[]` | Labels for `--tag` filtering." /
  "`expected_outcome` | | For humans. Not used at run time"
- Q17 (`regex` row): "Put case-insensitivity in `flags: i`; inline `(?i)` isn't supported"
- Q18 (grader frontmatter): "`arm` | unset | `with-only` excludes the grader from scoring in a
  two-arm run; `both` forces a grader Claude Code would otherwise exclude to be scored in both
  arms"
- Q19 (quickstart): "Back at your shell in the plugin root, run every case under `evals/`:"
  then `claude plugin eval .`; "Each case runs three times with your plugin and three times
  without it, so one case is six runs."; and (iterate)
  `claude plugin eval . --case <case-name> --runs 1 --ablation none`
- Q20 (targets table): "A plugin's root directory, such as `.` | Every case under its eval
  directory, with that plugin loaded"
- Q21 (layout): "results/ # written by each run; add to .gitignore"
- Q22 (isolation): "**Nothing personal or project-level loads.** Your user settings, hooks,
  `CLAUDE.md` files, MCP servers, other installed plugins, memory, and skills are absent."
- Q23 (mocks): "A run never starts your plugin's real MCP servers unless you ask."
- Q24 (eval directory): "If `evals/` is already taken by another tool, keep the suite in a
  different directory. You can record that directory in the plugin's `plugin.json` ... add
  `\"experimental\": { \"evals\": \"quality/evals\" }`."
- Q25 (command options): "`--max-cost-usd <usd>` | No ceiling | A ceiling on the run's
  list-price cost estimate, not on plan usage. Checked before each run starts. Once spent,
  nothing further starts; runs that already started finish, so spend can pass the ceiling by
  those runs."
- Q26 (Grant tools): "To let cases use `Bash`, `Write`, `Edit`, `WebFetch`, or `WebSearch`,
  grant them yourself:" followed by `claude plugin eval . --allow-tools Write Edit "Bash(npm test *)"`
- Edited quotes: Q13 contains a marked elision (...); Q21 collapses whitespace only.
