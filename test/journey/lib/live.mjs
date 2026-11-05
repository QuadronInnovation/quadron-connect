// The live paths: a row attempt, init-only, init-only with one turn, and the confirmation record.
// Reached only from the live branch of main.mjs, which has done the environment and settings checks.

import path from "node:path";

import {
  EXIT, Refusal, CONNECTOR_VARS, assertBareDontAsk, assertOutsideClone, buildChildEnv, credentialFilesIn, readHead, scanToolUses, snapshotTree,
} from "./guards.mjs";
import {
  SpendTracker, MAX_OUTPUT_TOKENS, NOT_SHOWN, appendEntry, bindLimit, checkAttempts, checkLedgerMatchesRecord, closeCall, ledgerLimit, markConfirmed,
  openCall, readLedger, reservationCheck, t6Prerequisite, takeLock, worstCase,
} from "./spend.mjs";
import { appendLimit, appendReservation, appendSettlement, readRecord, recordModelTotal, recordTotal } from "./campaign.mjs";
import { assertStaging, checkAccount, mcpServersFor, mintAccessToken } from "./connector.mjs";
import { FindingsLog, haikuFailureFinding, scanSignals } from "./findings.mjs";
import { ROWS, CAPTURE_PLACEHOLDER, SERVER_NAME, T3_CHECK, pickCaptureTool } from "./rows.mjs";
import { BARE_CONFIRMATION, buildOptions, inScope } from "./options.mjs";
import { VERDICTS, collect, connectorCalled, initStatuses, quadContextCalls, turnGate } from "./verdicts.mjs";
import { initOnly } from "./initonly.mjs";
import { runGatedCall } from "./call.mjs";
import { Evidence, newUniqueDir } from "./evidence.mjs";
import { DEFAULT_INIT_TIMEOUT_MS, initExitCode } from "./gates.mjs";

export const DEFAULT_ROW_TIMEOUT_SECONDS = 600;
const FIXED_PROMPT = "Reply with the single word: ok";
export const LOAD_FAILURE = "LOAD FAILURE";

const num = (v) => (v !== undefined && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? Number(v) : null);
const iso = (now) => new Date(now()).toISOString();
const outputLimit = (f) => (f["max-output-tokens"] === undefined ? MAX_OUTPUT_TOKENS : Number(f["max-output-tokens"]));

function hygiene(dirs, fs) {
  return dirs.flatMap((d) => credentialFilesIn(d, fs));
}

function rowSecondsFrom(f) {
  const s = f["row-timeout-seconds"] === undefined ? DEFAULT_ROW_TIMEOUT_SECONDS : num(f["row-timeout-seconds"]);
  if (s === null) throw new Refusal("--row-timeout-seconds must be a positive number");
  return s;
}

// ------------------------------------------------------------------- the spend bound

// The total limit in force: the constant, lowered by anything the record or the ledger has stored,
// lowered by the flag. A later flag can never raise it. A lower value is stored in both places, so
// a new ledger does not undo it either.
function bindCeilings(ctx, ledger) {
  const { f, fs, campaign, now } = ctx;
  const flag = f["max-total-usd"] === undefined ? null : num(f["max-total-usd"]);
  const state = readRecord(campaign, fs);
  const inLedger = ledgerLimit(ledger);
  const stored = [state.limit, inLedger].filter((v) => v !== null);
  const limit = bindLimit(stored.length ? Math.min(...stored) : null, flag);
  if (flag !== null) {
    if (inLedger === null || flag < inLedger) appendEntry(f.ledger, fs, ledger, { kind: "limit", maxTotalUsd: flag, at: iso(now) });
    if (state.limit === null || flag < state.limit) appendLimit(campaign, fs, { maxTotalUsd: flag, at: iso(now) });
  }
  return { model: f.model, sessionUsd: num(f["max-session-usd"]), runUsd: num(f["max-run-usd"]), totalUsd: limit, maxOutputTokens: outputLimit(f) };
}

