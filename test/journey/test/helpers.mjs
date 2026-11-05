// Test helpers: a real temporary box, a fake SDK client shaped like the published types, and
// builders. Nothing here imports the SDK package or lib/sdk.mjs.

import * as nodefs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const KEY = "sk-test-dummy-key-0001";
export const REFRESH = "refresh-secret-value-0002";
export const ISSUER = "https://staging.quadron.tech/realms/x";
export const MCP_URL = "https://staging.quadron.tech/mcp";
export const HEAD = "a".repeat(40);
export const OPUS = "claude-opus-5-5";
export const HAIKU = "claude-haiku-5-5";
export const SESSION = "1";
export const RUN = "10";
export const TOTAL = "5";
// One call's reservation at session 1 with no measured prompt: 1 + 4096 x output + 100,000 x the
// higher of input and cache write, per million. Written out so the tests do not borrow lib's math.
export const WORST_OPUS = 1 + (4096 * 20 + 100_000 * 5) / 1_000_000; // 1.58192
export const WORST_HAIKU = 1 + (4096 * 2.5 + 100_000 * 0.625) / 1_000_000; // 1.07274
export const PIN = "0.0.1-test";
export const WORKSPACE = "test-workspace";
export const CAMPAIGN = "test-campaign";
export const SOME_HOME = "/home/someone";
const SDK_NAME = ["@anthropic-ai", "claude-agent-sdk"];

export const goodSettings = () => ({ permissions: { deny: ["WebFetch", "WebSearch", "Bash(*playwright*)"] } });

const roots = [];
process.on("exit", () => { for (const r of roots) { try { nodefs.rmSync(r, { recursive: true, force: true }); } catch { /* best effort */ } } });

// Lines of a campaign record, on the keys box() uses unless given others.
const key = (o) => ({ workspace: WORKSPACE, campaign: CAMPAIGN, ...o });
export const reserveLine = (call, usd, o = {}) => key({ type: "reserve", call, model: OPUS, reservationUsd: usd, at: "x", ...o });
export const settleLine = (call, usd, o = {}) => key({ type: "settle", call, actualUsd: usd, chargedUsd: usd, at: "x", ...o });
export const spent = (call, usd, o = {}) => [reserveLine(call, usd, o), settleLine(call, usd, { workspace: o.workspace ?? WORKSPACE, campaign: o.campaign ?? CAMPAIGN })];

