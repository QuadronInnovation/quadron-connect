// Init-only: a separate path that builds no row prompt, imports nothing from the file that sends
// prompts, and has no function that sends one. Its input is a stream that never produces a message,
// so --expect-no-key cannot reach a prompt: there is none on this path to reach.
//
// It reports exactly one stdout line AUTH_SOURCE=<value>, from Query.initializationResult()
// (sdk.d.ts:3060-3067), whose account.apiKeySource is an open string (:28). Whether that resolves
// with no prompt is not shown; the owner's check measures it.
//
// Every gate applies. --expect-no-key replaces the "exactly ANTHROPIC_API_KEY" check only: that
// check exists to read whatever source a session with no key reports, so the value is printed.
// The line is also printed when the one gate that stopped is an absent or null fast mode state, so
// that check can still read a stated source. The exit code stays a failure: nothing passes on it.
//
// Exit: 0, 1 a forbidden tool listed, 2 fast mode, 3 init timeout only, 4 auth, 5 any other gate.

import { EXIT } from "./guards.mjs";
import { closeQuery, initExitCode, openQuery, runGates, startPump } from "./gates.mjs";

// Returns { exitCode, line?, note?, initRecord? }. The line is printed by the caller.
export async function initOnly({ client, options, expectNoKey = false, timeoutMs, lifts = [], model }) {
  const ac = new AbortController();
  const never = (async function* () { await new Promise(() => {}); })();
  const q = openQuery(client, { prompt: never, options: { ...options, abortController: ac } });
  const pump = startPump(q);
  try {
    const { gate, initRecord, loadCheckPending } = await runGates({ q, pump, def: { connector: false, model }, lifts, timeoutMs, expectNoKey });
    if (gate) {
      const line = gate.fastModeUnconfirmed ? `AUTH_SOURCE=${initRecord.authSource}` : undefined;
      return { exitCode: initExitCode(gate), line, note: gate.message, initRecord };
    }
    // With no prompt there may never be an init message, so its checks may not have run.
    const note = loadCheckPending ? "no init message without a prompt: plugin_errors, tools and model were not checked" : undefined;
    return { exitCode: EXIT.OK, line: `AUTH_SOURCE=${initRecord.authSource}`, note, initRecord };
  } finally {
    closeQuery(q);
    ac.abort();
  }
}