// This call's worst case against the record as it is on disk now.
function checkCall(ctx, budget, measuredTokens) {
  const worst = worstCase({ model: budget.model, sessionUsd: budget.sessionUsd, maxOutputTokens: budget.maxOutputTokens, measuredTokens });
  const can = reservationCheck(readRecord(ctx.campaign, ctx.fs), { model: budget.model, reservationUsd: worst.reservationUsd, runUsd: budget.runUsd, totalUsd: budget.totalUsd });
  return { ...can, worst };
}

// Written before the call starts: first the record, then the ledger. A kill from here on stays
// charged at the reservation.
function reserveCall(ctx, ledger, worst, { id, row, turn, head }) {
  const { f, fs, campaign, now } = ctx;
  const at = iso(now);
  appendReservation(campaign, fs, { call: id, row, turn, model: f.model, head, at, reservationUsd: worst.reservationUsd, sessionUsd: worst.sessionUsd,
    responseUsd: worst.responseUsd, contextTokens: worst.contextTokens, contextSource: worst.contextSource, maxOutputTokens: worst.maxOutputTokens });
  return openCall(f.ledger, fs, ledger, { id, row, turn, model: f.model, head, at, ceiling: worst.reservationUsd });
}

// actualUsd null: no reported cost, so the charge stays at the reservation. Returns true when the
// record took it. If it could not, the reservation stands, which is the safe side.
function settleCall(ctx, ledger, entry, { actualUsd, fields }) {
  const { f, fs, campaign, now } = ctx;
  const chargedUsd = actualUsd ?? entry.ceiling;
  let settled = true;
  try {
    appendSettlement(campaign, fs, { call: entry.id, at: iso(now), actualUsd, chargedUsd });
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    settled = false;
  }
  closeCall(f.ledger, fs, ledger, entry, { spend: chargedUsd, ...fields });
  return settled;
}

// Both locks for the whole command, so two runs on different ledgers still cannot share the record.
async function locked(ctx, fn) {
  const ledgerLock = takeLock(ctx.f.ledger, ctx.fs);
  let recordLock = null;
  try {
    recordLock = takeLock(ctx.campaign.file, ctx.fs, "campaign record");
    return await fn();
  } finally {
    recordLock?.release();
    ledgerLock.release();
  }
}

// What the docs do not promise and the first T2 settles: the stream's order up to init, and the cost
// an interrupted call reports. Labels and a number only, never content. The 1-hour cache writes
// (ModelUsage, sdk.d.ts:1500, on a result's modelUsage, :5977) show whether the 5-minute pin held:
// an observation with no effect on any verdict, and absent is "not shown", which proves nothing.
function cacheWrite1hTokens(result) {
  const counts = Object.values(result?.modelUsage ?? {}).map((u) => u?.cacheCreationEphemeral1hInputTokens).filter((n) => typeof n === "number" && Number.isFinite(n));
  return counts.length ? counts.reduce((a, n) => a + n, 0) : NOT_SHOWN;
}
const streamFacts = (call, s) => ({
  messageOrder: call.order, cacheWrite1hTokens: cacheWrite1hTokens(s.result), ...(call.interrupted ? { interrupted: true, costAfterInterrupt: call.costAfterInterrupt } : {}),
  ...(call.initRecord?.connectorStatus ? { connectorStatus: call.initRecord.connectorStatus } : {}),
});

// A session's options, held to the guard before anything is reserved. `testOptionsHook` is how a test
// shows the guard refusing: main takes it as a dependency, no flag sets it, and it runs before the guard.
function sessionOptions(ctx, args) {
  const options = (ctx.testOptionsHook ?? ((o) => o))(buildOptions(args));
  assertBareDontAsk(options);
  return options;
}
// Refuses before any form creates a directory, takes a lock, mints a token or loads the SDK.
export const checkSessionOptions = (ctx) => { sessionOptions(ctx, {}); };

// ------------------------------------------------------------------- confirmation record

// No model or network call, no key and no campaign variable. It reads the ledger and the clone's
// head from git's files, and takes the ledger lock.
export function markJudgmentConfirmed({ f, fs, io, repoRoot, now }) {
  const lock = takeLock(f.ledger, fs);
  try {
    const head = readHead(repoRoot, fs);
    const data = readLedger(f.ledger, fs);
    markConfirmed(f.ledger, fs, data, { id: f["mark-judgment-confirmed"], head, at: iso(now) });
    io.out("judgment confirmation recorded");
    return { exitCode: EXIT.OK };
  } finally {
    lock.release();
  }
}