// A real directory tree outside the clone: fake clone root, settings, ledger, campaign record,
// config, out, plugin, and a fake journey directory holding a pin and an "installed" package.json.
export function box({ settings = goodSettings(), entries = [], record = [] } = {}) {
  const root = nodefs.realpathSync(nodefs.mkdtempSync(path.join(tmpdir(), "journey-test-")));
  roots.push(root);
  const p = (...a) => path.join(root, ...a);
  for (const d of ["repo/.git", "cfg", "out", "plugin", "tmp"]) nodefs.mkdirSync(p(d), { recursive: true });
  nodefs.writeFileSync(p("repo/.git/HEAD"), `${HEAD}\n`);
  nodefs.writeFileSync(p("settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  nodefs.writeFileSync(p("ledger.json"), JSON.stringify({ entries }));
  nodefs.writeFileSync(p("campaign.jsonl"), record.map((l) => `${JSON.stringify(l)}\n`).join(""));
  nodefs.writeFileSync(p("plugin/SKILL.md"), "skill");
  const journey = p("journey");
  nodefs.mkdirSync(path.join(journey, "node_modules", ...SDK_NAME), { recursive: true });
  nodefs.writeFileSync(path.join(journey, "package.json"), JSON.stringify({ dependencies: { [SDK_NAME.join("/")]: PIN } }));
  nodefs.writeFileSync(path.join(journey, "node_modules", ...SDK_NAME, "package.json"), JSON.stringify({ version: PIN }));

  const b = {
    root, p,
    ledger: p("ledger.json"), out: p("out"), cfg: p("cfg"), plugin: p("plugin"), settings: p("settings.json"), repo: p("repo"), journey,
    record: p("campaign.jsonl"),
    campaign: { QUADRON_CAMPAIGN_RECORD: p("campaign.jsonl"), QUADRON_CAMPAIGN_WORKSPACE: WORKSPACE, QUADRON_CAMPAIGN_ID: CAMPAIGN },
    recordLines: () => nodefs.readFileSync(p("campaign.jsonl"), "utf8").replace(/^﻿/, "").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)),
    // What the record charges: each reservation, or its settlement when it has one.
    charged: () => {
      const lines = b.recordLines();
      return lines.filter((l) => l.type === "reserve").reduce((a, r) => a + (lines.find((s) => s.type === "settle" && s.call === r.call)?.chargedUsd ?? r.reservationUsd), 0);
    },
    entries: () => JSON.parse(nodefs.readFileSync(p("ledger.json"), "utf8")).entries,
    calls: () => b.entries().filter((e) => e.kind === "call"),
    rowsOf: () => b.entries().filter((e) => e.kind === "row"),
    sum: () => b.calls().reduce((a, e) => a + e.spend, 0),
    findings: () => {
      const f = path.join(b.out, "findings.jsonl");
      return nodefs.existsSync(f) ? nodefs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    },
    attemptDirs: () => nodefs.readdirSync(b.out).filter((n) => !n.startsWith("work-") && n !== "findings.jsonl").sort(),
    summary: (dir) => JSON.parse(nodefs.readFileSync(path.join(b.out, dir ?? b.attemptDirs()[0], "summary.json"), "utf8")),
    argv: (row, { model = OPUS, session = SESSION, run = RUN, total = TOTAL } = {}, extra = []) => ["--live",
      "--model", model, "--effort", "low", "--max-session-usd", session, "--max-run-usd", run, ...(total === null ? [] : ["--max-total-usd", total]),
      "--expected-account", "acct-test", "--ledger", b.ledger, "--row", row, "--settings", b.settings, "--plugin-dir", b.plugin,
      "--config-dir", b.cfg, "--out", b.out, "--mcp-url", MCP_URL, ...extra],
    initArgv: (extra = []) => ["--live", "--init-only", "--settings", b.settings, "--plugin-dir", b.plugin, "--config-dir", b.cfg, ...extra],
    deps: (over = {}) => {
      const io = sink();
      return { io, repoRoot: b.repo, journeyDir: journey, tmpRoot: p("tmp"), home: SOME_HOME, resolve: () => { throw new Error("not found"); },
        fetch: fetchStub(), now: () => Date.parse("2026-11-05T00:00:00Z"), ...over };
    },
  };
  return b;
}

// ---- messages (shapes per sdk.d.ts: init :6234, result :5960)
export const init = (o = {}) => ({
  type: "system", subtype: "init", session_id: "s1", apiKeySource: "ANTHROPIC_API_KEY",
  claude_code_version: "2.1.300", tools: ["Skill", "mcp__quadron__quad_context", "mcp__quadron__quad_search", "mcp__quadron__quad_recall", "mcp__quadron__quad_read", "mcp__quadron__future_you_capture"],
  mcp_servers: [{ name: "quadron", status: "connected" }], plugins: [{ name: "quadron", path: "/x" }],
  skills: [], slash_commands: [], output_style: "x", cwd: "/x", fast_mode_state: "off", ...o,
});
// An init-only form asks for no tools, so its init lists none.
export const initForm = (o = {}) => init({ tools: [], ...o });
// What an init form prints when the account object names only the auth source.
export const authOutput = (source = "ANTHROPIC_API_KEY") => [`AUTH_SOURCE=${source}`, "TOKEN_SOURCE=not shown", "SUBSCRIPTION_TYPE=not shown"];
export const result = (cost, o = {}) => ({
  type: "result", subtype: "success", session_id: "s1", result: "", num_turns: 1, total_cost_usd: cost, permission_denials: [], ...o,
});
export const toolUse = (id, name, input = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
export const assistantText = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
export const toolResult = (id, text, is_error = false, structured) => ({
  type: "user", ...(structured === undefined ? {} : { tool_use_result: structured }), message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error }] },
});

