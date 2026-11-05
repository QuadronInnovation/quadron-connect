// Spend accounting and the persisted ledger. `maxBudgetUsd` "counts only the call's own spend" and
// totals restored from a resumed session do not count against it (sdk.d.ts:1993), while a result's
// total_cost_usd is cumulative within a session (sdk.d.ts:5969). So per-call spend is the
// difference from the previous value in that session. Costs are client-side estimates, not billing
// data.
//
// Money is bounded in two steps. This file holds the rates, the ceiling and each call's worst case;
// campaign.mjs holds the record they are checked against, which outlives any ledger.
//
// The ledger holds attempts and verdicts. It is a JSON file outside the clone, {"entries":[...]},
// created empty by whoever sets up the run and rewritten whole, through a rename, on every change.
// Entry kinds:
//   call:         {kind, id, status:"open"|"closed", row, turn, model, head, verdict, at, ceiling,
//                  spend, promptYielded, note?, messageOrder?, cacheWrite1hTokens?, interrupted?,
//                  costAfterInterrupt?, connectorStatus?}
//                  (ceiling is the call's reservation; connectorStatus is {first, final}, from the
//                  check before a connector row's first prompt)
//   row:          {kind, row, model, head, verdict, at, judgmentId?, savedWording?, quadName?,
//                  routing?, signedClaim?}
//   confirmation: {kind, judgmentId, head, at}
//   limit:        {kind, maxTotalUsd, at}
// A call is written open, with its reservation as its spend, before the call starts. It is replaced
// by the actual spend afterwards.

import path from "node:path";
import { EXIT, Refusal } from "./guards.mjs";
import { recordModelTotal, recordTotal } from "./campaign.mjs";
import { ROWS } from "./rows.mjs";

const EPS = 1e-9;

// ------------------------------------------------------------------ the ceiling and the rates

// The source of truth for the campaign. A flag may lower it, never raise it.
export const CAMPAIGN_CEILING_USD = 5;
export const MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_CONTEXT_TOKENS = 100_000;

// Published USD per million tokens, read 2026-11-04. cacheWrite is the 5-minute write. Haiku is its
// higher tier (prompts over 100,000 tokens), as the worst case. The only models a live run accepts.
export const MODEL_RATES = {
  "claude-opus-5-5": { family: "opus", input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  "claude-haiku-5-5": { family: "haiku", input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 },
};

export const modelFamily = (model) => (Object.hasOwn(MODEL_RATES, model) ? MODEL_RATES[model].family : null);

export function assertKnownModel(model) {
  if (!modelFamily(model)) throw new Refusal(`--model must be exactly one of ${Object.keys(MODEL_RATES).join(", ")}`);
}

// A call's worst case: its session budget, plus one more response at this model's prices, since the
// response that crosses a budget is still counted. The context is the larger of the constant and the
// largest prompt measured so far in this session: a small prompt on one turn says nothing about the
// next response's prompt, so a measurement can raise a reservation and never shrink it.
export function worstCase({ model, sessionUsd, maxOutputTokens = MAX_OUTPUT_TOKENS, measuredTokens = null }) {
  assertKnownModel(model);
  const rates = MODEL_RATES[model];
  const measuredAbove = measuredTokens !== null && measuredTokens > DEFAULT_CONTEXT_TOKENS;
  const contextTokens = measuredAbove ? measuredTokens : DEFAULT_CONTEXT_TOKENS;
  const responseUsd = (maxOutputTokens * rates.output + contextTokens * Math.max(rates.input, rates.cacheWrite)) / 1_000_000;
  return { reservationUsd: sessionUsd + responseUsd, sessionUsd, responseUsd, contextTokens, contextSource: measuredAbove ? "measured" : "constant", maxOutputTokens };
}

// May this call start? Actual spend so far plus its worst case must not pass either ceiling.
export function reservationCheck(state, { model, reservationUsd, runUsd, totalUsd }) {
  if (recordModelTotal(state, model) + reservationUsd > runUsd + EPS) return { ok: false, reason: "run ceiling" };
  if (recordTotal(state) + reservationUsd > totalUsd + EPS) return { ok: false, reason: "total ceiling" };
  return { ok: true };
}

// The total limit in force. The flag can lower what is stored, which itself sits under the constant,
// and refuses when it would raise it.
export function bindLimit(stored, flag) {
  const cap = Math.min(CAMPAIGN_CEILING_USD, stored ?? Infinity);
  if (flag === null) return cap;
  if (flag > cap + EPS) throw new Refusal(`--max-total-usd ${flag} is above the ${cap} USD limit in force; a flag can only lower it`);
  return flag;
}

export class SpendTracker {
  constructor() {
    this.lastCumulative = new Map(); // session id -> last reported total_cost_usd
  }

  // Returns {spend} or {unknown:true}. A missing or non-finite cost, one lower than the session's
  // previous value, or no increase after a real call (result types say crash and startup-error
  // results may carry zeroed values) is unknown: the call stays at its reservation.
  record(sessionId, cumulative) {
    if (typeof cumulative !== "number" || !Number.isFinite(cumulative)) return { unknown: true };
    const prev = this.lastCumulative.get(sessionId) ?? 0;
    if (cumulative <= prev + EPS) return { unknown: true };
    this.lastCumulative.set(sessionId, cumulative);
    return { spend: cumulative - prev };
  }
}

// ------------------------------------------------------------------ persisted ledger

const finiteSpend = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function readLedger(file, fs) {
  if (!file) throw new Refusal("--ledger is required");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { throw new Refusal("ledger is missing or unreadable"); }
  let data;
  try { data = JSON.parse(raw); } catch { throw new Refusal("ledger is corrupt (not JSON)"); }
  if (!data || !Array.isArray(data.entries)) throw new Refusal("ledger is corrupt (no entries list)");
  for (const e of data.entries) {
    const ok = (e?.kind === "call" && finiteSpend(e.spend)) ||
      (e?.kind === "row" && typeof e.row === "string" && typeof e.model === "string" && typeof e.verdict === "string") ||
      (e?.kind === "confirmation" && typeof e.judgmentId === "string" && typeof e.head === "string") ||
      (e?.kind === "limit" && finiteSpend(e.maxTotalUsd));
    if (!ok) throw new Refusal("ledger is corrupt (bad entry)");
  }
  return data;
}

// The lowest --max-total-usd this ledger has seen, or null.
export function ledgerLimit(data) {
  const limits = data.entries.filter((e) => e.kind === "limit").map((e) => e.maxTotalUsd);
  return limits.length ? Math.min(...limits) : null;
}

export function writeLedger(file, fs, data) {
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    throw new Refusal("the ledger could not be written; the run stops", EXIT.STOPPED);
  }
}

