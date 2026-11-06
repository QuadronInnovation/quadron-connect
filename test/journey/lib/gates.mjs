// Checks made with the input still held, before any prompt goes out. Nothing in this file produces
// a user message, and the init-only path uses this file and nothing that does.
//
// What the types show. initializationResult() (sdk.d.ts:3067, response :4783) carries
// account.apiKeySource (:28, an open string), claude_code_version (:4820) and fast_mode_state
// (:4821). It has no plugin_errors and no server list. plugins_applied (:4807) is absent when the
// request listed no plugins, so it proves nothing here.
// Those live in the system init message (:6234), holding plugins, plugin_errors (:6279), mcp_servers
// and tools. Its comment says "at the start of each turn". Docs say the SDK sends the prompt and then
// yields init, so it may exist only once the prompt is sent.
//
// So two steps, with no prompt ever going out on less than the first:
//   - Before the prompt: initializationResult() must confirm key auth, version and fast mode, or the
//     run stops with no prompt and zero spend. Every path needs this, and the docs do not say it
//     resolves before a prompt: if it does not, every row stops here.
//   - The load check: an init message that came before the prompt, within a bounded wait, is checked
//     there. With none, the prompt goes out and the call takes the stream's first message after it
//     as the load check. A HEURISTIC on an order the first T2 confirms: anything but a clean init
//     there interrupts the call, charged at its reservation, before any output is accepted.
// reloadPlugins() is not used: its error_count has no comment saying what it counts.

import { EXIT, OBSERVED_WRITE_TOOLS, assertSessionOptions, fastModeOn, fastModeStatedOff, scanInitTools, toleratedInitTools, unexpectedInitTools, versionAtLeast } from "./guards.mjs";
import { SERVER_NAME } from "./rows.mjs";

// The one place any path starts a query.
export function openQuery(client, args) {
  assertSessionOptions(args.options);
  return client.query(args);
}

const PLUGIN_NAME = "quadron";
const KEY_SOURCE = "ANTHROPIC_API_KEY";
export const DEFAULT_INIT_TIMEOUT_MS = 60_000;
export const EARLY_INIT_WAIT_MS = 10_000;
const STATUS_POLL_MS = 250;
// How long the check before the first prompt waits for one mcpServerStatus() answer.
const STATUS_ANSWER_MS = 5_000;
// The documented MCP_TIMEOUT default: how long a pending server gets before the one reconnect.
export const MCP_PENDING_BOUND_MS = 30_000;
const ORDER_LIMIT = 20;

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export function withTimeout(p, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error("init timeout"), { timeout: true })), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

export const stopGate = (code, message, extra = {}) => ({ kind: "stop", code, message, ...extra });

// Init-only forms: 3 means an init timeout and nothing else. A row-level gate is a row failure, and
// every other stop keeps its own code or is an init gate failure.
export function initExitCode(gate) {
  if (gate.kind === "row") return EXIT.ROWS_FAILED;
  return gate.code === EXIT.STOPPED && !gate.timeout ? EXIT.INIT_GATE : gate.code;
}

// Auth source, version and fast mode, from whichever record carries them.
function checkCore({ apiKeySource, claude_code_version, fast_mode_state }, { expectNoKey }) {
  if (!expectNoKey && apiKeySource !== KEY_SOURCE) return stopGate(EXIT.AUTH, `apiKeySource is not ${KEY_SOURCE}`);
  if (!versionAtLeast(claude_code_version)) return stopGate(EXIT.STOPPED, "claude_code_version is below the version floor or absent");
  if (fastModeOn({ fast_mode_state })) return stopGate(EXIT.REFUSAL, "fast mode is not off");
  return null;
}

export function checkInitResult(r, { expectNoKey = false } = {}) {
  if (!r || !r.account) return stopGate(EXIT.STOPPED, "no init result");
  if (typeof r.account.apiKeySource !== "string" || !r.account.apiKeySource) return stopGate(EXIT.AUTH, "init result names no auth source");
  const core = checkCore({ apiKeySource: r.account.apiKeySource, claude_code_version: r.claude_code_version, fast_mode_state: r.fast_mode_state }, { expectNoKey });
  if (core) return core;
  // The field is optional in the types, so an absent value is unconfirmed, not off.
  return fastModeStatedOff(r) ? null : stopGate(EXIT.STOPPED, "the init result states no fast mode value: fast mode is unconfirmed", { fastModeUnconfirmed: true });
}