// ---- fake model. scripts[i] is, for call i, a message list, a function of the call's args giving
// one, or {messages, initResult, initTiming, reload, status, hang, noIterator}:
//   initResult: an object, null for none, "hang", or an Error. Default: built from the script's init.
//   initTiming: "before" (default when the script holds an init), or "after" the prompt.
//   initDelayMs: how long an early init message takes to arrive.
//   before: messages the stream yields while the prompt is still held.
//   reload: what reloadPlugins() answers, counted in `reloads`. The harness must never call it.
//   hang: never finishes after the prompt.
//   endsEarly: the stream is over before the prompt: nothing after an early init message comes.
//   status: what mcpServerStatus() answers, or a function of the read's number (1 first) and the
//     reconnects so far giving it; a function can throw or return a promise that never settles.
//     Reads are counted in `statusReads`.
//   reconnect: true gives a reconnectMcpServer() that succeeds, an Error one that rejects with it, and
//     "hang" one that never settles. Each call's server name is kept in `reconnects`.
// An init message that names no model or permission mode reports the requested one; a test names
// another to differ. `prompts` records each prompt the harness let out, so a test can say none was.
//
// The fake mimics dontAsk, and it never calls a callback. A tool call that needs approval and is not
// in allowedTools still appears as a tool_use, but it gets a denied tool result, whatever the script
// holds for it, and an entry in the result's permission_denials, recorded in `denials` too. A read
// tool aimed inside the working directory needs no approval. A script with no tool_use for a denial
// can hold a permission_denials entry or a permission_denied message of its own, untouched.
const READ_TOOLS = ["Read", "Glob", "Grep"];
const inCwd = (cwd, input) => {
  if (!cwd) return false;
  const target = path.resolve(cwd, input?.file_path ?? input?.path ?? ".");
  return target === cwd || target.startsWith(cwd + path.sep);
};
const needsApproval = (b, options) => !options.allowedTools?.includes(b.name) && !(READ_TOOLS.includes(b.name) && inCwd(options.cwd, b.input));
// Shapes per sdk.d.ts: SDKPermissionDenial :5792, SDKPermissionDeniedMessage :5801.
export const denial = (id, tool_name, tool_input = {}) => ({ tool_name, tool_use_id: id, tool_input });
export const permissionDenied = (id, tool_name) => ({ type: "system", subtype: "permission_denied", tool_name, tool_use_id: id, message: "denied" });