export function appendEntry(file, fs, data, entry) {
  data.entries.push(entry);
  writeLedger(file, fs, data);
  return entry;
}

// Written before the call starts. Its spend stays at the reservation until closeCall replaces it.
export function openCall(file, fs, data, fields) {
  return appendEntry(file, fs, data, {
    kind: "call", status: "open", verdict: "open", promptYielded: false, ...fields, spend: fields.ceiling,
  });
}

export function closeCall(file, fs, data, entry, fields) {
  Object.assign(entry, { status: "closed" }, fields);
  writeLedger(file, fs, data);
}

// ------------------------------------------------------------------ lock

// An exclusive file next to the ledger, and another next to the campaign record, refuse concurrent
// invocations, including two with different ledgers. A kill leaves them behind, so each is named in
// the message and never removed automatically: check by hand that no run is still live.
export function takeLock(file, fs, label = "ledger") {
  const lock = `${file}.lock`;
  let fd;
  try {
    fd = fs.openSync(lock, "wx");
  } catch (e) {
    if (e?.code === "EEXIST") {
      throw new Refusal(`lock file ${path.basename(lock)} exists next to the ${label}: another run is live, or it is stale from a killed run; it is never removed automatically`);
    }
    throw new Refusal(`cannot create the ${label} lock file`);
  }
  fs.closeSync(fd);
  return { release: () => { try { fs.unlinkSync(lock); } catch { /* the next run reports it */ } } };
}

// ------------------------------------------------------------------ attempt limits

const passed = (v) => /^PASS/.test(v);

// An attempt is a row's first call at this head on the campaign record, so a new ledger does not
// reset the count. Each one counts unless it settled at an actual of 0, which only a stop before the
// prompt writes: an unsettled call (a kill mid-call) counts, and so does a charged query that threw.
const isAttempt = (c) => c.turn === 1 && !(c.settled && c.actualUsd === 0);
export function attemptsFor(state, row, model, head) {
  return state.calls.filter((c) => c.row === row && c.model === model && c.head === head && isAttempt(c)).length;
}