// The connector's status in init, separate from plugin_errors. "don't treat `pending` as a failure
// on its own" (code.claude.com/docs/en/agent-sdk/mcp, read 2026-11-04), so it passes the load check
// before and after the prompt, on every turn; the row is judged on whether it then reached the
// connector (see liveRow). Any other status, known or not, fails closed.
function checkConnectorStatus(status) {
  if (status === "needs-auth") return { ...stopGate(EXIT.AUTH, "quadron server needs auth"), auth: true };
  if (status === "connected" || status === "pending") return null;
  return stopGate(EXIT.STOPPED, "quadron server not connected");
}

// The init tool list against the turn's `tools`. A tool beyond them means the session is not the one
// asked for, and a turn that lists Skill cannot run without it: both are load failures, no result about
// the product. ToolSearch is not required, and connector names are recorded in the summary, not required.
// The tolerated names (see toleratedInitTools) pass, and a row's summary records them. On a row with
// `observeWrites`, Write and Edit pass when the turn's `tools` names them.
function checkTurnTools(listed, def, lifts) {
  const tools = def.tools ?? [];
  const extra = unexpectedInitTools(listed, tools, lifts, toleratedInitTools(listed, def), def.observeWrites ? OBSERVED_WRITE_TOOLS : []);
  if (extra.length) return loadFailureGate(stopGate(EXIT.STOPPED, `init lists tools outside this turn's set: ${extra.join(", ")}`));
  if (tools.includes("Skill") && !(listed ?? []).includes("Skill")) return loadFailureGate(stopGate(EXIT.STOPPED, "init does not list Skill, which this turn needs"));
  return null;
}

// First-row gate. `ev` is {source, plugins, pluginErrors, mcpServers, tools, model}. `def.model`,
// when set, is the requested model: only an init message reports one. `def.tools` is the turn's
// `tools` option; with none stated, every built-in name in init counts as unexpected.
export function checkSession(ev, def, lifts = []) {
  if ((ev.pluginErrors ?? 0) > 0) return stopGate(EXIT.STOPPED, `plugin_errors is not empty (from ${ev.source})`);
  // A row with `noPlugin` asked for a session without it, and one holding it is not the one asked for.
  const loaded = Boolean(ev.plugins?.some((p) => p.name === PLUGIN_NAME));
  if (!loaded && !def.noPlugin) return stopGate(EXIT.STOPPED, "plugin not loaded");
  if (loaded && def.noPlugin) return stopGate(EXIT.STOPPED, "plugin loaded on a row that runs without it");
  if (def.model && ev.source === "init message" && ev.model !== def.model) return stopGate(EXIT.STOPPED, "init reports a different model than the one requested");
  if (def.connector) {
    const failed = checkConnectorStatus(ev.mcpServers?.find((m) => m.name === SERVER_NAME)?.status);
    if (failed) return failed;
  }
  const bad = scanInitTools(ev.tools, lifts);
  if (bad.length) return { kind: "row", message: `init lists forbidden tools: ${bad.join(", ")}` };
  return checkTurnTools(ev.tools, def, lifts);
}

export function fromInitMessage(m) {
  return { source: "init message", plugins: m.plugins, pluginErrors: m.plugin_errors?.length ?? 0, mcpServers: m.mcp_servers, tools: m.tools, model: m.model };
}

// The same checks on an init message, wherever in the stream it arrives.
export function checkInitMessage(m, def, lifts, { expectNoKey = false } = {}) {
  return checkCore(m, { expectNoKey }) ?? checkSession(fromInitMessage(m), def, lifts);
}

// A message's type and subtype only: never its content.
export const messageLabel = (m) => [m?.type, m?.subtype].filter(Boolean).map((v) => String(v).replace(/[^\w-]/g, "_").slice(0, 40)).join(":") || "unknown";

// Reads the stream while the input is held. It stops at a result message, or when `stopOn` says so.
// `stopOn` answering "drain" keeps reading for the result an interrupt should bring: what follows
// goes to the evidence and is not accepted into `messages`. `order` holds the message labels up to
// and including the first init, with a marker where the prompt went out.
//
// A system message that is not init, ahead of init, is passed over: stopOn never sees it and it stays
// out of `messages`, because collect() reads permission_denied and hook_response messages from there
// and a message ahead of the load check accepts no output. Row forms pass `onMessage`, so it reaches
// the evidence and `order`. Init forms pass none, and it is recorded nowhere.
export function startPump(q, { onMessage, stopOn = () => false } = {}) {
  const initSeen = deferred();
  const state = { messages: [], init: null, inits: [], error: null, ended: null, finished: false, initSeen: initSeen.promise, order: [], draining: false, drained: null };
  const run = async () => {
    if (!q?.[Symbol.asyncIterator]) { state.finished = true; return; }
    try {
      for await (const m of q) {
        onMessage?.(m);
        if (state.draining) {
          if (m.type === "result") { state.drained = m; break; }
          continue;
        }
        const isInit = m.type === "system" && m.subtype === "init";
        if (!state.init && !isInit && m.type === "system") {
          if (onMessage && state.order.length < ORDER_LIMIT - 1) state.order.push(messageLabel(m)); // room stays for init
          continue;
        }
        state.messages.push(m);
        // Init is always written: the marker where the prompt went out can take the room kept above.
        if (!state.init && (isInit || state.order.length < ORDER_LIMIT)) state.order.push(messageLabel(m));
        if (isInit) state.inits.push(m);
        if (isInit && !state.init) { state.init = m; initSeen.resolve(m); }
        const stop = stopOn(m, isInit);
        if (stop === "drain") { state.draining = true; continue; }
        if (stop || m.type === "result") break;
      }
    } catch (e) {
      state.error = e;
    }
    state.finished = true;
  };
  state.ended = run();
  return state;
}

