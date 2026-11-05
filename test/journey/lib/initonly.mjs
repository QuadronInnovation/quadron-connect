// Init-only: a separate path that builds no row prompt, imports nothing from the file that sends
// prompts, and has no function that sends one. Its input is a stream that never produces a message,
// so --expect-no-key cannot reach a prompt: there is none on this path to reach.
//
// It reports three stdout lines, in this order: AUTH_SOURCE=<value>, TOKEN_SOURCE=<value> and
// SUBSCRIPTION_TYPE=<value>, from Query.initializationResult() (sdk.d.ts:3060-3067), whose
// account.apiKeySource is an open string (:28). The last two print `not shown` when absent, and no other
// account field is printed: see authLines in gates.mjs. Whether that resolves with no prompt is not
// shown; check by hand.
//
// Every gate applies. --expect-no-key replaces the "exactly ANTHROPIC_API_KEY" check only: that
// check exists to read whatever source a session with no key reports, so the value is printed.
// The lines are also printed when the one gate that stopped is an absent or null fast mode state, so
// that check can still read a stated source. The exit code stays a failure: nothing passes on it.
//
// Exit: 0, 1 a forbidden tool listed, 2 fast mode, 3 init timeout only, 4 auth, 5 any other gate.

import { EXIT } from "./guards.mjs";
import { authLines, closeQuery, initExitCode, openQuery, runGates, startPump } from "./gates.mjs";

// Returns { exitCode, lines?, note?, initRecord? }. The lines are printed by the caller.
export async function initOnly({ client, options, expectNoKey = false, timeoutMs, lifts = [], model }) {
  const ac = new AbortController();
  const never = (async function* () { await new Promise(() => {}); })();
  const q = openQuery(client, { prompt: never, options: { ...options, abortController: ac } });
  const pump = startPump(q);
  try {
    const { gate, initRecord, accountShown, loadCheckPending } = await runGates({ q, pump, def: { connector: false, initForm: true, model, tools: options.tools }, lifts, timeoutMs, expectNoKey });
    if (gate) {
      const lines = gate.fastModeUnconfirmed ? authLines(initRecord.authSource, accountShown) : undefined;
      return { exitCode: initExitCode(gate), lines, note: gate.message, initRecord };
    }
    // With no prompt there may never be an init message, so its checks may not have run.
    const note = loadCheckPending ? "no init message without a prompt: plugin_errors, tools and model were not checked" : undefined;
    return { exitCode: EXIT.OK, lines: authLines(initRecord.authSource, accountShown), note, initRecord };
  } finally {
    closeQuery(q);
    ac.abort();
  }
}