// ------------------------------------------------------------------- init-only

// The system temp directory unless a test names another; it is checked against the clone.
function initDirs({ fs, tmpRoot, repoRoot }) {
  assertOutsideClone({ "the temporary directory": tmpRoot }, repoRoot, fs);
  const base = fs.mkdtempSync(path.join(tmpRoot, "journey-init-"));
  const homeDir = path.join(base, "home"), cwd = path.join(base, "cwd");
  fs.mkdirSync(homeDir);
  fs.mkdirSync(cwd);
  return { homeDir, cwd };
}

const initOptions = (ctx, childEnv, cwd, extra = {}) => sessionOptions(ctx, {
  settingsPath: ctx.f.settings, pluginDir: ctx.f["plugin-dir"], childEnv, cwd, tools: [],
  model: ctx.f.model, effort: ctx.f.effort, ...extra,
});

export async function liveInitOnly(ctx) {
  const { f, env, fs, io, red, lifts, timeoutMs } = ctx;
  const { homeDir, cwd } = initDirs(ctx);
  const childEnv = buildChildEnv(env, { configDir: f["config-dir"], homeDir, maxOutputTokens: outputLimit(f) });
  const client = await ctx.getClient();
  const r = await initOnly({
    client, options: initOptions(ctx, childEnv, cwd), expectNoKey: Boolean(f["expect-no-key"]), timeoutMs, lifts, model: f.model,
  });
  if (r.note) io.err(red.text(r.note));
  const cred = hygiene([f["config-dir"], homeDir], fs);
  if (cred.length) {
    io.err(`hygiene failure: credential-named file in the config or home directory: ${cred.length}`);
    return { exitCode: r.exitCode === EXIT.OK ? EXIT.ROWS_FAILED : r.exitCode, hygiene: cred.length };
  }
  if (r.line) io.out(r.line); // at most one stdout line: on success, or with fast mode unconfirmed
  return { exitCode: r.exitCode };
}

// One fixed token prompt, maxTurns 1, under the same record, ledger, locks and ceilings as any row.
export async function liveInitWithTurn(ctx) {
  return locked(ctx, () => initWithTurn(ctx));
}