const AUTH_ERROR_RE = /\b401\b|unauthori[sz]ed|auth|credential|login/i;

// The bounded wait for an early init message. A stream that ends or fails first ends it too.
async function waitForEarlyInit(pump, timeoutMs) {
  if (pump.init) return;
  let t;
  const wait = new Promise((r) => { t = setTimeout(r, Math.min(EARLY_INIT_WAIT_MS, timeoutMs)); });
  await Promise.race([pump.initSeen, pump.ended, wait]);
  clearTimeout(t);
}

// An init message that said 'pending' is judged on the status the gate waited for.
function withSettledServer(m, ev) {
  const status = m.mcp_servers?.find((s) => s.name === SERVER_NAME)?.status;
  return status === "pending" && ev.mcpServers ? { ...m, mcp_servers: ev.mcpServers } : m;
}

// A server still connecting is 'pending' (sdk.d.ts:1288): wait for it within the timeout.
async function settleServer(q, ev, timeoutMs) {
  const until = Date.now() + timeoutMs;
  const status = () => ev.mcpServers?.find((m) => m.name === SERVER_NAME)?.status;
  while (status() === "pending" && typeof q.mcpServerStatus === "function" && Date.now() < until) {
    await sleep(Math.min(STATUS_POLL_MS, timeoutMs));
    ev.mcpServers = await withTimeout(q.mcpServerStatus(), timeoutMs);
  }
}

// One read of the connector's status (sdk.d.ts:3117, values :1288): {status}, or {unread} saying why
// there is none. The status is a label only, since it reaches the ledger.
const statusLabel = (v) => String(v).replace(/[^\w-]/g, "_").slice(0, 40);
async function readConnector(q, ms) {
  if (typeof q.mcpServerStatus !== "function") return { unread: "no method" };
  try {
    const list = await withTimeout(q.mcpServerStatus(), ms);
    if (!Array.isArray(list)) return { unread: "no answer" };
    const status = list.find((m) => m.name === SERVER_NAME)?.status;
    return { status: status === undefined ? "absent" : statusLabel(status) };
  } catch (e) {
    return { unread: e?.timeout ? "no answer" : "threw" };
  }
}

// Before a connector row's first prompt, so a server that will not connect costs no prompt and no
// attempt. Turn 1 only: a later turn's cached list can read 'pending' on a healthy server.
//   - The first read gets no answer: nothing is known, so the row goes on as it would without this
//     check, and the end-of-row rule in liveRow still catches a server that never loaded.
//   - 'pending' is polled to the bound, with an unread poll counting as still pending. Then one
//     reconnect (:3256, throws on failure) and one more read, which must say 'connected'.
//   - Anything but 'connected' stops as a load failure, keeping the auth code for 'needs-auth'. It
//     carries no `auth` mark, so the row's verdict is LOAD FAILURE rather than an auth failure.
// Returns {gate, record}. Nothing here touches a reservation: the call settles at zero through the
// same path as any other stop before the prompt.
async function connectorCheck(q, timeoutMs) {
  const answerMs = Math.min(STATUS_ANSWER_MS, timeoutMs);
  const bound = Math.min(MCP_PENDING_BOUND_MS, timeoutMs);
  const first = await readConnector(q, answerMs);
  if (first.unread) return { gate: null, record: { first: first.unread, final: first.unread } };
  let final = first.status;
  const until = Date.now() + bound;
  while (final === "pending" && Date.now() < until) {
    await sleep(Math.min(STATUS_POLL_MS, timeoutMs));
    final = (await readConnector(q, Math.max(1, Math.min(answerMs, until - Date.now())))).status ?? "pending";
  }
  if (final === "pending") {
    try {
      await withTimeout(q.reconnectMcpServer(SERVER_NAME), bound);
      const again = await readConnector(q, answerMs);
      final = again.unread ?? again.status;
    } catch {
      final = "reconnect failed";
    }
  }
  const record = { first: first.status, final };
  if (final === "connected") return { gate: null, record };
  const gate = final === "needs-auth" ? stopGate(EXIT.AUTH, "quadron server needs auth") : stopGate(EXIT.STOPPED, `quadron server did not connect before the first prompt: ${final}`);
  return { gate: loadFailureGate(gate), record };
}

