// The only file that imports the SDK package. Kept small so a harness switch is cheap.
// Loaded only by a dynamic import inside the live branch of main.mjs; tests inject a fake client.
// Install with `npm ci --ignore-scripts --prefix test/journey`: the lockfile pins the version, and
// no package script runs. The live path checks the installed version against the pin.
import { query } from "@anthropic-ai/claude-agent-sdk";

// Client shape the rest of the harness relies on: client.query({ prompt, options }) returns the
// SDK's Query: an async iterable of messages with initializationResult() (sdk.d.ts:3060-3067),
// interrupt() (:2952) and close() (:3342).
export function createClient() {
  return { query: (args) => query(args) };
}