async function initWithTurn(ctx) {
  const { f, env, fs, io, red, lifts, now, timeoutMs, repoRoot } = ctx;
  const head = readHead(repoRoot, fs);
  const ledger = readLedger(f.ledger, fs);
  const rowSeconds = rowSecondsFrom(f);
  const budget = bindCeilings(ctx, ledger);
  const can = checkCall(ctx, budget, null);
  if (!can.ok) throw new Refusal(`this call's worst case of ${can.worst.reservationUsd.toFixed(4)} USD would pass the ${can.reason}; nothing started`);
  const { homeDir, cwd } = initDirs(ctx);
  const childEnv = buildChildEnv(env, { configDir: f["config-dir"], homeDir, maxOutputTokens: budget.maxOutputTokens });
  const client = await ctx.getClient();
  const options = initOptions(ctx, childEnv, cwd, { sessionUsd: budget.sessionUsd, maxTurns: 1 });
  const entry = reserveCall(ctx, ledger, can.worst, { id: `init-${now()}`, row: "INIT", turn: 1, head });

  let timer;
  const deadline = new Promise((r) => { timer = setTimeout(r, rowSeconds * 1000); });
  let call;
  try {
    call = await runGatedCall({ client, options, prompt: FIXED_PROMPT, def: { connector: false, model: f.model }, lifts, timeoutMs, deadline, abortController: new AbortController() });
  } finally {
    clearTimeout(timer);
  }
  const s = collect(call.messages);
  const cost = s.result?.total_cost_usd;
  const known = typeof cost === "number" && Number.isFinite(cost) && cost > 0;
  const seen = streamFacts(call, s);
  let settled;
  if (call.queryThrew) settled = settleCall(ctx, ledger, entry, { actualUsd: null, fields: { ...seen, verdict: "query threw", note: "the query call threw: stays at its reservation" } });
  else if (!call.promptYielded) settled = settleCall(ctx, ledger, entry, { actualUsd: 0, fields: { ...seen, verdict: "gate", note: call.gate?.message } });
  else if (known) settled = settleCall(ctx, ledger, entry, { actualUsd: cost, fields: { ...seen, promptYielded: true, verdict: "done" } });
  else if (call.highestCost !== null && call.highestCost > entry.ceiling) {
    io.err("the call's reported cost passed its reservation");
    settled = settleCall(ctx, ledger, entry, { actualUsd: call.highestCost, fields: { ...seen, promptYielded: true, verdict: "reported cost", note: "a reported cost above the reservation: charged in full" } });
  } else settled = settleCall(ctx, ledger, entry, { actualUsd: null, fields: { ...seen, promptYielded: true, verdict: "no cost", note: "no reported cost: stays at its reservation" } });

  if (!settled) {
    io.err("the campaign record could not be written after the call; its reservation stands");
    return { exitCode: EXIT.STOPPED };
  }
  if (call.gate) {
    io.err(red.text(call.gate.message));
    return { exitCode: initExitCode(call.gate) };
  }
  if (call.timedOut || call.error || !known) {
    io.err("the call ended without a reported cost; it stays at its reservation");
    return { exitCode: EXIT.STOPPED };
  }
  if (cost > can.worst.reservationUsd) io.err("the call's reported cost passed its reservation");
  const cred = hygiene([f["config-dir"], homeDir], fs);
  if (cred.length) {
    io.err(`hygiene failure: credential-named file in the config or home directory: ${cred.length}`);
    return { exitCode: EXIT.ROWS_FAILED, cost };
  }
  io.out(`AUTH_SOURCE=${call.initRecord.authSource}`);
  return { exitCode: EXIT.OK, cost };
}

// ------------------------------------------------------------------- row attempt

export async function liveRow(ctx) {
  const { f, io } = ctx;
  const def = ROWS[f.row];
  if (def.noSession) {
    io.out(`${f.row}: NOT RUN. No session exists for this row; it is the unit check in ${T3_CHECK}. Never a pass from here.`);
    throw new Refusal(`${f.row} runs no session; see ${T3_CHECK}`);
  }
  if (f["routing-blocked"] && f.row !== "T6") throw new Refusal("--routing-blocked applies to T6 only");
  return locked(ctx, () => rowAttempt(ctx, def));
}