// Two account fields for the init forms' stdout, named in AccountInfo on the TypeScript docs page
// (code.claude.com/docs/en/agent-sdk/typescript, "Other Types"). They are picked by name so no other
// account field, email and organization among them, can reach stdout or the evidence. They stay out of
// initRecord, which goes into a row's summary. A value is a label only: one line, nothing else in it.
const NOT_SHOWN = "not shown";
const accountLabel = (v) => (typeof v === "string" && v ? v.replace(/[^\w.-]/g, "_").slice(0, 40) : NOT_SHOWN);
const shownAccount = (account) => ({ tokenSource: accountLabel(account?.tokenSource), subscriptionType: accountLabel(account?.subscriptionType) });
export const authLines = (authSource, shown) => [`AUTH_SOURCE=${authSource}`, `TOKEN_SOURCE=${shown.tokenSource}`, `SUBSCRIPTION_TYPE=${shown.subscriptionType}`];

// Returns {gate, initRecord, accountShown, loadCheckPending}: gate null means every check that can run
// before the prompt passed and the prompt may go; loadCheckPending means no init message has been seen yet.
export async function runGates({ q, pump, def, lifts = [], timeoutMs = DEFAULT_INIT_TIMEOUT_MS, expectNoKey = false }) {
  const initRecord = { authSource: null, version: null, plugins: null, servers: null, fastState: null, gateSource: null };
  let accountShown = shownAccount(null);
  const done = (gate) => ({ gate, initRecord, accountShown });
  try {
    if (typeof q?.initializationResult !== "function") return done(stopGate(EXIT.STOPPED, "no init result"));
    const r = await withTimeout(q.initializationResult(), timeoutMs);
    accountShown = shownAccount(r?.account);
    initRecord.authSource = r?.account?.apiKeySource ?? null;
    initRecord.version = r?.claude_code_version ?? null;
    initRecord.fastState = r?.fast_mode_state ?? "not shown";
    const first = checkInitResult(r, { expectNoKey });
    if (first) return done(first);
    if (def.connector && def.firstTurn) {
      const check = await connectorCheck(q, timeoutMs);
      initRecord.connectorStatus = check.record;
      if (check.gate) return done(check.gate);
    }
    await waitForEarlyInit(pump, timeoutMs);
    if (pump.error) throw pump.error;
    // The pump passed over any system message ahead of init. Anything else ahead of it stops here,
    // whether or not an init message followed it.
    const lead = pump.messages[0];
    if (lead && !(lead.type === "system" && lead.subtype === "init")) return done(loadFailureGate(stopGate(EXIT.STOPPED, nonInitFirstMessage(lead))));
    if (!pump.init) {
      initRecord.gateSource = "no init message before the prompt";
      return { ...done(null), loadCheckPending: true };
    }
    const ev = fromInitMessage(pump.init);
    if (def.connector) await settleServer(q, ev, timeoutMs);
    initRecord.gateSource = ev.source;
    initRecord.plugins = ev.plugins ?? null;
    initRecord.servers = ev.mcpServers ?? null;
    // Every init message so far.
    for (const m of pump.inits) {
      const gate = checkInitMessage(withSettledServer(m, ev), def, lifts, { expectNoKey });
      if (gate) return done(gate);
    }
    return done(checkSession(ev, def, lifts));
  } catch (e) {
    if (e?.timeout) return done(stopGate(EXIT.STOPPED, "init timeout", { timeout: true }));
    if (AUTH_ERROR_RE.test(String(e?.message ?? ""))) return done(stopGate(EXIT.AUTH, "init failed as an auth failure"));
    return done(stopGate(EXIT.STOPPED, "init failed"));
  }
}

// The load check failed: not a product result. Auth keeps its own code; everything else stops the run.
export function loadFailureGate(gate) {
  if (gate.loadFailure) return gate;
  return { ...gate, kind: "stop", code: gate.code === EXIT.AUTH ? EXIT.AUTH : EXIT.STOPPED, loadFailure: true, message: `load failure: ${gate.message}` };
}
export const nonInitFirstMessage = (m) => `the stream's first message apart from system messages was ${messageLabel(m)}, not init`;

export function closeQuery(q) {
  try { q?.close?.(); } catch { /* closing only */ }
}
