# Journey runner

`run.mjs` runs the plugin's T3-T6 journey checks (see `plugins/claude-code/README.md`,
"Verification still to run") plus a project-setup row `P`, by driving the unmodified `claude`
binary in print mode against the `quadron` MCP server registered for this clone. For each row it
records the exact command, exit code, session id, turns, cost, every tool call, every permission
denial, the SessionStart hook output and the final answer, then writes a verdict. Every row is a
fresh session (its later turns resume its own first turn). T4 checks that a stated decision is
only proposed in turn 1 and captured once after "yes" in turn 2, with `future_you_capture` when
the server lists it, else `quad_commit`. T6 runs only after T4 passed in the same run (or with `--assume-write`).

Limits, enforced before any `claude -p` (exit 2 on failure):
- On demand only: rows run once, in order, with no retries, loops or scheduling.
- Uses the existing claude.ai subscription login and handles no credentials. It refuses to run
  when `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set, never passes `--bare`, and
  requires `claude auth status` to report a claude.ai login on the first-party API.
- Staging only: the registered connector must point at the staging server and be connected, and
  `quadron-connect status` must show a linked sign-in with a valid token.
- Narrowest `--allowedTools` per prompt with `--permission-prompts none`; T4 turn 2 is the only turn allowed a capture tool.
- Every turn also passes `--disallowedTools Write Edit MultiEdit NotebookEdit Bash`, so no local writes.
- A memory sentinel diffs this repository's Claude Code project `memory/` folder after each row; any change is reported as a side effect and fails the run (nothing is restored).

Usage: `node test/journey/run.mjs --out <absolute dir outside the repo> [--rows P,T3,T4,T5,T6] [--assume-write] [--dry-run]`

Raw output (`preflight.json`, `<row>-<turn>.jsonl|.err`, `summary.json`, `summary.md`) stays in `--out`, outside the repository; `summary.md` is redacted (paths, home directory, URLs) for pasting. Exit codes: 0 all rows pass, 1 a row failed or errored, 2 preflight or usage failure.
