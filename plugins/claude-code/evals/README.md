# Eval suite for the Quadron plugin

Cases for `claude plugin eval` (https://code.claude.com/docs/en/plugin-evals). They check
routing and reminders only: whether the `quadron` skill loads on natural phrasing, whether it
stays unused on unrelated requests, and whether the hooks' reminder lines reach the session.

**This suite has never been run.** Every file was written by hand; no case has a measured
result, pass rate or cost yet.

## Run it

From the repository root:

```
claude plugin eval ./plugins/claude-code --runs 3
```

Results are written to `plugins/claude-code/evals/results/`, which `.gitignore` keeps out of
git. `--max-cost-usd <usd>` sets a hard ceiling if one is wanted.

## Cost

- Agent runs: 9 cases x 3 runs x 2 arms (with and without the plugin) = 54 runs, each capped at
  6 turns (`max_turns: 6`).
- Judge calls: 2 `llm` graders (`capture-remember-this/asks-or-says-not-connected`,
  `capture-explicit-save/honest-no-save`) x 3 judge calls x 3 runs = 18 judge calls. Both are
  `arm: with-only`, and each of those cases also has an `arm: both` grader, so the without arm
  should not judge them; if it does, the count is 36.
- Every other grader is `tool_used` or `regex` and costs nothing beyond the run.
- No dollar figure: none has been measured.

## Cases

| Case | Checks | Graders |
|---|---|---|
| `recall-what-did-i-decide` | "what did I decide" loads the skill; recall reminder present, capture reminder absent | `skill-fired`, `recall-reminder`, `no-capture-reminder` |
| `recall-names-quadron` | naming Quadron with no hook phrase loads the skill from its description; no reminder | `skill-fired`, `no-recall-reminder`, `no-capture-reminder` |
| `capture-remember-this` | bare "remember this" loads the skill and gets the capture reminder; asks in plain text; claims no save | `skill-fired`, `capture-reminder`, `no-ask-tool`, `no-save-claim`, `asks-or-says-not-connected` (llm) |
| `capture-explicit-save` | "save this to my Quadron record" loads the skill and gets the capture reminder; claims no save | `skill-fired`, `capture-reminder`, `no-save-claim`, `honest-no-save` (llm) |
| `capture-stated-decision` | a decision stated as "we'll go with" loads the skill and gets the capture reminder; claims no save | `skill-fired`, `capture-reminder`, `no-ask-tool`, `no-save-claim` |
| `quiet-coding-task` | a coding request leaves the skill unused and gets no prompt reminder; SessionStart reminder present | `skill-not-fired`, `session-banner`, `no-recall-reminder`, `no-capture-reminder` |
| `quiet-decision-records` | a general question about team decision records leaves the skill unused | `skill-not-fired`, `no-recall-reminder`, `no-capture-reminder` |
| `quiet-git-keep-changes` | near-miss wording ("remind me", "keep the changes") leaves the skill unused and gets no reminder | `skill-not-fired`, `no-recall-reminder`, `no-capture-reminder` |
| `quiet-mcp-explainer` | a general MCP question leaves the skill unused | `skill-not-fired`, `no-recall-reminder`, `no-capture-reminder` |

Grader conventions:

- `skill-fired`: `tool_used` on `Skill` with the skill name `quadron` (optionally plugin-prefixed),
  `min: 1`, `arm: with-only`.
- `skill-not-fired`: the same match with `min: 0`, `max: 0`, `arm: both`, so it also holds
  without the plugin.
- Reminder graders: `regex` on `trace` for the start of each hook line, which holds no quotes
  (the trace is JSON, so quotes there are escaped). The patterns are the start of the texts in
  `hooks/scripts/session-banner.mjs` and `hooks/scripts/prompt-trigger.mjs`; change them with
  those scripts. Which prompts trigger which reminder was checked against
  `classifyPrompt` in `prompt-trigger.mjs`.
- `no-save-claim`: `regex` on `last_message`, `not_contains`, for affirmative save wording
  ("saved it to your Quadron record", "Quadron received it"); a lookbehind excludes negated forms
  ("nothing was saved to Quadron", "I haven't saved it to your record"). It is a heuristic; the
  `llm` graders cover what it cannot.

## What runs see

Eval runs load this plugin's skill and hooks and nothing personal: no user settings, CLAUDE.md,
memory or other plugins, and HOME is a temporary directory. A run never starts a real MCP server,
and this plugin declares none (there is no `.mcp.json`; see "What is deliberately not here" in
`../README.md`), so a run has no `quad_*` tools and there is nothing to mock under
`evals/mocks/`. The skill's rule for that state is to say Quadron is not connected. The
should-fire cases therefore grade only that the skill loaded and that the reply claims no save.

## Not covered, and why

- Sign-in, tokens, OAuth, credentials and connector setup: out of scope for this suite. The
  SessionStart reminder in an empty HOME is the plugin's static line, not a sign-in prompt, so
  it is graded; the CLI's own hook ("Quadron is connected ...", with the person's projects)
  belongs to `cli/`, is not loaded by the plugin, and is not graded.
- Reading from or writing to the record (`quad_context`, `quad_recall`, `quad_commit`,
  `future_you_capture` and the rest): no `quad_*` tool exists in a run, and the plugin declares
  no server to mock.
- The PostToolUse reminder (`hooks/scripts/memory-trigger.mjs`): it fires only after a Write or
  Edit of a memory file or CLAUDE.md, and the default eval tools are read-only. A case for it
  would need `allowed_tools` plus an operator grant (`--allow-tools Write`); left for later.
- The offer-then-yes flow over two turns, and the skill's resume behaviour: each case is one
  prompt.

## Assumptions not yet checked by a run

- That hook output (`additionalContext` from UserPromptSubmit and the SessionStart stdout) is
  recorded in the run trace the `trace` target reads. If it is not, every reminder grader that
  expects a line fails and every one that expects none passes vacuously; check the first run's
  trace before trusting those rows.
- That the `Skill` tool is in a run's default tool set.
- That the skill loads for a stated decision with no save request (`capture-stated-decision`);
  the skill's description lists that trigger, but it is the least explicit of the should-fire
  prompts.

## Where this directory sits

The suite lives in the default place, `evals/` under the plugin root, with no manifest change.
The marketplace entry's source is `./plugins/claude-code`, so a marketplace install carries this
directory with the plugin; it is inert Markdown that no skill, hook or agent reads. The
`experimental.evals` manifest option only renames a directory below the plugin root, so it would
not keep the suite out of an install either, and it would add a key to `plugin.json` that the
pinned validator in CI has not been checked against. The npm package (`cli/package.json`
`files`) does not include `plugins/`.