export function attemptLimit(row, family) {
  if (row === "T6") return 1; // T6 runs once per model at most
  return family === "opus" ? 2 : 1;
}

export function opusPassedAtHead(data, row, head) {
  return data.entries.some((e) => e.kind === "row" && e.row === row && e.head === head && modelFamily(e.model) === "opus" && passed(e.verdict));
}

// Throws a Refusal when this row may not run on this model at this head: the attempt count from the
// campaign record, and the passes from the ledger, which holds the verdicts. A row's `repeatAfterPass`
// lets its second Opus attempt run after a pass; it comes from the row's definition alone, and the
// attempt limit still holds.
export function checkAttempts(data, state, { row, model, head }) {
  const family = modelFamily(model);
  if (!family) throw new Refusal("model is neither Opus nor Haiku: no attempt limit is defined for it");
  const limit = attemptLimit(row, family), used = attemptsFor(state, row, model, head);
  if (used >= limit) throw new Refusal(`${row} has used ${used} of ${limit} attempt(s) on this model at this head`);
  if (family === "opus" && !ROWS[row]?.repeatAfterPass && opusPassedAtHead(data, row, head)) throw new Refusal(`${row} already passed on Opus at this head`);
  if (family === "haiku" && !opusPassedAtHead(data, row, head)) {
    throw new Refusal(`${row} has no Opus pass at this head; Haiku does not run before it`);
  }
}

// The record outlives a ledger, and the ledger holds the verdicts: on a different ledger a row that
// passed looks as if it never ran, so T4 could send a second real capture and T6 could lose its
// prerequisite. So each attempt the record holds for this row at this head, on any model, and for T4
// when this is T6, must have its call in this ledger. A call is written to the record, then to the
// ledger, both before the prompt, so a normal run always holds both. A kill between the two writes
// refuses here too: check by hand what that run did.
export function checkLedgerMatchesRecord(data, state, { row, head, ledgerFile, recordFile }) {
  const lost = state.calls.filter((c) => c.head === head && isAttempt(c) && (c.row === row || (row === "T6" && c.row === "T4")) &&
    !data.entries.some((e) => e.kind === "call" && e.id === c.id));
  if (!lost.length) return;
  const rows = [...new Set(lost.map((c) => `${c.row} on ${c.model}`))].join(", ");
  throw new Refusal(`the campaign record (${path.basename(recordFile)}) holds ${lost.length} attempt(s) at this head that the ledger (${path.basename(ledgerFile)}) has no entry for: ${rows}. ` +
    "Either this is the wrong ledger, or a run was killed after writing its reservation and before writing to the ledger. Check by hand: nothing clears this automatically");
}

// ------------------------------------------------------------------ judgment confirmation (T6)

export const NOT_SHOWN = "not shown";
// The one pattern for a judgment id, shared with the route that applies the confirmation.
export const JUDGMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const t4Passes = (data, head) => data.entries.filter((e) => e.kind === "row" && e.row === "T4" && e.head === head && passed(e.verdict) &&
  typeof e.judgmentId === "string" && e.judgmentId !== NOT_SHOWN);

// Returns {ok:true, id, wording} or {ok:false, reason}: T6 needs a T4 PASS at this head holding an
// id and the saved wording, and a confirmation record for that id made at this head.
export function t6Prerequisite(data, head) {
  const pass = t4Passes(data, head);
  if (!pass.length) return { ok: false, reason: "no T4 PASS with a judgment id at this head" };
  for (const e of [...pass].reverse()) {
    if (!data.entries.some((c) => c.kind === "confirmation" && c.judgmentId === e.judgmentId && c.head === head)) continue;
    if (typeof e.savedWording !== "string" || !e.savedWording || e.savedWording === NOT_SHOWN) {
      return { ok: false, reason: "the T4 entry holds no saved wording to compare" };
    }
    return { ok: true, id: e.judgmentId, wording: e.savedWording };
  }
  return { ok: false, reason: "no confirmation record for the T4 judgment id at this head" };
}

export function markConfirmed(file, fs, data, { id, head, at }) {
  if (!JUDGMENT_ID_RE.test(id)) throw new Refusal("that id does not match the judgment id pattern");
  if (!t4Passes(data, head).some((e) => e.judgmentId === id)) throw new Refusal("that id does not match a T4 PASS at this head in the ledger");
  return appendEntry(file, fs, data, { kind: "confirmation", judgmentId: id, head, at });
}