export function fakeClient(scripts) {
  const calls = [], prompts = [], denials = [], reconnects = [];
  let interrupted = 0, closed = 0, reloads = 0, statusReads = 0;
  return {
    calls, prompts, denials, reconnects,
    get statusReads() { return statusReads; },
    get interrupted() { return interrupted; },
    get closed() { return closed; },
    get reloads() { return reloads; },
    query(args) {
      const idx = calls.length;
      calls.push(args);
      const raw = scripts[idx];
      const called = typeof raw === "function" ? raw(args) : raw;
      const spec = Array.isArray(called) || called === undefined ? { messages: called ?? [] } : called;
      const requested = { model: args.options.model, permissionMode: args.options.permissionMode };
      const msgs = (spec.messages ?? []).map((m) => (m.type === "system" && m.subtype === "init" ? { ...requested, ...m } : m));
      const first = msgs[0]?.type === "system" && msgs[0]?.subtype === "init" ? msgs[0] : null;
      const earlyInit = first && spec.initTiming !== "after";
      const it = args.prompt[Symbol.asyncIterator]();
      const held = it.next().then((r) => { if (!r.done) prompts.push({ call: idx, text: r.value.message.content }); return r; });
      const q = {
        interrupt: async () => { interrupted++; },
        close: () => { closed++; },
      };
      if (spec.initResult !== "absent") {
        q.initializationResult = () => {
          const ir = spec.initResult;
          if (ir === "hang") return new Promise(() => {});
          if (ir instanceof Error) return Promise.reject(ir);
          if (ir !== undefined) return Promise.resolve(ir);
          const src = first ?? init();
          return Promise.resolve({ account: { apiKeySource: src.apiKeySource }, claude_code_version: src.claude_code_version, fast_mode_state: src.fast_mode_state });
        };
      }
      if (spec.reload !== undefined) q.reloadPlugins = async () => { reloads++; return spec.reload; };
      if (spec.status !== undefined) {
        let reads = 0;
        q.mcpServerStatus = async () => { statusReads++; reads++; return typeof spec.status === "function" ? spec.status(reads, reconnects.length) : spec.status; };
      }
      if (spec.reconnect !== undefined) {
        q.reconnectMcpServer = async (name) => {
          reconnects.push(name);
          if (spec.reconnect === "hang") await new Promise(() => {});
          if (spec.reconnect instanceof Error) throw spec.reconnect;
        };
      }
      q[Symbol.asyncIterator] = async function* () {
        for (const m of spec.before ?? []) yield m;
        if (spec.initDelayMs) await new Promise((r) => { setTimeout(r, spec.initDelayMs); });
        if (earlyInit) yield first;
        if (spec.endsEarly) return;
        const r = await held;
        if (r.done) return;
        const deniedHere = [];
        for (const m of earlyInit ? msgs.slice(1) : msgs) {
          if (m.type === "user" && m.message.content.every((b) => deniedHere.some((d) => d.tool_use_id === b.tool_use_id))) continue;
          if (m.type === "result") {
            yield { ...m, permission_denials: [...(m.permission_denials ?? []), ...deniedHere] };
            continue;
          }
          yield m;
          for (const b of m.type === "assistant" ? m.message.content : []) {
            if (b.type !== "tool_use" || !needsApproval(b, args.options)) continue;
            const d = denial(b.id, b.name, b.input ?? {});
            deniedHere.push(d);
            denials.push(d);
            yield toolResult(b.id, `Permission to use ${b.name} has been denied.`, true);
          }
        }
        if (spec.hang) await new Promise(() => {});
      };
      return q;
    },
  };
}