async function rowAttempt(ctx, def) {
  const { f, argv, env, override, lifts, fs, io, red, now, repoRoot, timeoutMs, campaign } = ctx;
  const row = f.row;
  const head = readHead(repoRoot, fs);
  const ledger = readLedger(f.ledger, fs);
  const budget = bindCeilings(ctx, ledger);

  const first = checkCall(ctx, budget, null);
  if (!first.ok) throw new Refusal(`this call's worst case of ${first.worst.reservationUsd.toFixed(4)} USD would pass the ${first.reason}; nothing started`);
  checkAttempts(ledger, readRecord(campaign, fs), { row, model: f.model, head });
  checkLedgerMatchesRecord(ledger, readRecord(campaign, fs), { row, head, ledgerFile: f.ledger, recordFile: campaign.file });

  try { fs.mkdirSync(f.out, { recursive: true }); } catch { throw new Refusal("--out cannot be created", EXIT.STOPPED); }
  const findings = new FindingsLog({ dir: f.out, fs, red, now });

  let judgmentId = null;
  let savedWording = null;
  if (row === "T6") {
    const pre = t6Prerequisite(ledger, head);
    if (!pre.ok) {
      findings.add({ kind: "t6_refused", row, model: f.model, head, reason: pre.reason });
      throw new Refusal(`T6 refused: ${pre.reason}`);
    }
    judgmentId = pre.id;
    savedWording = pre.wording;
  }

  const rowSeconds = rowSecondsFrom(f);

  const client = await ctx.getClient();

  // Connector: the supplied test-account token is the only path.
  let account = { check: "not applicable (no connector in this row)", note: "" };
  let mcpServers;
  if (def.connector) {
    const [rt, cid, iss] = CONNECTOR_VARS.map((v) => env[v]);
    if (!rt || !cid || !iss) throw new Refusal(`connector input missing: ${CONNECTOR_VARS.join(", ")}`);
    red.add(rt);
    if (!f["mcp-url"]) throw new Refusal("--mcp-url is required for this row");
    assertStaging(iss, f["mcp-url"]);
    const token = await mintAccessToken({ refreshToken: rt, clientId: cid, issuer: iss, fetch: ctx.fetchImpl }); // per row
    red.add(token);
    account = checkAccount(token, f["expected-account"], f["account-label"]);
    mcpServers = mcpServersFor(token, f["mcp-url"]);
  }

  // Evidence, the working directory and the child's home, all under --out and all new.
  let evidence, homeDir, cwd;
  try {
    evidence = new Evidence({ out: f.out, row, model: f.model, now: now(), fs, red });
    const work = newUniqueDir(f.out, `work-${path.basename(evidence.dir)}`, fs);
    homeDir = path.join(work, "home");
    fs.mkdirSync(homeDir);
    if (def.cwd === "plugin") cwd = f["plugin-dir"];
    else { cwd = path.join(work, "cwd"); fs.mkdirSync(cwd); }
  } catch {
    io.err("could not create the evidence directory: no call made");
    return { exitCode: EXIT.STOPPED, evidenceFailed: true };
  }
  const childEnv = buildChildEnv(env, { configDir: f["config-dir"], homeDir, maxOutputTokens: budget.maxOutputTokens });
  // The clone must stay clean. This shows whether a child touched it; it cannot prevent that. T5's
  // working directory is the plugin directory, which is normally inside the clone.
  const beforeClone = snapshotTree(repoRoot, fs);
  const beforeTree = def.cwd === "plugin" ? snapshotTree(cwd, fs) : null;

  const summary = {
    partial: false, row, model: f.model, effort: f.effort, mode: "bare (unmeasured)", bareConfirmed: BARE_CONFIRMATION,
    command: argv, cwd, head, sessionId: null, exitCode: null,
    account: { check: account.check, note: account.note },
    override: override ? { reason: override.reason, expires: override.expires, lifts: override.lifts } : null,
    init: null, toolCalls: [], answer: "", turns: [], totalCostUsd: 0, verdict: null, notes: [], stoppedBecause: null,
    captureAttempts: [], quadContextCalls: 0, judgmentId, savedWording, signedClaim: null, routing: null, quadName: null, citesProject: null, cutOff: false,
  };
  let exitCode = EXIT.OK;
  let authFailed = false;
  let sessionId = null;
  let captureTool = null;
  let measuredTokens = null; // the largest prompt measured so far in this session
  let serverPending = false; // an init on some turn said 'pending'
  const streams = [];
  const callEntries = [];
  const tracker = new SpendTracker();
  const stop = (why, code) => { summary.partial = true; summary.stoppedBecause = why; exitCode = code; };
  const failRow = (why) => { summary.verdict = "FAIL"; summary.notes.push(why); exitCode = EXIT.ROWS_FAILED; };

  // One wall-clock limit for all of this row's turns.
  let rowTimer;
  const deadline = new Promise((r) => { rowTimer = setTimeout(r, rowSeconds * 1000); });

  try {
    for (const [i, turn] of def.turns.entries()) {
      const tools = turn.tools.map((t) => (t === CAPTURE_PLACEHOLDER ? captureTool ?? pickCaptureTool(null) : t));
      const options = sessionOptions(ctx, {
        model: f.model, effort: f.effort, sessionUsd: budget.sessionUsd, maxTurns: turn.maxTurns, tools,
        resume: i > 0 ? sessionId : undefined, settingsPath: f.settings, pluginDir: f["plugin-dir"],
        mcpServers, childEnv, cwd,
      });

      let can, entry;
      try {
        can = checkCall(ctx, budget, measuredTokens);
        if (!can.ok) { stop(`the next call's worst case would pass the ${can.reason}`, EXIT.STOPPED); break; }
        entry = reserveCall(ctx, ledger, can.worst, { id: `${path.basename(evidence.dir)}-${i + 1}`, row, turn: i + 1, head });
      } catch (e) {
        if (!(e instanceof Refusal)) throw e;
        stop(red.text(e.message), EXIT.STOPPED);
        break;
      }
      callEntries.push(entry);

      const call = await runGatedCall({
        client, options, prompt: turn.prompt, def: { ...def, model: f.model, firstTurn: i === 0 }, lifts, timeoutMs: timeoutMs ?? DEFAULT_INIT_TIMEOUT_MS, deadline,
        abortController: new AbortController(), onMessage: (m) => evidence.message(m),
      });
      const s = collect(call.messages);
      streams.push(s);
      summary.init = summary.init ?? call.initRecord;
      sessionId = s.init?.session_id ?? s.result?.session_id ?? sessionId;
      summary.sessionId = sessionId;
      if (i === 0) captureTool = pickCaptureTool(s.init?.tools);
      if (s.prompt_tokens > 0) measuredTokens = Math.max(measuredTokens ?? 0, s.prompt_tokens);

      // 'pending' passed the load check, so the row is judged here: ending with no connector call
      // after it says the connector may never have loaded, which is no result about the product.
      // The first init's 'pending' is dropped only when a wait before the prompt saw it connect: the
      // wait on an early init, or the check before the first prompt.
      const polledConnected = call.initRecord?.servers?.find((m) => m.name === SERVER_NAME)?.status === "connected" || call.initRecord?.connectorStatus?.final === "connected";
      if (initStatuses(call.messages).some((status, n) => status === "pending" && !(n === 0 && polledConnected))) serverPending = true;
      const rowEnds = i + 1 === def.turns.length || call.timedOut || call.error || s.cut_off || turnGate(row, s) !== null;
      const neverLoaded = def.connector && serverPending && rowEnds && call.promptYielded && !call.gate &&
        !streams.some(connectorCalled) && !scanToolUses(s.tool_uses, lifts).length;

      // Spend is settled before anything else happens and before the next call starts.
      let noCost = false;
      let settled;
      const seen = streamFacts(call, s);
      if (call.queryThrew) {
        noCost = true;
        settled = settleCall(ctx, ledger, entry, { actualUsd: null, fields: { ...seen, note: "the query call threw: stays at its reservation" } });
      } else if (!call.promptYielded) {
        settled = settleCall(ctx, ledger, entry, { actualUsd: 0, fields: { ...seen, note: "stopped before the prompt" } });
      } else {
        // A load failure or an interrupted call keeps its reservation, unless a larger cost is known.
        const rec = tracker.record(s.result?.session_id ?? sessionId ?? row, s.result?.total_cost_usd ?? call.highestCost);
        noCost = Boolean(rec.unknown) || ((neverLoaded || !s.result) && rec.spend <= entry.ceiling);
        settled = settleCall(ctx, ledger, entry, noCost
          ? { actualUsd: null, fields: { ...seen, promptYielded: true, note: "no reported cost: stays at its reservation" } }
          : { actualUsd: rec.spend, fields: { ...seen, promptYielded: true } });
      }
      summary.turns.push({ turn: i + 1, subtype: s.result?.subtype ?? "none", reservationUsd: can.worst.reservationUsd, spendUsd: entry.spend, costReported: !noCost, numTurns: s.result?.num_turns ?? null, ...seen });

      // Read before any stop is acted on, so a stop cannot hide them.
      const sig = scanSignals(s, String(call.error?.message ?? ""));
      if (sig.ownerUnavailable) findings.add({ kind: "capture_owner_unavailable", row, model: f.model, head, detail: "seen in a tool output or result" });
      if (sig.auth401 || call.gate?.auth) { authFailed = true; break; }

      if (!settled) { stop("the campaign record could not be written after the call; its reservation stands", EXIT.STOPPED); break; }
      if ((neverLoaded || call.gate) && entry.spend > can.worst.reservationUsd + 1e-9) summary.notes.push("a call's reported cost passed its reservation, so the bound's assumptions failed");
      if (neverLoaded) {
        const why = "load failure: the quadron server was pending in init and the row made no connector tool call";
        summary.notes.push(why);
        stop(why, EXIT.STOPPED);
        summary.verdict = LOAD_FAILURE; // not a product result: never a finding
        break;
      }
      if (call.timedOut) { stop(`row timeout after ${rowSeconds} seconds`, EXIT.STOPPED); break; }
      if (call.gate) {
        summary.notes.push(call.gate.message);
        if (call.gate.kind === "stop") stop(call.gate.message, call.gate.code);
        else failRow("the session failed a gate");
        if (call.gate.loadFailure) summary.verdict = LOAD_FAILURE; // not a product result: never a finding
        break;
      }
      if (call.error) { stop(`call failed: ${red.text(call.error?.message ?? call.error)}`, EXIT.STOPPED); break; }
      if (noCost) { stop("a call ended without a reported cost; it stays at its reservation", EXIT.STOPPED); break; }
      if (entry.spend > can.worst.reservationUsd + 1e-9) { stop("a call's reported cost passed its reservation, so the bound's assumptions failed", EXIT.STOPPED); break; }
      const bad = scanToolUses(s.tool_uses, lifts);
      if (bad.length) { failRow(`web, browser or sub-agent tool invoked: ${bad.join(", ")}`); break; }
      if (def.outsideCheck) {
        const outside = s.tool_uses.filter((u) => def.outsideCheck.includes(u.name) && !inScope(u.name, u.input, { root: cwd, fs }));
        if (outside.length) { failRow(`${outside.map((u) => u.name).join(", ")} went outside the plugin directory`); break; }
      }
      if (s.cut_off) {
        summary.cutOff = true;
        failRow(`a response was cut off at the output limit of ${budget.maxOutputTokens} tokens; the row fails, and this is not a product finding`);
        break;
      }
      if (s.result?.subtype === "error_max_budget_usd") { stop("the per-call ceiling was reached", EXIT.STOPPED); break; }
      if (i + 1 < def.turns.length) {
        const why = turnGate(row, s);
        if (why) { failRow(why); break; }
      }
    }
  } finally {
    clearTimeout(rowTimer);
  }

  // ---- verdict
  if (authFailed) {
    summary.verdict = "auth failure";
    summary.partial = true;
    summary.stoppedBecause = "auth failure";
    exitCode = EXIT.AUTH;
  } else if (summary.verdict === null && !summary.partial) {
    const v = VERDICTS[row](streams, { routingBlocked: f["routing-blocked"] ? red.text(f["routing-blocked"]) : null, judgmentId, savedWording });
    summary.verdict = v.verdict;
    summary.notes.push(...(v.notes ?? []));
    for (const k of ["judgmentId", "savedWording", "signedClaim", "routing", "quadName", "citesProject"]) if (v[k] !== undefined) summary[k] = v[k];
    if (v.verdict === "FAIL" || v.verdict === "WITHHELD" || v.verdict === "UNCONFIRMED") exitCode = EXIT.ROWS_FAILED;
    if (v.verdict === "BLOCKED-BY-BACKEND") exitCode = EXIT.BLOCKED;
  }
  if (summary.partial && summary.verdict === null) summary.verdict = "PARTIAL (not a result)";

  summary.quadContextCalls = quadContextCalls(streams);
  summary.captureAttempts = streams.flatMap((s) => s.denied_captures);
  summary.answer = streams.map((s) => s.result?.result ?? s.assistant_text ?? "").filter(Boolean).join("\n");
  summary.toolCalls = streams.flatMap((s) => s.tool_uses.map((u) => {
    const r = s.tool_results.find((x) => x.tool_use_id === u.id);
    return { name: u.name, input: u.input, result: r?.text ?? null, isError: r?.is_error ?? null };
  }));
  const initMsg = streams.find((s) => s.init)?.init;
  if (initMsg) {
    summary.init = {
      ...summary.init, authSource: initMsg.apiKeySource, version: initMsg.claude_code_version, model: initMsg.model ?? "not shown",
      plugins: initMsg.plugins ?? null, servers: initMsg.mcp_servers ?? null, fastState: initMsg.fast_mode_state ?? "not shown",
      permissionMode: initMsg.permissionMode ?? "not shown", // sdk.d.ts:6259; a record only, with no effect on any verdict
    };
  }
  summary.totalCostUsd = summary.turns.reduce((a, t) => a + t.spendUsd, 0);

  // ---- hygiene: a failure here is loud and turns any pass into a failure
  const hygieneFailures = [];
  const cred = hygiene([f["config-dir"], homeDir], fs);
  if (cred.length) hygieneFailures.push(`credential-named file in the config or home directory: ${cred.length}`);
  if (JSON.stringify(snapshotTree(repoRoot, fs)) !== JSON.stringify(beforeClone)) hygieneFailures.push("the clone changed during the row");
  if (beforeTree && JSON.stringify(snapshotTree(cwd, fs)) !== JSON.stringify(beforeTree)) hygieneFailures.push("the plugin directory changed during the row");
  for (const h of hygieneFailures) {
    summary.notes.push(h);
    io.out(`hygiene failure: ${h}`);
  }
  if (hygieneFailures.length && !authFailed) {
    if (/^PASS/.test(summary.verdict ?? "")) summary.verdict = "FAIL";
    if (exitCode === EXIT.OK) exitCode = EXIT.ROWS_FAILED;
  }

  // ---- findings, evidence and the ledger's row record
  if (!authFailed && !summary.partial && !summary.cutOff) haikuFailureFinding({ row, model: f.model, head, verdict: summary.verdict, ledger, log: findings });
  summary.findings = findings.items;
  try {
    const state = readRecord(campaign, fs);
    summary.spend = { campaignTotalUsd: recordTotal(state), campaignModelUsd: recordModelTotal(state, f.model), totalCeilingUsd: budget.totalUsd };
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    summary.spend = { campaignTotalUsd: "unreadable", totalCeilingUsd: budget.totalUsd };
  }
  if (summary.judgmentId === NOT_SHOWN && row === "T4") io.out("judgment id: not shown");
  // A failed evidence write is a run failure, so what is on disk must not say otherwise.
  const evidenceFailure = () => {
    if (!evidence.failed && !findings.writeFailed) return false;
    Object.assign(summary, { verdict: "PARTIAL (evidence write failed)", partial: true, stoppedBecause: "evidence write failed", exitCode: EXIT.STOPPED });
    exitCode = EXIT.STOPPED;
    return true;
  };
  summary.exitCode = exitCode;
  evidenceFailure();
  const safe = evidence.summary(summary);
  if (evidenceFailure()) {
    Object.assign(safe, { verdict: summary.verdict, partial: true, stoppedBecause: summary.stoppedBecause, exitCode });
  }
  if (exitCode === EXIT.STOPPED && summary.stoppedBecause === "evidence write failed") io.err("evidence could not be written: run failure");

  for (const e of callEntries) e.verdict = summary.verdict;
  const rowEntry = { kind: "row", row, model: f.model, head, verdict: summary.verdict, at: iso(now) };
  if (row === "T4") {
    Object.assign(rowEntry, { judgmentId: summary.judgmentId ?? NOT_SHOWN, savedWording: red.text(summary.savedWording ?? NOT_SHOWN, { keepPaths: true }), quadName: summary.quadName ?? NOT_SHOWN, routing: summary.routing ?? NOT_SHOWN, signedClaim: summary.signedClaim ?? { state: "absent" } });
  }
  if (row === "T6") rowEntry.judgmentId = judgmentId;
  appendEntry(f.ledger, fs, ledger, rowEntry);

  io.out(`${row}: ${safe.verdict}${summary.partial ? ` (partial: ${safe.stoppedBecause})` : ""}; call spend ${summary.totalCostUsd.toFixed(4)} USD`);
  io.out(`bare confirmed: ${BARE_CONFIRMATION}`);
  if (account.note) io.out(red.text(account.note));
  return { exitCode, summary: safe, evidenceDir: evidence.dir };
}
