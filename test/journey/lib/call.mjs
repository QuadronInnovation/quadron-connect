// One model call with the prompt held back (streaming input, sdk.d.ts:3345-3346, SDKUserMessage
// :6576). The input stream waits until the gates in gates.mjs pass. If they fail, it ends without
// ever producing the prompt. This is the only file that sends a prompt.

import { EXIT, Refusal } from "./guards.mjs";
import { closeQuery, DEFAULT_INIT_TIMEOUT_MS, checkInitMessage, deferred, loadFailureGate, nonInitFirstMessage, openQuery, runGates, startPump, stopGate } from "./gates.mjs";

const SETTLE_MS = 1_000;
// How long an interrupted call is read for the result carrying its cost, before it is closed.
const INTERRUPT_READ_MS = 5_000;
const after = (ms) => new Promise((r) => { setTimeout(r, ms); });
const settle = () => after(SETTLE_MS);
const reportedCost = (m) => (typeof m?.total_cost_usd === "number" && Number.isFinite(m.total_cost_usd) ? m.total_cost_usd : null);

const userMessage = (text) => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });

// `deadline` is a promise that resolves when the row's wall-clock limit is reached. Returns
// { promptYielded, gate, initRecord, messages, error, timedOut, queryThrew, order, interrupted,
// costAfterInterrupt, highestCost }. `order` is the stream's message labels up to and including init,
// with a marker where the prompt went out. The docs promise neither that order nor a cost after an
// interrupt, so the first T2 settles both from this record. `highestCost` is the largest total the
// stream reported at any point: a path that keeps the reservation still charges it when it is larger.
export async function runGatedCall({ client, options, prompt, def, lifts = [], timeoutMs = DEFAULT_INIT_TIMEOUT_MS, deadline, abortController, onMessage }) {
  const held = deferred();
  const finished = deferred();
  const tripped = deferred();
  const out = { promptYielded: false, gate: null, initRecord: null, messages: [], error: null, timedOut: false, queryThrew: false, order: [], interrupted: false, costAfterInterrupt: null, highestCost: null };

  async function* input() {
    const go = await held.promise;
    if (!go) return;
    out.promptYielded = true;
    yield userMessage(prompt);
    await finished.promise; // the input stays open until the turn is over
  }

  let released = false;
  let loadCheckPending = false;
  let q;
  try {
    q = openQuery(client, { prompt: input(), options: { ...options, abortController } });
  } catch (e) {
    if (e instanceof Refusal) throw e; // no query started: a refusal, never a failed start
    // The caller keeps the reservation: nothing shows what the failed start did or did not spend.
    out.queryThrew = true;
    out.error = e;
    return out;
  }
  const trip = (gate) => {
    out.gate = out.gate ?? gate;
    tripped.resolve();
    return "drain";
  };
  const pump = startPump(q, {
    onMessage,
    stopOn: (m, isInit) => {
      if (released && loadCheckPending) {
        // The stream's first message after the prompt is the load check.
        loadCheckPending = false;
        if (!isInit) return trip(loadFailureGate({ message: nonInitFirstMessage(m) }));
        const failed = checkInitMessage(m, def, lifts);
        if (failed) return trip(loadFailureGate(failed));
        if (out.initRecord) out.initRecord.gateSource = "first message after the prompt";
        return false;
      }
      // Every other init message, before or after the prompt.
      if (!isInit) return false;
      const gate = out.gate ?? checkInitMessage(m, def, lifts);
      if (!gate) return false;
      if (released) return trip(gate);
      out.gate = gate;
      return true;
    },
  });
  const expired = (deadline ?? new Promise(() => {})).then(() => "expired");

  const finish = async () => {
    finished.resolve();
    closeQuery(q);
    abortController?.abort();
    await Promise.race([pump.ended, settle()]);
    // A load failure accepts nothing: not an output, and not a cost that would replace the reservation.
    out.messages = out.gate?.loadFailure ? pump.messages.filter((m) => m.type === "system" && m.subtype === "init") : pump.messages;
    out.error = pump.error;
    out.order = pump.order;
    const costs = [...pump.messages.filter((m) => m.type === "result"), pump.drained].map(reportedCost).filter((c) => c !== null);
    out.highestCost = costs.length ? Math.max(...costs) : null;
  };

  const gates = await Promise.race([runGates({ q, pump, def, lifts, timeoutMs }), expired]);
  if (gates === "expired") {
    out.timedOut = true;
    held.resolve(false);
    await finish();
    return out;
  }
  out.initRecord = gates.initRecord;
  out.gate = gates.gate ?? out.gate; // an init message may have stopped the pump since the gates last looked
  // A stream that is already over cannot answer a prompt: it would be charged for nothing.
  if (!out.gate && pump.finished) out.gate = stopGate(EXIT.STOPPED, "the stream ended before the prompt");
  if (out.gate) {
    held.resolve(false);
    await finish();
    return out;
  }

  loadCheckPending = Boolean(gates.loadCheckPending) && !pump.init;
  released = true;
  pump.order.push("<prompt sent>");
  held.resolve(true);
  const ended = await Promise.race([pump.ended.then(() => "ended"), tripped.promise.then(() => "tripped"), expired]);
  if (ended === "expired") out.timedOut = true;
  if (ended === "ended" && loadCheckPending && !pump.error) out.gate = out.gate ?? loadFailureGate({ message: "the stream ended after the prompt with no message" });
  if (ended === "expired" || out.gate) {
    out.interrupted = true;
    try { await Promise.race([q.interrupt?.(), settle()]); } catch { /* closing only */ }
    await Promise.race([pump.ended, after(ended === "expired" ? SETTLE_MS : INTERRUPT_READ_MS)]);
    // A result already in hand before a gate tripped came before the interrupt, so it does not count.
    const results = ended === "expired" ? pump.messages.filter((m) => m.type === "result") : [];
    out.costAfterInterrupt = reportedCost(pump.drained ?? results.at(-1));
  }
  await finish();
  return out;
}