export const SKILL = () => toolUse("skill1", "Skill", { skill: "quadron:quadron" });
export const T2_OK = (cost = 0.1, sid = "s1") => [init({ session_id: sid, mcp_servers: [] }), SKILL(), result(cost, { session_id: sid, result: "I cannot reach your record." })];
// A T2 attempt that fails its verdict: no skill call. A pass would block another attempt at this head.
export const T2_BAD = (cost = 0.1, sid = "s1") => [init({ session_id: sid, mcp_servers: [] }), result(cost, { session_id: sid, result: "An answer." })];
export const CAPTURE = "mcp__quadron__future_you_capture";
export const OFFER = "Want me to keep it in quadron-connect: the plugin ships recall only?";
export const WORDING = "The plugin ships recall only; capture needs my approval";
export const T4_OK = ({ first = 0.1, second = 0.15, captureResult = "Saved for your review", structured, wording = WORDING } = {}) => [
  [init({ session_id: "s9" }), assistantText(OFFER), result(first, { session_id: "s9", result: OFFER })],
  [init({ session_id: "s9" }),
    toolUse("u1", CAPTURE, { quad_name: "quadron-connect", capture_type: "decision", origin: "self", decided: wording }),
    toolResult("u1", captureResult, false, structured),
    result(second, { session_id: "s9", result: "Saved." })], // cumulative on the resumed session
];
export const T5_OK = (a = 0.05, b = 0.08) => [
  [init({ session_id: "q" }), result(a, { session_id: "q", result: "A two sentence summary." })],
  [init({ session_id: "q" }), result(b, { session_id: "q", result: "I will not save text I wrote." })],
];
const ISSUE2_OFFER = "Keep this in quadron-connect: the runner keeps raw streams?";
export const ISSUE2_OK = (cost = 0.1, sid = "s2") => [init({ session_id: sid }), assistantText(ISSUE2_OFFER), result(cost, { session_id: sid, result: ISSUE2_OFFER })];
export const OFFER_N = "Want me to keep it in quadron-connect: annual pricing only, with monthly ruled out?";
export const OFFER_ROW_OFFERS = { "T4O-S": OFFER, "T4O-N": OFFER_N, "T4O-C": OFFER };
// A connector-only session: no plugin, and no Skill among its built-in tools.
export const initC = (o = {}) => init({ tools: ["ToolSearch", "mcp__quadron__quad_context", "mcp__quadron__quad_search", "mcp__quadron__quad_recall", "mcp__quadron__future_you_capture"], plugins: [], ...o });
const offerRowInit = (row, sid) => (row === "T4O-C" ? initC({ session_id: sid }) : init({ session_id: sid }));
// One offer row's turn, with `extra` ahead of the offer's result.
export const OFFER_ROW = (row, { text = OFFER_ROW_OFFERS[row], extra = [], cost = 0.1, sid = "o", resultExtra = {} } = {}) => [
  offerRowInit(row, sid), ...extra, ...(text ? [assistantText(text)] : []), result(cost, { session_id: sid, result: text ?? "An answer.", ...resultExtra }),
];
export const READ = "mcp__quadron__quad_context";
export const T6_OK = (cost = 0.1) => [init({ session_id: "t6" }), toolUse("r1", READ), toolResult("r1", `Judgment: ${WORDING}. Status: confirmed.`), result(cost, { session_id: "t6", result: "From quadron-connect: recall only." })];

export const rowEntry = (o) => ({ kind: "row", row: "T2", model: OPUS, head: HEAD, verdict: "PASS", at: "x", ...o });
export const JID = "judgment-123";
export const t6Ready = (o = {}) => [rowEntry({ row: "T4", verdict: "PASS", judgmentId: JID, savedWording: WORDING, ...o }), { kind: "confirmation", judgmentId: JID, head: HEAD, at: "x" }];
export const callEntry = (o) => ({ kind: "call", status: "closed", row: "T2", turn: 1, model: OPUS, head: HEAD, verdict: "PASS", at: "x", ceiling: 1, spend: 0.1, promptYielded: true, ...o });

// ---- connector fetch stub
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
export const jwt = (payload) => `${b64({ alg: "none" })}.${b64(payload)}.sig`;
export function fetchStub({ identity = "acct-test", tokenStatus = 200, scope = "quadron-mcp", tokenEndpoint = "https://staging.quadron.tech/token" } = {}) {
  const seen = [];
  const fn = async (url, opts) => {
    seen.push({ url: String(url), body: opts?.body ? String(opts.body) : null, redirect: opts?.redirect });
    if (String(url).endsWith("/.well-known/openid-configuration")) return { ok: true, status: 200, json: async () => ({ token_endpoint: tokenEndpoint }) };
    if (tokenStatus !== 200) return { ok: false, status: tokenStatus, json: async () => ({ error: `bad ${REFRESH}` }) };
    return { ok: true, status: 200, json: async () => ({ access_token: jwt(identity ? { preferred_username: identity } : {}), scope }) };
  };
  fn.seen = seen;
  return fn;
}

export const sink = () => {
  const out = [], err = [];
  return { out: (l) => out.push(l), err: (l) => err.push(l), lines: out, errors: err };
};

export const liveEnv = (extra = {}) => ({
  ANTHROPIC_API_KEY: KEY, PATH: "/bin", HOME: "/h",
  QUADRON_CONNECTOR_REFRESH_TOKEN: REFRESH, QUADRON_CONNECTOR_CLIENT_ID: "cid", QUADRON_CONNECTOR_ISSUER: ISSUER, ...extra,
});
