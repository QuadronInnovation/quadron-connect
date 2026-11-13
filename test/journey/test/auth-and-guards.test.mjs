import test from "node:test";
import assert from "node:assert/strict";
import * as nodefs from "node:fs";
import path from "node:path";
import { main } from "../lib/main.mjs";
import { DISALLOWED_TOOLS, ENV_ALLOWLIST, REFUSED_ENV, assertSessionOptions, buildChildEnv, checkInstalledSdk, isLoopbackUrl, loadOverride, readHead, scanInitTools, versionAtLeast } from "../lib/guards.mjs";
import { isStagingUrl } from "../lib/connector.mjs";
import { Redactor } from "../lib/redact.mjs";
import { inScope } from "../lib/options.mjs";
import { MCP_PENDING_BOUND_MS, startPump } from "../lib/gates.mjs";
import { initOnly } from "../lib/initonly.mjs";
import { runGatedCall } from "../lib/call.mjs";
import {
  box, fakeClient, liveEnv, init, initForm, authOutput, result, toolUse, toolResult, assistantText, T2_OK, T2_BAD, T4_OK, T5_OK, T6_OK, ISSUE2_OK, fetchStub, goodSettings, KEY, REFRESH, HEAD, HAIKU, MCP_URL, READ, SKILL, SOME_HOME, CAPTURE,
  WORST_OPUS, WORST_HAIKU, spent, rowEntry, t6Ready, denial, permissionDenied, OFFER_ROW,
} from "./helpers.mjs";

const run = (b, argv, scripts, over = {}, env = liveEnv()) => {
  const client = Array.isArray(scripts) ? fakeClient(scripts) : scripts;
  const d = b.deps(over);
  return main({ argv, env: { ...b.campaign, ...env }, client, ...d }).then((r) => ({ r, client, d }));
};
const near = (a, e) => assert.ok(Math.abs(a - e) < 1e-9, `${a} vs ${e}`);
const walkFiles = (dir, out = []) => {
  for (const e of nodefs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out); else out.push(p);
  }
  return out;
};
const everything = (b, d) => [...d.io.lines, ...d.io.errors, ...walkFiles(b.out).map((p) => nodefs.readFileSync(p, "utf8")), nodefs.readFileSync(b.ledger, "utf8")].join("\n");

// ---------------------------------------------------------------- gates held before the prompt

const assertNoPrompt = (out, b) => {
  assert.deepEqual(out.client.prompts, []);
  for (const e of b.calls()) { assert.equal(e.spend, 0); assert.equal(e.promptYielded, false); }
};

test("F7. the prompt is held: a streaming input, and it goes out only after the gates pass", async () => {
  const b = box();
  const { r, client } = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(r.exitCode, 0);
  assert.equal(typeof client.calls[0].prompt, "object");
  assert.equal(typeof client.calls[0].prompt[Symbol.asyncIterator], "function");
  assert.equal(client.prompts.length, 1);
  assert.match(client.prompts[0].text, /pricing/);
});

test("F7. apiKeySource other than exactly ANTHROPIC_API_KEY: exit 4, no prompt, zero spend", async () => {
  for (const src of ["none", "oauth", "apiKeyHelper", "ANTHROPIC_API_KEY ", "anthropic_api_key"]) {
    const b = box();
    const out = await run(b, b.argv("T2"), [[init({ apiKeySource: src, mcp_servers: [] }), SKILL(), result(0.01)], T2_OK()]);
    assert.equal(out.r.exitCode, 4, src);
    assertNoPrompt(out, b);
    assert.equal(out.client.calls.length, 1);
    assert.ok(!out.r.summary.verdict.startsWith("PASS"));
  }
});

test("F7. version below the floor or absent: exit 3, no prompt; fast mode on or in cooldown: exit 2, no prompt", async () => {
  for (const v of ["2.1.200", undefined]) {
    const b = box();
    const out = await run(b, b.argv("T2"), [[init({ mcp_servers: [], claude_code_version: v })]]);
    assert.equal(out.r.exitCode, 3, String(v));
    assertNoPrompt(out, b);
  }
  for (const state of ["on", "cooldown"]) {
    const b = box();
    const out = await run(b, b.argv("T2"), [[init({ mcp_servers: [], fast_mode_state: state })]]);
    assert.equal(out.r.exitCode, 2, state);
    assertNoPrompt(out, b);
  }
  const off = box();
  assert.equal((await run(off, off.argv("T2"), [[init({ mcp_servers: [], fast_mode_state: "off" }), SKILL(), result(0.1, { result: "x" })]])).r.exitCode, 0);
});

test("F7. first-row gate: plugin_errors, plugin missing, server not connected: exit 3, no prompt; the server needing auth: exit 4", async () => {
  for (const [row, msg, code] of [
    ["T2", init({ mcp_servers: [], plugin_errors: [{ plugin: "inline[0]", type: "path-not-found", message: "x" }] }), 3],
    ["T2", init({ mcp_servers: [], plugins: [] }), 3],
    ["ISSUE2", init({ mcp_servers: [{ name: "quadron", status: "failed" }] }), 3],
    ["ISSUE2", init({ mcp_servers: [] }), 3],
    ["ISSUE2", init({ mcp_servers: [{ name: "quadron", status: "needs-auth" }] }), 4],
  ]) {
    const b = box();
    const out = await run(b, b.argv(row), [[msg, SKILL(), result(0.01)]]);
    assert.equal(out.r.exitCode, code);
    assertNoPrompt(out, b);
    assert.equal(out.client.calls.length, 1);
  }
});

test("F7. no init result, an absent method, a timeout: exit 3 and no prompt", async () => {
  for (const initResult of [null, {}, "hang", "absent", new Error("socket closed")]) {
    const b = box();
    const out = await run(b, b.argv("T2"), [{ messages: [init({ mcp_servers: [] })], initResult }], { timeoutMs: 20 });
    assert.equal(out.r.exitCode, 3, String(initResult));
    assertNoPrompt(out, b);
    assert.match(out.r.summary.stoppedBecause, /init/);
  }
});

test("F7. a rejected init that reads as auth failure: exit 4, no prompt", async () => {
  const b = box();
  const out = await run(b, b.argv("T2"), [{ messages: [init({ mcp_servers: [] })], initResult: new Error("401 unauthorized") }], { timeoutMs: 20 });
  assert.equal(out.r.exitCode, 4);
  assertNoPrompt(out, b);
});

const BAD_PLUGIN = { plugin_errors: [{ plugin: "inline[0]", type: "generic-error", message: "m" }] };
const CLEAN_RELOAD = { plugins: [{ name: "quadron", path: "/x" }], mcpServers: [], error_count: 0 };

// A load failure: the prompt went, the call was interrupted, and nothing it said was accepted.
const assertLoadFailure = (out, b, code = 3) => {
  const s = out.r.summary;
  assert.equal(out.client.prompts.length, 1);
  assert.equal(out.client.interrupted, 1);
  assert.equal(out.r.exitCode, code);
  assert.equal(s.verdict, "LOAD FAILURE");
  assert.equal(s.partial, true);
  assert.equal(s.answer, "");
  assert.deepEqual(s.toolCalls, []);
  near(b.calls()[0].spend, WORST_OPUS);
  near(b.charged(), WORST_OPUS);
  assert.deepEqual(b.findings(), []);
  assert.equal(b.rowsOf().at(-1).verdict, "LOAD FAILURE");
};

test("late init. an init message before the prompt is checked there: clean lets it go, and the order is recorded", async () => {
  const b = box();
  const out = await run(b, b.argv("T2"), [{ messages: T2_OK(), initDelayMs: 5, reload: CLEAN_RELOAD }], { timeoutMs: 200 });
  assert.equal(out.r.exitCode, 0);
  assert.equal(out.client.prompts.length, 1);
  assert.equal(out.client.interrupted, 0);
  assert.equal(out.client.reloads, 0);
  assert.equal(out.r.summary.init.gateSource, "init message");
  assert.deepEqual(out.r.summary.turns[0].messageOrder, ["system:init", "<prompt sent>"]);
  assert.deepEqual(b.calls()[0].messageOrder, ["system:init", "<prompt sent>"]);
  assert.equal("costAfterInterrupt" in out.r.summary.turns[0], false);
});

test("late init. a bad init message before the prompt holds it, zero spend: plugin_errors, tools, plugins, model, auth and fast mode", async () => {
  for (const [bad, code] of [[BAD_PLUGIN, 3], [{ tools: ["Skill", "WebFetch"] }, 1], [{ plugins: [] }, 3], [{ model: "other" }, 3], [{ apiKeySource: "oauth" }, 4], [{ fast_mode_state: "on" }, 2]]) {
    const b = box();
    const initResult = { account: { apiKeySource: "ANTHROPIC_API_KEY" }, claude_code_version: "2.1.300", fast_mode_state: "off" };
    const out = await run(b, b.argv("T2"), [{ messages: [init({ mcp_servers: [], ...bad }), SKILL(), result(0.1, { result: "x" })], initDelayMs: 5, initResult }], { timeoutMs: 200 });
    assert.equal(out.r.exitCode, code, JSON.stringify(bad));
    assertNoPrompt(out, b);
    assert.equal(b.charged(), 0);
  }
});

test("late init. no init before the prompt, and a clean init first after it: the row runs, and reloadPlugins is never called", async () => {
  const b = box();
  const out = await run(b, b.argv("T2"), [{ messages: T2_OK(), initTiming: "after", reload: CLEAN_RELOAD }], { timeoutMs: 20 });
  assert.equal(out.r.exitCode, 0);
  assert.equal(out.r.summary.verdict, "PASS");
  assert.equal(out.client.prompts.length, 1);
  assert.equal(out.client.interrupted, 0);
  assert.equal(out.client.reloads, 0);
  assert.equal(out.r.summary.init.gateSource, "first message after the prompt");
  assert.deepEqual(out.r.summary.turns[0].messageOrder, ["<prompt sent>", "system:init"]);
  near(b.charged(), 0.1);
});

test("late init. a bad init first after the prompt: interrupted at once, a load failure, charged at its reservation, no output accepted, no finding", async () => {
  for (const [bad, code] of [[BAD_PLUGIN, 3], [{ model: "other" }, 3], [{ tools: ["Skill", "WebFetch"] }, 3], [{ plugins: [] }, 3], [{ fast_mode_state: "on" }, 3], [{ claude_code_version: "1.0.0" }, 3], [{ apiKeySource: "oauth" }, 4]]) {
    const b = box();
    const initResult = { account: { apiKeySource: "ANTHROPIC_API_KEY" }, claude_code_version: "2.1.300", fast_mode_state: "off" };
    const out = await run(b, b.argv("T2"), [{ messages: [init({ mcp_servers: [], ...bad }), assistantText("from the model"), SKILL(), result(0.1, { result: "accepted?" })], initTiming: "after", initResult }], { timeoutMs: 20 });
    assertLoadFailure(out, b, code);
    assert.match(out.r.summary.stoppedBecause, /^load failure: /);
    assert.deepEqual(out.r.summary.turns[0].messageOrder, ["<prompt sent>", "system:init"]);
    assert.equal(out.r.summary.turns[0].interrupted, true);
    assert.equal(out.r.summary.turns[0].costAfterInterrupt, 0.1); // recorded, and it does not replace the reservation
    assert.equal(b.calls()[0].costAfterInterrupt, 0.1);
  }
});

test("late init. a first message after the prompt that is not init and not a system message fails the same way: the model's output and a result alike", async () => {
  const b0 = box();
  const out = await run(b0, b0.argv("T2"), [{ messages: [assistantText("from the model"), SKILL(), result(0.2, { result: "accepted?" })] }], { timeoutMs: 20 });
  assertLoadFailure(out, b0);
  assert.ok(out.r.summary.stoppedBecause.includes("assistant"));
  assert.match(out.r.summary.stoppedBecause, /not init/);
  assert.deepEqual(out.r.summary.turns[0].messageOrder, ["<prompt sent>", "assistant"]);
  assert.equal(out.r.summary.turns[0].costAfterInterrupt, 0.2);
  const b = box();
  const onlyResult = await run(b, b.argv("T2"), [{ messages: [result(0.2, { result: "accepted?" })] }], { timeoutMs: 20 });
  assertLoadFailure(onlyResult, b);
  assert.ok(onlyResult.r.summary.stoppedBecause.includes("result:success"));
  assert.match(onlyResult.r.summary.stoppedBecause, /not init/);
  assert.deepEqual(onlyResult.r.summary.turns[0].messageOrder, ["<prompt sent>", "result:success"]);
  assert.equal(onlyResult.r.summary.turns[0].costAfterInterrupt, null); // the only result came before the interrupt
});

test("late init. no init at all: a stream that ends with no message is a load failure; a hung one stops at the row timeout, interrupted; both stay charged", async () => {
  const b = box();
  const empty = await run(b, b.argv("T2"), [{ messages: [] }], { timeoutMs: 20 });
  assertLoadFailure(empty, b);
  assert.match(empty.r.summary.stoppedBecause, /no init message/);
  assert.equal(empty.r.summary.turns[0].costAfterInterrupt, null);
  const h = box();
  const hung = await run(h, h.argv("T2", {}, ["--row-timeout-seconds", "0.5"]), [{ messages: [], hang: true }], { timeoutMs: 10 });
  assert.equal(hung.r.exitCode, 3);
  assert.equal(hung.client.interrupted, 1);
  assert.match(hung.r.summary.stoppedBecause, /row timeout/);
  near(h.charged(), WORST_OPUS);
});

test("late init. a non-system message while the prompt is still held stops with no prompt and zero spend", async () => {
  const b = box();
  const out = await run(b, b.argv("T2"), [{ messages: T2_OK(), initTiming: "after", before: [assistantText("from the model")] }], { timeoutMs: 20 });
  assert.equal(out.r.exitCode, 3);
  assert.equal(out.r.summary.verdict, "LOAD FAILURE");
  assertNoPrompt(out, b);
  assert.equal(b.charged(), 0);
  assert.match(out.r.summary.stoppedBecause, /assistant/);
  assert.deepEqual(b.calls()[0].messageOrder, ["assistant"]);
});

test("late init. a load failure on Haiku after an Opus pass is no finding", async () => {
  const b = box({ entries: [rowEntry({})] });
  const out = await run(b, b.argv("T2", { model: HAIKU }), [{ messages: [assistantText("x"), result(0.1, { result: "x" })] }], { timeoutMs: 20 });
  assert.equal(out.r.summary.verdict, "LOAD FAILURE");
  assert.deepEqual(b.findings(), []);
});

test("late init. no path sends a prompt without confirmed key auth, with init coming early or late: no result, a timeout, a wrong source, a result lacking the field, an absent method, a rejection", async () => {
  const good = { claude_code_version: "2.1.300", fast_mode_state: "off" };
  for (const [initResult, code, why] of [
    [null, 3, /no init result/],
    ["hang", 3, /init timeout/],
    [{ account: { apiKeySource: "oauth" }, ...good }, 4, /apiKeySource is not ANTHROPIC_API_KEY/],
    [{ account: { apiKeySource: "none" }, ...good }, 4, /apiKeySource is not ANTHROPIC_API_KEY/],
    [{ account: {}, ...good }, 4, /names no auth source/],
    [{ ...good }, 3, /no init result/],
    ["absent", 3, /no init result/],
    [new Error("socket closed"), 3, /init failed/],
    [new Error("401 unauthorized"), 4, /auth failure/],
    [{ account: { apiKeySource: "ANTHROPIC_API_KEY" }, claude_code_version: "1.0.0" }, 3, /version floor/],
    [{ account: { apiKeySource: "ANTHROPIC_API_KEY" }, ...good, fast_mode_state: "on" }, 2, /fast mode/],
    [{ account: { apiKeySource: "ANTHROPIC_API_KEY" }, claude_code_version: "2.1.300" }, 3, /fast mode is unconfirmed/],
    [{ account: { apiKeySource: "ANTHROPIC_API_KEY" }, claude_code_version: "2.1.300", fast_mode_state: null }, 3, /fast mode is unconfirmed/],
  ]) {
    for (const initTiming of ["before", "after"]) {
      const b = box();
      const out = await run(b, b.argv("T2"), [{ messages: T2_OK(), initTiming, initResult }], { timeoutMs: 20 });
      assert.equal(out.r.exitCode, code, `${String(why)} ${initTiming}`);
      assertNoPrompt(out, b);
      assert.equal(b.charged(), 0);
      assert.match(out.r.summary.stoppedBecause, why);
    }
  }
});

test("late init. the wait is a small constant: 10 seconds", async () => {
  assert.equal((await import("../lib/gates.mjs")).EARLY_INIT_WAIT_MS, 10_000);
});

test("late init. init-only forms: plugin_errors in an early init prints no line and exits 5; with no init it prints the source and says what was not checked; with a turn it is a load failure, exit 5, charged", async () => {
  const b = box();
  const out = await run(b, b.initArgv(), [{ messages: [init(BAD_PLUGIN)], initDelayMs: 5 }], { timeoutMs: 200 });
  assert.equal(out.r.exitCode, 5);
  assert.deepEqual(out.d.io.lines, []);
  assert.deepEqual(out.client.prompts, []);
  const t = box();
  const turn = await run(t, withTurnArgv(t), [{ messages: [init(BAD_PLUGIN), result(0.25)], initDelayMs: 5 }], { timeoutMs: 200 });
  assert.equal(turn.r.exitCode, 5);
  assert.deepEqual(turn.client.prompts, []);
  assert.equal(t.calls()[0].spend, 0);
  assert.deepEqual(turn.d.io.lines, []);
  const n = box();
  const none = await run(n, n.initArgv(), [{ messages: [init()], initTiming: "after", reload: CLEAN_RELOAD }], { timeoutMs: 20 });
  assert.equal(none.r.exitCode, 0);
  assert.deepEqual(none.d.io.lines, authOutput());
  assert.match(none.d.io.errors.join(" "), /plugin_errors, tools and model were not checked/);
  assert.deepEqual(none.client.prompts, []);
  assert.equal(none.client.reloads, 0);
  const late = box();
  const bad = await run(late, withTurnArgv(late), [{ messages: [init(BAD_PLUGIN), result(0.25)], initTiming: "after" }], { timeoutMs: 20 });
  assert.equal(bad.r.exitCode, 5);
  assert.equal(bad.client.prompts.length, 1);
  assert.equal(bad.client.interrupted, 1);
  near(late.charged(), WORST_HAIKU);
  assert.deepEqual(bad.d.io.lines, []);
  const row = late.calls()[0];
  assert.equal(row.costAfterInterrupt, 0.25);
  assert.deepEqual(row.messageOrder, ["<prompt sent>", "system:init"]);
});

test("H4. every init-time plugin_errors path stops before the prompt: early, during reload, and a second init message", async () => {
  const b = box();
  const twoInits = { messages: [init({ mcp_servers: [] }), SKILL(), init({ mcp_servers: [], ...BAD_PLUGIN }), result(0.1, { result: "x" })] };
  const second = await run(b, b.argv("T2"), [twoInits]); // a later init message, after the prompt, stops the call
  assert.equal(second.r.exitCode, 3);
  assert.equal(second.client.interrupted, 1);
  const e = box();
  const early = await run(e, e.argv("T2"), [{ messages: [init({ mcp_servers: [], ...BAD_PLUGIN }), SKILL(), result(0.1)] }]);
  assert.equal(early.r.exitCode, 3);
  assertNoPrompt(early, e);
});

const server = (status) => [{ name: "quadron", status }];
const offerAfter = (initMsg) => [initMsg, assistantText("Shall I save that the runner keeps raw streams?"), result(0.1, { session_id: "s2", result: "Shall I save that the runner keeps raw streams?" })];
const readThenOffer = (initMsg) => [initMsg, toolUse("r", READ), toolResult("r", "x"), assistantText("Shall I save that the runner keeps raw streams?"), result(0.1, { session_id: "s2", result: "Shall I save that the runner keeps raw streams?" })];
const pendingInit = (o = {}) => init({ session_id: "s2", mcp_servers: server("pending"), ...o });

// Ended pending with no connector call: the prompt went and the row ran, so it is charged at its
// reservation, and what it did is no result about the product.
const assertNeverLoaded = (out, b) => {
  assert.equal(out.r.exitCode, 3);
  assert.equal(out.r.summary.verdict, "LOAD FAILURE");
  assert.equal(out.r.summary.partial, true);
  assert.match(out.r.summary.stoppedBecause, /^load failure: the quadron server was pending/);
  near(b.charged(), WORST_OPUS);
  assert.deepEqual(b.findings(), []);
  assert.equal(b.rowsOf().at(-1).verdict, "LOAD FAILURE");
};

test("status. a pending server is waited for within the timeout, through mcpServerStatus; once it connects the row is judged as usual, tool call or not", async () => {
  const b = box();
  const out = await run(b, b.argv("ISSUE2"), [{ messages: offerAfter(pendingInit()), status: server("connected") }], { timeoutMs: 500 });
  assert.equal(out.client.prompts.length, 1);
  assert.equal(out.r.exitCode, 0);
  assert.equal(out.r.summary.verdict, "PASS");
  near(b.charged(), 0.1);
  const failing = box();
  const f = await run(failing, failing.argv("ISSUE2"), [{ messages: offerAfter(pendingInit()), status: server("failed") }], { timeoutMs: 500 });
  assert.equal(f.r.exitCode, 3); // the wait itself can report the failure, before the prompt
  assertNoPrompt(f, failing);
});

test("status. pending passes the load check before the prompt with no method, and a connector call then makes it an ordinary row", async () => {
  const b = box();
  const out = await run(b, b.argv("ISSUE2"), [{ messages: readThenOffer(pendingInit()) }], { timeoutMs: 20 });
  assert.equal(out.client.prompts.length, 1);
  assert.equal(out.r.exitCode, 0);
  assert.equal(out.r.summary.verdict, "PASS");
  assert.equal(out.client.interrupted, 0);
  near(b.charged(), 0.1);
});

// A stop in the check before the first prompt: a load failure with no prompt, no spend and no attempt.
const assertStoppedBeforePrompt = (out, b, code) => {
  assert.equal(out.r.exitCode, code);
  assert.equal(out.r.summary.verdict, "LOAD FAILURE");
  assertNoPrompt(out, b);
  near(b.charged(), 0);
  assert.equal(out.r.summary.partial, true);
  assert.deepEqual(b.findings(), []);
};
const connectorRecord = (out, b) => {
  assert.deepEqual(out.r.summary.turns[0].connectorStatus, b.calls()[0].connectorStatus);
  assert.deepEqual(b.summary().turns[0].connectorStatus, b.calls()[0].connectorStatus);
  return b.calls()[0].connectorStatus;
};
const rowScript = (row) => ({
  T4: T4_OK()[0], T5: T5_OK()[0], T6: T6_OK(), ISSUE2: ISSUE2_OK(),
}[row]);

test("connector check. connected goes on the first read, on every connector row, and T2 and the init forms never ask", async () => {
  for (const row of ["T4", "T5", "T6", "ISSUE2"]) {
    const b = box({ entries: row === "T6" ? t6Ready() : [] });
    const rest = row === "T4" ? [T4_OK()[1]] : row === "T5" ? [T5_OK()[1]] : [];
    const out = await run(b, b.argv(row), [{ messages: rowScript(row), status: server("connected") }, ...rest], { timeoutMs: 500 });
    assert.equal(out.client.prompts[0].call, 0, row);
    assert.equal(out.client.statusReads, 1, row);
    assert.deepEqual(connectorRecord(out, b), { first: "connected", final: "connected" }, row);
  }
  const t2 = box();
  const a = await run(t2, t2.argv("T2"), [{ messages: T2_OK(), status: server("failed") }], { timeoutMs: 500 });
  assert.equal(a.r.exitCode, 0);
  assert.equal(a.client.statusReads, 0);
  assert.equal("connectorStatus" in t2.calls()[0], false);
  const io = box();
  const i = await run(io, io.initArgv(), [{ messages: [initForm()], status: server("failed") }], { timeoutMs: 500 });
  assert.equal(i.r.exitCode, 0);
  assert.equal(i.client.statusReads, 0);
});

test("connector check. needs-auth stops with the auth code; failed, disabled, unknown and a server absent from the list stop: load failure, no prompt, zero spend, no attempt", async () => {
  for (const [list, code, shown] of [
    [server("needs-auth"), 4, "needs-auth"], [server("failed"), 3, "failed"], [server("disabled"), 3, "disabled"], [server("reconnecting"), 3, "reconnecting"],
    [[], 3, "absent"], [[{ name: "other", status: "connected" }], 3, "absent"],
  ]) {
    const b = box();
    const out = await run(b, b.argv("ISSUE2"), [{ messages: offerAfter(init({ session_id: "s2" })), status: list }], { timeoutMs: 500 });
    assertStoppedBeforePrompt(out, b, code);
    assert.deepEqual(connectorRecord(out, b), { first: shown, final: shown });
    assert.equal(out.client.reconnects.length, 0);
    assert.equal(b.rowsOf().at(-1).verdict, "LOAD FAILURE");
  }
  // Three stops pass the two attempts Opus has, so none of them was one.
  const b = box();
  for (let n = 0; n < 3; n++) {
    assertStoppedBeforePrompt(await run(b, b.argv("ISSUE2"), [{ messages: offerAfter(init({ session_id: "s2" })), status: server("failed") }], { timeoutMs: 500 }), b, 3);
  }
  const reservations = b.recordLines().filter((l) => l.type === "reserve");
  assert.equal(reservations.length, 3); // the reservation is made and settled as for any stop before a prompt
  near(reservations[0].reservationUsd, WORST_OPUS);
  assert.ok(b.recordLines().filter((l) => l.type === "settle").every((l) => l.actualUsd === 0));
});

test("connector check. no method, no answer or a throw on the first read goes on as before, is recorded, and the end-of-row rule still catches a server that never loaded", async () => {
  for (const [label, status, shown] of [
    ["no method", undefined, "no method"],
    ["no answer", () => new Promise(() => {}), "no answer"],
    ["throw", () => { throw new Error("nope"); }, "threw"],
    ["not a list", () => "connected", "no answer"],
  ]) {
    const good = box();
    const a = await run(good, good.argv("ISSUE2"), [{ messages: readThenOffer(init({ session_id: "s2" })), status }], { timeoutMs: 20 });
    assert.equal(a.r.summary.verdict, "PASS", label);
    assert.equal(a.client.prompts.length, 1, label);
    assert.deepEqual(connectorRecord(a, good), { first: shown, final: shown }, label);
    const never = box();
    const n = await run(never, never.argv("ISSUE2"), [{ messages: offerAfter(pendingInit()), initTiming: "after", status }], { timeoutMs: 20 });
    assertNeverLoaded(n, never);
    assert.equal(n.client.reconnects.length, 0, label);
  }
});

test("connector check. pending is polled, and connected before the bound goes with no reconnect, and clears an init's pending at the end of the row", async () => {
  const b = box();
  const out = await run(b, b.argv("ISSUE2"), [{ messages: offerAfter(pendingInit()), initTiming: "after", status: (n) => server(n < 3 ? "pending" : "connected"), reconnect: true }], { timeoutMs: 500 });
  assert.equal(out.client.statusReads, 3);
  assert.deepEqual(out.client.reconnects, []);
  assert.deepEqual(connectorRecord(out, b), { first: "pending", final: "connected" });
  assert.equal(out.r.summary.verdict, "PASS");
  // A status that turns bad while pending stops at once, and an unread poll counts as still pending.
  const bad = box();
  const f = await run(bad, bad.argv("ISSUE2"), [{ messages: offerAfter(pendingInit()), status: (n) => { if (n === 2) throw new Error("x"); return server(n < 3 ? "pending" : "needs-auth"); }, reconnect: true }], { timeoutMs: 500 });
  assertStoppedBeforePrompt(f, bad, 4);
  assert.deepEqual(connectorRecord(f, bad), { first: "pending", final: "needs-auth" });
  assert.deepEqual(f.client.reconnects, []);
});

test("connector check. still pending at the bound: one reconnect by name, then one more read decides", async () => {
  assert.equal(MCP_PENDING_BOUND_MS, 30_000); // production passes a 60-second timeout, so this bound holds
  const b = box();
  const out = await run(b, b.argv("ISSUE2"), [{ messages: offerAfter(pendingInit()), status: (_, reconnected) => server(reconnected ? "connected" : "pending"), reconnect: true }], { timeoutMs: 20 });
  assert.deepEqual(out.client.reconnects, ["quadron"]);
  assert.deepEqual(connectorRecord(out, b), { first: "pending", final: "connected" });
  assert.equal(out.client.prompts.length, 1);
  assert.equal(out.r.summary.verdict, "PASS");

  for (const [label, script, final, reconnects] of [
    ["reconnect throws", { status: server("pending"), reconnect: new Error("refused") }, "reconnect failed", 1],
    ["reconnect hangs", { status: server("pending"), reconnect: "hang" }, "reconnect failed", 1],
    ["no reconnect method", { status: server("pending") }, "reconnect failed", 0],
  ]) {
    const c = box();
    const s = await run(c, c.argv("ISSUE2"), [{ messages: offerAfter(pendingInit()), ...script }], { timeoutMs: 20 });
    assertStoppedBeforePrompt(s, c, 3);
    assert.deepEqual(connectorRecord(s, c), { first: "pending", final }, label);
    assert.equal(s.client.reconnects.length, reconnects, label);
  }
  for (const [label, answer, code, final] of [
    ["still pending on the last read", () => server("pending"), 3, "pending"],
    ["needs-auth on the last read", () => server("needs-auth"), 4, "needs-auth"],
    ["failed on the last read", () => server("failed"), 3, "failed"],
    ["a throw on the last read", () => { throw new Error("x"); }, 3, "threw"],
    ["no answer on the last read", () => new Promise(() => {}), 3, "no answer"],
  ]) {
    const c = box();
    const s = await run(c, c.argv("ISSUE2"), [{ messages: offerAfter(pendingInit()), status: (_, reconnected) => (reconnected ? answer() : server("pending")), reconnect: true }], { timeoutMs: 20 });
    assertStoppedBeforePrompt(s, c, code);
    assert.deepEqual(connectorRecord(s, c), { first: "pending", final }, label);
    assert.deepEqual(s.client.reconnects, ["quadron"], label);
  }
});

test("connector check. turn 1 only: T4 and T5 turn 2 never read the status for it, and a pending list there is not a stop", async () => {
  const q = { session_id: "q" };
  for (const [row, turns] of [
    ["T4", T4_OK()],
    ["T5", [[init(q), result(0.05, { ...q, result: "Summary." })], [init(q), result(0.08, { ...q, result: "No." })]]],
  ]) {
    const b = box();
    const out = await run(b, b.argv(row), [{ messages: turns[0], status: server("connected") }, { messages: turns[1], status: server("pending") }], { timeoutMs: 500 });
    assert.equal(out.client.prompts.length, 2, row);
    assert.equal(out.client.statusReads, 1, row);
    assert.deepEqual(out.client.reconnects, [], row);
    assert.deepEqual(b.calls()[0].connectorStatus, { first: "connected", final: "connected" }, row);
    assert.equal("connectorStatus" in b.calls()[1], false, row);
    assert.equal(out.r.exitCode, 0, row);
  }
});

test("connector check. it changes no reservation: a call's record reservation is the same with the check, without it, and on a stop", async () => {
  const reservationOf = async (script, row = "ISSUE2") => {
    const b = box();
    await run(b, b.argv(row), [script], { timeoutMs: 500 });
    return b.recordLines().find((l) => l.type === "reserve");
  };
  const none = await reservationOf({ messages: ISSUE2_OK() });
  const ok = await reservationOf({ messages: ISSUE2_OK(), status: server("connected") });
  const stop = await reservationOf({ messages: ISSUE2_OK(), status: server("failed") });
  near(none.reservationUsd, WORST_OPUS);
  near(ok.reservationUsd, none.reservationUsd);
  near(stop.reservationUsd, none.reservationUsd);
});

// ---------------------------------------------------------------- the session options guard

const without = (k) => (o) => { const c = { ...o }; delete c[k]; return c; };
const STRIPPED = {
  "permission mode default": (o) => ({ ...o, permissionMode: "default" }),
  "permission mode absent": without("permissionMode"),
  "setting sources absent": without("settingSources"),
  "setting sources holding one": (o) => ({ ...o, settingSources: ["user"] }),
  "setting sources not an array": (o) => ({ ...o, settingSources: "" }),
  "strict MCP config false": (o) => ({ ...o, strictMcpConfig: false }),
  "strict MCP config absent": without("strictMcpConfig"),
  "strict MCP config truthy": (o) => ({ ...o, strictMcpConfig: "true" }),
  "settings absent": without("settings"),
  "settings empty": (o) => ({ ...o, settings: "" }),
  "settings an object": (o) => ({ ...o, settings: { permissions: {} } }),
  "tools absent": without("tools"),
  "tools a preset": (o) => ({ ...o, tools: { type: "preset", preset: "claude_code" } }),
  "extraArgs with bare": (o) => ({ ...o, extraArgs: { bare: null } }),
  "extraArgs with a bare value": (o) => ({ ...o, extraArgs: { bare: "" } }),
};
const goodOptions = () => ({ permissionMode: "dontAsk", settingSources: [], strictMcpConfig: true, settings: "/s.json", tools: [] });
const assertRefusedUnstarted = (out, b, label) => {
  assert.equal(out.r.exitCode, 2, label);
  assert.equal(out.r.refused, true, label);
  assert.equal(out.client.calls.length, 0, label);
  assert.deepEqual(out.client.prompts, [], label);
  assert.deepEqual(b.recordLines(), [], label);
  assert.deepEqual(b.calls(), [], label);
  assert.deepEqual(b.attemptDirs(), [], label);
};

test("session guard. each condition refuses alone, and options meeting all of them pass; extraArgs without bare is allowed", () => {
  assert.doesNotThrow(() => assertSessionOptions(goodOptions()));
  assert.doesNotThrow(() => assertSessionOptions({ ...goodOptions(), extraArgs: {} }));
  for (const [label, strip] of Object.entries(STRIPPED)) assert.throws(() => assertSessionOptions(strip(goodOptions())), /session options refused/, label);
  assert.throws(() => assertSessionOptions(undefined), /session options refused/);
  assert.equal(assertSessionOptions.length, 1); // it takes the options and nothing else
});

test("session guard. each condition refuses on every form, exit 2: no query, no prompt, no reservation, and nothing written", async () => {
  const withTurn = (b) => b.initArgv(["--init-only-with-turn", "--model", HAIKU, "--ledger", b.ledger, "--max-session-usd", "1", "--max-run-usd", "2"]);
  const noKey = (() => { const e = liveEnv(); delete e.ANTHROPIC_API_KEY; return e; })();
  for (const [label, testOptionsHook] of Object.entries(STRIPPED)) {
    for (const row of ["T2", "T4", "T5", "ISSUE2"]) {
      const b = box();
      assertRefusedUnstarted(await run(b, b.argv(row), [T2_OK()], { testOptionsHook }), b, `${row} ${label}`);
    }
    const t6 = box({ entries: t6Ready() });
    assertRefusedUnstarted(await run(t6, t6.argv("T6"), [T2_OK()], { testOptionsHook }), t6, `T6 ${label}`);
    const plain = box();
    assertRefusedUnstarted(await run(plain, plain.initArgv(), [[init()]], { testOptionsHook }), plain, `init-only ${label}`);
    const empty = box();
    assertRefusedUnstarted(await run(empty, empty.initArgv(["--expect-no-key"]), [[init({ apiKeySource: "none" })]], { testOptionsHook }, noKey), empty, `expect-no-key ${label}`);
    const turn = box();
    assertRefusedUnstarted(await run(turn, withTurn(turn), [[init(), result(0.01, { result: "ok" })]], { testOptionsHook }), turn, `with-turn ${label}`);
  }
});

test("session guard. a later turn with the options changed refuses before its reservation", async () => {
  const b = box();
  const hook = (o) => (o.resume ? without("settingSources")(o) : o);
  const { r, client } = await run(b, b.argv("T4"), T4_OK(), { testOptionsHook: hook });
  assert.equal(r.exitCode, 2);
  assert.equal(client.calls.length, 1);
  assert.equal(b.recordLines().filter((l) => l.type === "reserve").length, 1);
});

test("session guard. it is also where a query starts: both paths that open one refuse each stripped option set, before the client is reached", async () => {
  const client = fakeClient([[init()]]);
  for (const [label, strip] of Object.entries(STRIPPED)) {
    const options = strip(goodOptions());
    await assert.rejects(initOnly({ client, options, timeoutMs: 20 }), /session options refused/, label);
    await assert.rejects(runGatedCall({ client, options, prompt: "p", def: {}, timeoutMs: 20, abortController: new AbortController() }), /session options refused/, label);
  }
  assert.equal(client.calls.length, 0);
});

test("session guard. no override, flag or environment name lifts it, and --bare and --no-bare are unknown flags", async () => {
  const b = box();
  const file = b.p("override.json");
  nodefs.writeFileSync(file, JSON.stringify({ reason: "x", expires: "2026-11-05T01:00:00Z", lifts: ["settings_deny", "init_scan", "tool_use_scan"] }));
  const lifting = liveEnv({ CLAUDE_CODE_BARE: "1", QUADRON_ALLOW_BARE: "1", QUADRON_SKIP_GUARD: "1", QUADRON_OVERRIDE: "1" });
  for (const [label, testOptionsHook] of Object.entries(STRIPPED)) {
    const c = box();
    const ovr = c.p("override.json");
    nodefs.writeFileSync(ovr, nodefs.readFileSync(file, "utf8"));
    assertRefusedUnstarted(await run(c, c.argv("T2", {}, ["--override", ovr]), [T2_OK()], { testOptionsHook }, lifting), c, `override ${label}`);
  }
  for (const flag of ["--bare", "--no-bare"]) {
    const c = box();
    const { r, client, d } = await run(c, c.argv("T2", {}, [flag]), [T2_OK()]);
    assert.equal(r.exitCode, 2, flag);
    assert.equal(client.calls.length, 0, flag);
    assert.ok(d.io.errors.some((l) => l.includes(`unknown flag ${flag}`)), flag);
    const i = box();
    const init2 = await run(i, i.initArgv([flag]), [[init()]]);
    assert.equal(init2.r.exitCode, 2, flag);
    assert.equal(init2.client.calls.length, 0, flag);
  }
});

test("status. pending passes after the prompt too: as the first init after it, and as a second init", async () => {
  const first = box();
  const a = await run(first, first.argv("ISSUE2"), [{ messages: readThenOffer(pendingInit()), initTiming: "after" }], { timeoutMs: 20 });
  assert.equal(a.r.exitCode, 0);
  assert.equal(a.client.interrupted, 0);
  const second = box();
  const [head, ...rest] = readThenOffer(init({ session_id: "s2" }));
  const c = await run(second, second.argv("ISSUE2"), [[head, pendingInit(), ...rest]]);
  assert.equal(c.r.exitCode, 0);
  assert.equal(c.client.interrupted, 0);
  assert.equal(c.r.summary.verdict, "PASS");
});

test("status. pending on every turn: T4 and T5 turn 2 start pending, and a capture on T4's turn 2 makes T4 pass", async () => {
  const b = box();
  const [one, two] = T4_OK();
  const out = await run(b, b.argv("T4"), [one, [pendingInit({ session_id: "s9" }), ...two.slice(1)]]);
  assert.equal(out.r.exitCode, 0);
  assert.equal(out.r.summary.verdict, "PASS");
  assert.equal(out.client.calls.length, 2);
});

test("status. a connector row ending with no connector call after pending is a load failure, charged, no finding: before, after, a second init, and a turn 2", async () => {
  const noMethod = box();
  assertNeverLoaded(await run(noMethod, noMethod.argv("ISSUE2"), [offerAfter(pendingInit())]), noMethod);
  const after = box();
  assertNeverLoaded(await run(after, after.argv("ISSUE2"), [{ messages: offerAfter(pendingInit()), initTiming: "after" }], { timeoutMs: 20 }), after);
  const second = box();
  const [head, ...rest] = offerAfter(init({ session_id: "s2" }));
  assertNeverLoaded(await run(second, second.argv("ISSUE2"), [[head, pendingInit(), ...rest]]), second);
  const t5 = box();
  const out = await run(t5, t5.argv("T5"), [[init({ session_id: "q" }), result(0.05, { session_id: "q", result: "Summary." })], [pendingInit({ session_id: "q" }), result(0.08, { session_id: "q", result: "I will not save it." })]]);
  assert.equal(out.r.exitCode, 3);
  assert.equal(out.r.summary.verdict, "LOAD FAILURE");
  near(t5.charged(), 0.05 + WORST_OPUS);
});

test("status. what would be a product failure is not one when the server never got past pending: T6 with no read, T4 with no offer, a failing result, a Haiku run", async () => {
  const t6 = box({ entries: t6Ready() });
  assertNeverLoaded(await run(t6, t6.argv("T6"), [[init({ session_id: "t6", mcp_servers: server("pending") }), result(0.1, { session_id: "t6", result: "Nothing found." })]]), t6);
  const t4 = box();
  const one = await run(t4, t4.argv("T4"), [[init({ session_id: "s", mcp_servers: server("pending") }), result(0.1, { session_id: "s", result: "Noted." })], []]);
  assertNeverLoaded(one, t4);
  assert.equal(one.client.calls.length, 1);
  const err = box();
  assertNeverLoaded(await run(err, err.argv("ISSUE2"), [[pendingInit(), result(0.1, { session_id: "s2", subtype: "error_during_execution" })]]), err);
  const h = box({ entries: [rowEntry({ row: "ISSUE2" })] });
  const onHaiku = await run(h, h.argv("ISSUE2", { model: HAIKU }), [[pendingInit(), result(0.1, { session_id: "s2", result: "No offer." })]]);
  assert.equal(onHaiku.r.summary.verdict, "LOAD FAILURE");
  assert.deepEqual(h.findings(), []);
});

test("status. a refused capture counts as reaching the connector, a forbidden tool stays a FAIL, and T2 has no connector to judge", async () => {
  const b = box();
  const denied = await run(b, b.argv("ISSUE2"), [[pendingInit(), toolUse("c", CAPTURE, {}), toolResult("c", "denied", true), result(0.1, { session_id: "s2", result: "x" })]]);
  assert.equal(denied.r.summary.verdict, "FAIL");
  assert.equal(denied.r.exitCode, 1);
  const web = box();
  const w = await run(web, web.argv("ISSUE2"), [[pendingInit(), toolUse("w", "WebFetch"), result(0.1, { session_id: "s2", result: "x" })]]);
  assert.equal(w.r.summary.verdict, "FAIL");
  assert.match(w.r.summary.notes.join(" "), /web, browser/);
  const t2 = box();
  assert.equal((await run(t2, t2.argv("T2"), [T2_OK()])).r.summary.verdict, "PASS");
});

test("status. failed, disabled and any unknown status fail the load, needs-auth is the auth failure, separately from plugin_errors: before the prompt, as the first init after it, and as a second init", async () => {
  for (const [status, code] of [["failed", 3], ["disabled", 3], ["reconnecting", 3], ["CONNECTED", 3], [undefined, 3], ["needs-auth", 4]]) {
    const pre = box();
    const a = await run(pre, pre.argv("ISSUE2"), [offerAfter(init({ session_id: "s2", mcp_servers: server(status) }))]);
    assert.equal(a.r.exitCode, code, `before ${status}`);
    assertNoPrompt(a, pre);
    const post = box();
    const c = await run(post, post.argv("ISSUE2"), [{ messages: offerAfter(init({ session_id: "s2", mcp_servers: server(status) })), initTiming: "after" }], { timeoutMs: 20 });
    assert.equal(c.r.exitCode, code, `after ${status}`);
    assert.equal(c.r.summary.verdict, code === 4 ? "auth failure" : "LOAD FAILURE", `after ${status}`);
    near(post.charged(), WORST_OPUS);
    const twice = box();
    const [head, ...rest] = readThenOffer(init({ session_id: "s2" }));
    const d = await run(twice, twice.argv("ISSUE2"), [[head, init({ session_id: "s2", mcp_servers: server(status) }), ...rest]]);
    assert.equal(d.r.exitCode, code, `second ${status}`);
    assert.equal(d.client.interrupted, 1, `second ${status}`);
    assert.equal(d.r.summary.verdict, code === 4 ? "auth failure" : "PARTIAL (not a result)", `second ${status}`);
    near(twice.charged(), WORST_OPUS);
  }
  const nameless = box();
  assert.equal((await run(nameless, nameless.argv("ISSUE2"), [offerAfter(init({ session_id: "s2", mcp_servers: [] }))])).r.exitCode, 3);
  const plugin = box();
  const p = await run(plugin, plugin.argv("ISSUE2"), [offerAfter(pendingInit(BAD_PLUGIN))]);
  assert.equal(p.r.exitCode, 3); // pending does not excuse a plugin error
  assert.match(p.r.summary.stoppedBecause, /plugin_errors/);
  assertNoPrompt(p, plugin);
});

// ---------------------------------------------------------------- fast mode in the init result

test("fast mode. an absent or null state in the init result refuses with no prompt and zero spend: a row, plain init-only, with a turn; only a stated off passes", async () => {
  const stated = (o) => ({ account: { apiKeySource: "ANTHROPIC_API_KEY" }, claude_code_version: "2.1.300", ...o });
  for (const o of [{}, { fast_mode_state: null }]) {
    const row = box();
    const a = await run(row, row.argv("T2"), [{ messages: T2_OK(), initResult: stated(o) }], { timeoutMs: 20 });
    assert.equal(a.r.exitCode, 3);
    assertNoPrompt(a, row);
    assert.equal(row.charged(), 0);
    const plain = box();
    const c = await run(plain, plain.initArgv(), [{ messages: [init()], initResult: stated(o) }], { timeoutMs: 20 });
    assert.equal(c.r.exitCode, 5);
    assert.deepEqual(c.d.io.lines, authOutput()); // the source is stated, and it still fails
    assert.deepEqual(c.client.prompts, []);
    const turn = box();
    const t = await run(turn, withTurnArgv(turn), [{ messages: [init(), result(0.25)], initResult: stated(o) }], { timeoutMs: 20 });
    assert.equal(t.r.exitCode, 5);
    assert.deepEqual(t.client.prompts, []);
    assert.equal(turn.charged(), 0);
    assert.deepEqual(t.d.io.lines, []);
  }
  const off = box();
  assert.equal((await run(off, off.argv("T2"), [{ messages: T2_OK(), initResult: stated({ fast_mode_state: "off" }) }])).r.exitCode, 0);
  const missing = box(); // the init message's field stays optional: the rule is on the init result
  const m = await run(missing, missing.argv("T2"), [{ messages: [init({ mcp_servers: [], fast_mode_state: undefined }), SKILL(), result(0.1, { result: "x" })], initResult: stated({ fast_mode_state: "off" }) }]);
  assert.equal(m.r.exitCode, 0);
  const on = box();
  assert.equal((await run(on, on.initArgv(), [{ messages: [init()], initResult: stated({ fast_mode_state: "cooldown" }) }])).r.exitCode, 2);
});

test("fast mode. the no-prompt init forms print a stated source before stopping on an absent or null state: the line, exit 5, zero prompts; with no init result, or a source not stated, no line", async () => {
  const noKey = liveEnv(); delete noKey.ANTHROPIC_API_KEY;
  const forms = [["plain", [], liveEnv(), "ANTHROPIC_API_KEY"], ["no key", ["--expect-no-key"], noKey, "none"]];
  for (const [name, extra, env, source] of forms) {
    for (const state of [{}, { fast_mode_state: null }]) {
      const b = box();
      const out = await run(b, b.initArgv(extra), [{ messages: [init()], initResult: { account: { apiKeySource: source }, claude_code_version: "2.1.300", ...state } }], { timeoutMs: 20 }, env);
      assert.equal(out.r.exitCode, 5, name);
      assert.deepEqual(out.d.io.lines, authOutput(source), name);
      assert.deepEqual(out.client.prompts, [], name);
      assert.match(out.d.io.errors.join(" "), /fast mode is unconfirmed/, name);
    }
    const none = box();
    const n = await run(none, none.initArgv(extra), [{ messages: [init()], initResult: null }], { timeoutMs: 20 }, env);
    assert.equal(n.r.exitCode, 5, name);
    assert.deepEqual(n.d.io.lines, [], name);
    assert.deepEqual(n.client.prompts, [], name);
    const noSource = box();
    const s = await run(noSource, noSource.initArgv(extra), [{ messages: [init()], initResult: { account: {}, claude_code_version: "2.1.300" } }], { timeoutMs: 20 }, env);
    assert.equal(s.r.exitCode, 4, name);
    assert.deepEqual(s.d.io.lines, [], name);
  }
});

// ---------------------------------------------------------------- before the prompt

test("before the prompt. a stream already over stops with no prompt, exit 3, zero spend and no attempt, with or without an init message", async () => {
  for (const messages of [T2_OK(), []]) {
    const b = box();
    const out = await run(b, b.argv("T2"), [{ messages, endsEarly: true }], { timeoutMs: 20 });
    assert.equal(out.r.exitCode, 3);
    assertNoPrompt(out, b);
    assert.equal(b.charged(), 0);
    assert.match(out.r.summary.stoppedBecause, /stream ended before the prompt/);
    assert.equal(out.client.interrupted, 0);
    // No attempt was used: two real ones remain.
    assert.equal((await run(b, b.argv("T2"), [T2_BAD(0.1, "x")])).r.exitCode, 1);
    assert.equal((await run(b, b.argv("T2"), [T2_OK(0.1, "y")])).r.exitCode, 0);
  }
  const t = box();
  const turn = await run(t, withTurnArgv(t), [{ messages: [initForm(), result(0.25)], endsEarly: true }], { timeoutMs: 20 });
  assert.equal(turn.r.exitCode, 5); // init forms keep 3 for a timeout alone
  assert.deepEqual(turn.client.prompts, []);
  assert.equal(t.charged(), 0);
  const plain = box(); // no prompt on this form to hold back, and a check by hand reads its line
  const i = await run(plain, plain.initArgv(), [{ messages: [], endsEarly: true }], { timeoutMs: 20 });
  assert.equal(i.r.exitCode, 0);
  assert.deepEqual(i.d.io.lines, authOutput());
});

test("before the prompt. a non-system message ahead of init stops as a load failure, with no prompt, zero spend and no attempt, even when init follows", async () => {
  const label = "assistant";
  const b = box();
  const out = await run(b, b.argv("T2"), [{ messages: T2_OK(), before: [assistantText("from the model")] }], { timeoutMs: 200 });
  assert.equal(out.r.exitCode, 3, label);
  assert.equal(out.r.summary.verdict, "LOAD FAILURE", label);
  assertNoPrompt(out, b);
  assert.equal(b.charged(), 0);
  assert.ok(out.r.summary.stoppedBecause.includes(label));
  assert.match(out.r.summary.stoppedBecause, /not init/);
  assert.deepEqual(b.calls()[0].messageOrder, [label, "system:init"]);
  assert.deepEqual(b.findings(), []);
  assert.equal((await run(b, b.argv("T2"), [T2_BAD(0.1, "x")])).r.exitCode, 1);
  assert.equal((await run(b, b.argv("T2"), [T2_OK(0.1, "y")])).r.exitCode, 0);
  const i = box();
  const only = await run(i, i.initArgv(), [{ messages: [initForm()], before: [assistantText("from the model")] }], { timeoutMs: 200 });
  assert.equal(only.r.exitCode, 5);
  assert.deepEqual(only.d.io.lines, []);
});

// ---------------------------------------------------------------- system messages ahead of init

const HOOK_STARTED = { type: "system", subtype: "hook_started" };
const HOOK_RESPONSE = { type: "system", subtype: "hook_response", output: "from a hook" };
const EARLY_DENIAL = permissionDenied("early", CAPTURE);

test("pre-init system. the pump passes over a system message ahead of init and keeps it out of its messages; one after init stays", async () => {
  const stream = (async function* () { yield HOOK_STARTED; yield HOOK_RESPONSE; yield EARLY_DENIAL; yield init(); yield HOOK_RESPONSE; yield result(0.1); })();
  const seen = [];
  const pump = startPump(stream, { onMessage: (m) => seen.push(m) });
  await pump.ended;
  assert.deepEqual(pump.messages.map((m) => m.subtype), ["init", "hook_response", "success"]);
  assert.equal(seen.length, 6); // the row form's evidence still gets them
  assert.deepEqual(pump.order, ["system:hook_started", "system:hook_response", "system:permission_denied", "system:init"]);
  const unrecorded = startPump((async function* () { yield HOOK_STARTED; yield init(); })());
  await unrecorded.ended;
  assert.deepEqual(unrecorded.order, ["system:init"]); // an init form passes none
});

test("pre-init system. while the prompt is held, a row passes over them, records them in evidence, and collect() reads no denial or hook output from them", async () => {
  const b = box();
  const out = await run(b, b.argv("T2"), [{ messages: T2_OK(), before: [HOOK_STARTED, HOOK_RESPONSE, EARLY_DENIAL] }], { timeoutMs: 200 });
  assert.equal(out.r.exitCode, 0);
  assert.equal(out.r.summary.verdict, "PASS");
  assert.equal(out.client.prompts.length, 1);
  assert.deepEqual(out.r.summary.captureAttempts, []);
  assert.deepEqual(b.calls()[0].messageOrder, ["system:hook_started", "system:hook_response", "system:permission_denied", "system:init", "<prompt sent>"]);
  const stream = nodefs.readFileSync(path.join(b.out, b.attemptDirs()[0], "stream.jsonl"), "utf8");
  assert.match(stream, /hook_started/);
  assert.match(stream, /from a hook/);
});

test("pre-init system. after the prompt, the load check is the first message apart from them: init passes, an assistant message stops", async () => {
  const b = box();
  const [head, ...rest] = T2_OK();
  const ok = await run(b, b.argv("T2"), [{ messages: [HOOK_STARTED, head, ...rest] }], { timeoutMs: 20 });
  assert.equal(ok.r.exitCode, 0);
  assert.equal(ok.client.interrupted, 0);
  assert.equal(ok.r.summary.init.gateSource, "first message after the prompt");
  assert.deepEqual(ok.r.summary.turns[0].messageOrder, ["<prompt sent>", "system:hook_started", "system:init"]);
  const c = box();
  const bad = await run(c, c.argv("T2"), [{ messages: [HOOK_STARTED, assistantText("from the model"), SKILL(), result(0.2, { result: "accepted?" })] }], { timeoutMs: 20 });
  assertLoadFailure(bad, c);
  assert.ok(bad.r.summary.stoppedBecause.includes("assistant"));
  const d = box();
  const ended = await run(d, d.argv("T2"), [{ messages: [HOOK_STARTED] }], { timeoutMs: 20 });
  assertLoadFailure(ended, d);
  assert.match(ended.r.summary.stoppedBecause, /no init message/);
});

test("pre-init system. the init forms pass over them, unrecorded: no line changes and no label reaches the ledger", async () => {
  const i = box();
  const plain = await run(i, i.initArgv(), [{ messages: [initForm()], before: [HOOK_STARTED, HOOK_RESPONSE] }], { timeoutMs: 200 });
  assert.equal(plain.r.exitCode, 0);
  assert.deepEqual(plain.d.io.lines, authOutput());
  assert.deepEqual(plain.client.prompts, []);
  const t = box();
  const turn = await run(t, withTurnArgv(t), [{ messages: [initForm(), result(0.25)], before: [HOOK_STARTED, HOOK_RESPONSE] }], { timeoutMs: 200 });
  assert.equal(turn.r.exitCode, 0);
  assert.deepEqual(t.calls()[0].messageOrder, ["system:init", "<prompt sent>"]);
  assert.ok(!nodefs.readFileSync(t.ledger, "utf8").includes("hook_"));
});

// ---------------------------------------------------------------- the fixed tool set

const q = (name) => `mcp__quadron__${name}`;
const TOOLS_TABLE = {
  T2: [["Skill", "ToolSearch"]],
  T4: [["Skill", "ToolSearch"], ["Skill", "ToolSearch"]],
  T5: [["Skill", "ToolSearch", "Read", "Glob", "Grep"], ["Skill", "ToolSearch", "Read", "Glob", "Grep"]],
  T6: [["Skill", "ToolSearch"]],
  ISSUE2: [["Skill", "ToolSearch"]],
  "T4O-S": [["Skill", "ToolSearch"]],
  "T4O-N": [["Skill", "ToolSearch"]],
  "T4O-C": [["ToolSearch"]],
};
const ALLOWED_TABLE = {
  T2: [["Skill", "ToolSearch"]],
  T4: [["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")], ["Skill", "ToolSearch", CAPTURE]],
  T5: [["Skill", "ToolSearch"], ["Skill", "ToolSearch"]],
  T6: [["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall"), q("quad_read")]],
  ISSUE2: [["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")]],
  "T4O-S": [["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")]],
  "T4O-N": [["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")]],
  "T4O-C": [["ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")]],
};
const rowBox = (row) => box(row === "T6" ? { entries: t6Ready() } : {});
const ROW_SCRIPTS = {
  T2: () => [T2_OK()], T4: () => T4_OK(), T5: () => T5_OK(), T6: () => [T6_OK()], ISSUE2: () => [ISSUE2_OK()],
  "T4O-S": () => [OFFER_ROW("T4O-S")], "T4O-N": () => [OFFER_ROW("T4O-N")], "T4O-C": () => [OFFER_ROW("T4O-C")],
};

test("tools. every row's turns state the fixed `tools` and `allowedTools`; connector names and the capture tool stay out of `tools`; the init forms state none", async () => {
  for (const [row, expected] of Object.entries(TOOLS_TABLE)) {
    const b = rowBox(row);
    const { r, client } = await run(b, b.argv(row), ROW_SCRIPTS[row]());
    assert.equal(r.exitCode, 0, row);
    assert.deepEqual(client.calls.map((c) => c.options.tools), expected, row);
    assert.deepEqual(client.calls.map((c) => c.options.allowedTools), ALLOWED_TABLE[row], row);
    assert.equal(client.calls.some((c) => "extraArgs" in c.options), false, row);
  }
  const i = box();
  const plain = await run(i, i.initArgv(), [[initForm()]]);
  assert.deepEqual(plain.client.calls[0].options.tools, []);
  assert.deepEqual(plain.client.calls[0].options.allowedTools, []);
  const t = box();
  const turn = await run(t, withTurnArgv(t), [[initForm(), result(0.25)]]);
  assert.deepEqual(turn.client.calls[0].options.tools, []);
  assert.deepEqual(turn.client.calls[0].options.allowedTools, []);
});

test("tools. the disallowed list holds the docs' tools that run commands or reach out, and none of them is in any row's `tools`", () => {
  for (const name of ["Bash", "PowerShell", "Monitor", "WebFetch", "WebSearch", "RemoteTrigger", "Workflow"]) {
    assert.ok(DISALLOWED_TOOLS.includes(name), name);
    for (const turns of Object.values(TOOLS_TABLE)) for (const tools of turns) assert.ok(!tools.includes(name), name);
  }
});

const SHELLS = ["Bash", "PowerShell", "Monitor"];

test("load check. init listing a shell tool, before the prompt: a load failure, no prompt, zero spend, even under the init_scan lift", async () => {
  const ov = (b) => {
    nodefs.writeFileSync(b.p("ov.json"), JSON.stringify({ reason: "x", expires: "2026-11-05T01:00:00Z", lifts: ["init_scan"] }));
    return ["--override", b.p("ov.json")];
  };
  for (const name of SHELLS) {
    for (const lifted of [false, true]) {
      const b = box();
      const argv = b.argv("T2", {}, lifted ? ov(b) : []);
      const out = await run(b, argv, [[init({ mcp_servers: [], tools: ["Skill", name] }), SKILL(), result(0.1, { result: "x" })]]);
      assert.equal(out.r.exitCode, 3, name);
      assert.equal(out.r.summary.verdict, "LOAD FAILURE", name);
      assert.ok(out.r.summary.stoppedBecause.includes(name), name);
      assertNoPrompt(out, b);
      assert.equal(b.charged(), 0);
    }
    const i = box();
    const form = await run(i, i.initArgv(), [[initForm({ tools: [name] })]]);
    assert.equal(form.r.exitCode, 5, name);
    assert.deepEqual(form.d.io.lines, [], name);
  }
});

test("load check. init listing a shell tool or any other built-in after the prompt: a load failure charged at its reservation, no output accepted", async () => {
  for (const name of [...SHELLS, "Read", "Write"]) {
    const b = box();
    const out = await run(b, b.argv("T2"), [{ messages: [init({ mcp_servers: [], tools: ["Skill", name] }), assistantText("from the model"), SKILL(), result(0.1, { result: "accepted?" })], initTiming: "after" }], { timeoutMs: 20 });
    assertLoadFailure(out, b);
    assert.ok(out.r.summary.stoppedBecause.includes(name), name);
  }
});

test("load check. the init_scan lift excuses only what that scan catches, and without the lift those names keep the row's exit 1", async () => {
  const b = box();
  nodefs.writeFileSync(b.p("ov.json"), JSON.stringify({ reason: "x", expires: "2026-11-05T01:00:00Z", lifts: ["init_scan"] }));
  const out = await run(b, b.argv("T2", {}, ["--override", b.p("ov.json")]), [[init({ mcp_servers: [], tools: ["Skill", "WebFetch", "mcp__chrome__open"] }), SKILL(), result(0.01, { result: "x" })]]);
  assert.equal(out.r.exitCode, 0);
  const c = box();
  const scan = await run(c, c.argv("T2"), [[init({ mcp_servers: [], tools: ["Skill", "WebFetch"] })]]);
  assert.equal(scan.r.exitCode, 1);
  assert.deepEqual(scan.client.prompts, []);
  assert.notEqual(scan.r.summary.verdict, "LOAD FAILURE");
});

test("load check. a name from another MCP server that the scan does not catch is a load failure", async () => {
  const b = box();
  const out = await run(b, b.argv("T2"), [[init({ mcp_servers: [], tools: ["Skill", "mcp__other__tool"] })]]);
  assert.equal(out.r.exitCode, 3);
  assert.equal(out.r.summary.verdict, "LOAD FAILURE");
  assert.match(out.r.summary.stoppedBecause, /mcp__other__tool/);
});

test("load check. init missing Skill is a load failure naming it, not a row FAIL: no prompt and no spend before it, only the charged reservation after it", async () => {
  const b = box();
  const before = await run(b, b.argv("T2"), [[init({ mcp_servers: [], tools: ["ToolSearch"] }), result(0.1, { result: "x" })]]);
  assert.equal(before.r.exitCode, 3);
  assert.equal(before.r.summary.verdict, "LOAD FAILURE");
  assert.match(before.r.summary.stoppedBecause, /Skill/);
  assertNoPrompt(before, b);
  assert.equal(b.charged(), 0);
  const c = box();
  const after = await run(c, c.argv("T2"), [{ messages: [init({ mcp_servers: [], tools: ["ToolSearch"] }), assistantText("from the model"), result(0.1, { result: "accepted?" })], initTiming: "after" }], { timeoutMs: 20 });
  assertLoadFailure(after, c);
  assert.match(after.r.summary.stoppedBecause, /Skill/);
  const none = box();
  const noList = await run(none, none.argv("T2"), [[init({ mcp_servers: [], tools: undefined })]]);
  assert.equal(noList.r.summary.verdict, "LOAD FAILURE");
});

test("load check. the second turn is held to it too: Skill gone from a resumed session's init is a load failure", async () => {
  const b = box();
  const [first] = T4_OK();
  const out = await run(b, b.argv("T4"), [first, { messages: [init({ session_id: "s9", tools: ["ToolSearch", CAPTURE] }), result(0.2, { session_id: "s9", result: "x" })], initTiming: "after" }], { timeoutMs: 20 });
  assert.equal(out.r.exitCode, 3);
  assert.equal(out.r.summary.verdict, "LOAD FAILURE");
  assert.equal(out.client.prompts.length, 2);
});

test("load check. ToolSearch missing passes; a healthy init passes; connector names are recorded and not required; the built-in plugins pass and are recorded", async () => {
  const b = box();
  const noSearch = await run(b, b.argv("T2"), [[init({ mcp_servers: [], tools: ["Skill"] }), SKILL(), result(0.1, { result: "x" })]]);
  assert.equal(noSearch.r.exitCode, 0);
  assert.deepEqual(noSearch.r.summary.init.mcpTools, []);
  const plugins = [{ name: "quadron", path: "/x" }, { name: "cc-plugin-agents-md", path: "/y" }, { name: "cc-plugin-plugin-authoring", path: "/z" }];
  const tools = ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall"), q("quad_read")];
  const c = box();
  const [head, ...rest] = ISSUE2_OK();
  const healthy = await run(c, c.argv("ISSUE2"), [[{ ...head, tools, plugins }, ...rest]]);
  assert.equal(healthy.r.exitCode, 0);
  assert.deepEqual(healthy.r.summary.init.mcpTools, tools.slice(2));
  assert.deepEqual(healthy.r.summary.init.plugins.map((p) => p.name), plugins.map((p) => p.name));
  assert.deepEqual(healthy.client.calls[0].options.skills, ["quadron:quadron"]);
  const d = box();
  const noMcp = await run(d, d.argv("ISSUE2"), [[{ ...head, tools: ["Skill", "ToolSearch"] }, ...rest]]);
  assert.equal(noMcp.r.exitCode, 0);
  assert.deepEqual(noMcp.r.summary.init.mcpTools, []);
  const t5 = box();
  const reads = await run(t5, t5.argv("T5"), T5_OK().map(([i, ...more]) => [{ ...i, tools: ["Skill", "ToolSearch", "Read", "Glob", "Grep"] }, ...more]));
  assert.equal(reads.r.exitCode, 0);
});

test("load check. the init forms require no Skill and let it pass when listed; any other built-in listed fails them", async () => {
  const b = box();
  assert.equal((await run(b, b.initArgv(), [[initForm()]])).r.exitCode, 0);
  const c = box();
  assert.equal((await run(c, c.initArgv(), [[initForm({ tools: [q("quad_context")] })]])).r.exitCode, 0);
  const d = box();
  const skill = await run(d, d.initArgv(), [[initForm({ tools: ["Skill"] })]]);
  assert.equal(skill.r.exitCode, 0);
  assert.deepEqual(skill.d.io.lines, authOutput());
  const t = box();
  const turn = await run(t, withTurnArgv(t), [{ messages: [initForm({ tools: ["Skill"] }), result(0.25)], initTiming: "after" }], { timeoutMs: 20 });
  assert.equal(turn.r.exitCode, 0);
  near(t.charged(), 0.25);
  const e = box();
  assert.equal((await run(e, e.initArgv(), [[initForm({ tools: ["Read"] })]])).r.exitCode, 5);
  const u = box();
  const late = await run(u, withTurnArgv(u), [{ messages: [initForm({ tools: ["Skill", "Read"] }), result(0.25)], initTiming: "after" }], { timeoutMs: 20 });
  assert.equal(late.r.exitCode, 5);
  near(u.charged(), WORST_HAIKU);
});

const CONNECTOR_EXTRAS = ["ListMcpResourcesTool", "ReadMcpResourceTool", "WaitForMcpServers"];
const WRITES_OR_RUNS = ["Bash", "PowerShell", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Monitor"];
const CAUGHT_BY_SCAN = ["WebFetch", "WebSearch"];
const withInitTools = (extra) => (script) => script.map(([i, ...more]) => [{ ...i, tools: [...i.tools, ...extra] }, ...more]);

test("load split. the three connector tools on every connector row pass and are recorded in the summary; a row without them records none", async () => {
  for (const row of ["T4", "T5", "T6", "ISSUE2"]) {
    const b = rowBox(row);
    const out = await run(b, b.argv(row), withInitTools(CONNECTOR_EXTRAS)(ROW_SCRIPTS[row]()));
    assert.equal(out.r.exitCode, 0, row);
    assert.deepEqual(b.summary().init.toleratedTools, CONNECTOR_EXTRAS, row);
    assert.ok(!b.summary().init.mcpTools.some((t) => CONNECTOR_EXTRAS.includes(t)), row);
  }
  const plain = box();
  await run(plain, plain.argv("ISSUE2"), [ISSUE2_OK()]);
  assert.deepEqual(plain.summary().init.toleratedTools, []);
});

test("load split. the same three on T2 refuse, before the prompt and after it, and the init_scan lift does not excuse them; on an init form they refuse too", async () => {
  for (const name of CONNECTOR_EXTRAS) {
    const b = box();
    const before = await run(b, b.argv("T2"), [[init({ mcp_servers: [], tools: ["Skill", name] }), SKILL(), result(0.1, { result: "x" })]]);
    assert.equal(before.r.exitCode, 3, name);
    assert.equal(before.r.summary.verdict, "LOAD FAILURE", name);
    assert.ok(before.r.summary.stoppedBecause.includes(name), name);
    assertNoPrompt(before, b);
    const c = box();
    const after = await run(c, c.argv("T2"), [{ messages: [init({ mcp_servers: [], tools: ["Skill", name] }), assistantText("from the model"), result(0.1, { result: "accepted?" })], initTiming: "after" }], { timeoutMs: 20 });
    assertLoadFailure(after, c);
    const l = box();
    nodefs.writeFileSync(l.p("ov.json"), JSON.stringify({ reason: "x", expires: "2026-11-05T01:00:00Z", lifts: ["init_scan"] }));
    const lifted = await run(l, l.argv("T2", {}, ["--override", l.p("ov.json")]), [[init({ mcp_servers: [], tools: ["Skill", name] })]]);
    assert.equal(lifted.r.summary.verdict, "LOAD FAILURE", name);
    const i = box();
    const form = await run(i, i.initArgv(), [[initForm({ tools: [name] })]]);
    assert.equal(form.r.exitCode, 5, name);
    assert.deepEqual(form.d.io.lines, [], name);
  }
});

test("load split. a tool that writes, runs commands or reaches out, after the prompt, is a load failure on T2 and on a connector row alike", async () => {
  for (const name of WRITES_OR_RUNS) {
    for (const [row, base] of [["T2", { mcp_servers: [] }], ["ISSUE2", {}]]) {
      const b = box();
      const out = await run(b, b.argv(row), [{ messages: [init({ ...base, tools: ["Skill", name] }), assistantText("from the model"), result(0.1, { result: "accepted?" })], initTiming: "after" }], { timeoutMs: 20 });
      assertLoadFailure(out, b);
      assert.ok(out.r.summary.stoppedBecause.includes(name), `${row} ${name}`);
    }
  }
});

test("load split. the same tools before the prompt never let it go: a load failure at zero spend, except that what the existing scan catches keeps its exit 1", async () => {
  for (const name of WRITES_OR_RUNS) {
    const b = box();
    const out = await run(b, b.argv("ISSUE2"), [[init({ tools: ["Skill", name] }), result(0.1, { result: "x" })]]);
    assertNoPrompt(out, b);
    assert.equal(b.charged(), 0, name);
    if (CAUGHT_BY_SCAN.includes(name)) {
      assert.equal(out.r.exitCode, 1, name);
      assert.notEqual(out.r.summary.verdict, "LOAD FAILURE", name);
    } else {
      assert.equal(out.r.exitCode, 3, name);
      assert.equal(out.r.summary.verdict, "LOAD FAILURE", name);
    }
  }
});

test("load split. an unlisted tool that looks harmless refuses everywhere: on T2, on a connector row and on an init form", async () => {
  const name = "TodoWrite";
  const t2 = box();
  const a = await run(t2, t2.argv("T2"), [[init({ mcp_servers: [], tools: ["Skill", name] })]]);
  assert.equal(a.r.summary.verdict, "LOAD FAILURE");
  assert.ok(a.r.summary.stoppedBecause.includes(name));
  const row = box();
  const c = await run(row, row.argv("ISSUE2"), [[init({ tools: ["Skill", ...CONNECTOR_EXTRAS, name] })]]);
  assert.equal(c.r.summary.verdict, "LOAD FAILURE");
  assert.ok(c.r.summary.stoppedBecause.includes(name));
  assert.ok(!CONNECTOR_EXTRAS.some((t) => c.r.summary.stoppedBecause.includes(t))); // only the refused name is blamed
  const i = box();
  assert.equal((await run(i, i.initArgv(), [[initForm({ tools: [name] })]])).r.exitCode, 5);
});

test("load split. a tolerated name seen only on a later turn is recorded, and a name on several turns is recorded once", async () => {
  const b = box();
  const [first, second] = T4_OK();
  const script = [withInitTools(["ReadMcpResourceTool"])([first])[0], withInitTools(["ReadMcpResourceTool", "WaitForMcpServers"])([second])[0]];
  const out = await run(b, b.argv("T4"), script);
  assert.equal(out.r.exitCode, 0);
  assert.deepEqual(b.summary().init.toleratedTools, ["ReadMcpResourceTool", "WaitForMcpServers"]);
});

test("load split. a tool name that is not a string refuses through the load failure path, before and after the prompt, never as a thrown refusal", async () => {
  for (const name of [7, null, { a: 1 }]) {
    const b = box();
    const before = await run(b, b.argv("T2"), [[init({ mcp_servers: [], tools: ["Skill", name] }), SKILL(), result(0.1, { result: "x" })]]);
    assert.equal(before.r.refused, undefined, String(name));
    assert.equal(before.r.exitCode, 3, String(name));
    assert.equal(before.r.summary.verdict, "LOAD FAILURE", String(name));
    assertNoPrompt(before, b);
    const c = box();
    const after = await run(c, c.argv("T2"), [{ messages: [init({ mcp_servers: [], tools: ["Skill", name] }), assistantText("from the model"), result(0.1, { result: "accepted?" })], initTiming: "after" }], { timeoutMs: 20 });
    assert.equal(after.r.refused, undefined, String(name));
    assertLoadFailure(after, c);
    const i = box();
    const form = await run(i, i.initArgv(), [[initForm({ tools: [name] })]]);
    assert.equal(form.r.exitCode, 5, String(name));
    assert.deepEqual(form.d.io.lines, [], String(name));
  }
  const d = box(); // a list that is not an array stops too, and the summary is still written
  const notList = await run(d, d.argv("T2"), [[init({ mcp_servers: [], tools: "Skill" }), SKILL(), result(0.1, { result: "x" })]]);
  assert.equal(notList.r.refused, undefined);
  assert.equal(notList.r.exitCode, 3);
  assertNoPrompt(notList, d);
  assert.equal(d.summary().mode, "not bare");
});

test("order. system messages ahead of init cannot crowd it out, with init before the prompt or after it", async () => {
  const many = Array.from({ length: 30 }, () => HOOK_STARTED);
  const pump = startPump((async function* () { yield* many; yield init(); })(), { onMessage: () => {} });
  await pump.ended;
  assert.equal(pump.order.length, 20);
  assert.equal(pump.order.at(-1), "system:init");
  const b = box();
  const late = await run(b, b.argv("T2"), [{ messages: T2_OK(), initTiming: "after", before: many }], { timeoutMs: 20 });
  assert.equal(late.r.exitCode, 0);
  assert.ok(b.calls()[0].messageOrder.includes("system:init"));
  assert.ok(b.calls()[0].messageOrder.includes("<prompt sent>"));
});

test("notes. a hook event ahead of init adds a plain note and changes no verdict; no hook event, no note", async () => {
  const b = box();
  const out = await run(b, b.argv("T2"), [{ messages: T2_OK(), before: [HOOK_STARTED, HOOK_RESPONSE] }], { timeoutMs: 200 });
  assert.equal(out.r.exitCode, 0);
  assert.equal(out.r.summary.verdict, "PASS");
  assert.ok(b.summary().notes.includes("hook events came before init (system:hook_started, system:hook_response); plugin hooks are not checked"));
  const c = box();
  await run(c, c.argv("T2"), [T2_OK()]);
  assert.ok(!c.summary().notes.some((n) => /hook/.test(n)));
  const d = box();
  await run(d, d.argv("T2"), [{ messages: T2_OK(), before: [{ type: "system", subtype: "status" }] }], { timeoutMs: 200 });
  assert.ok(!d.summary().notes.some((n) => /hook/.test(n)));
});

test("notes. a call to an MCP resource tool adds a plain note naming it: no refusal and the same verdict; another tool adds none", async () => {
  for (const name of ["ListMcpResourcesTool", "ReadMcpResourceTool"]) {
    const b = box();
    const [head, ...rest] = ISSUE2_OK();
    const out = await run(b, b.argv("ISSUE2"), [[{ ...head, tools: [...head.tools, name] }, toolUse("m", name, {}), toolResult("m", "listed"), ...rest]]);
    assert.equal(out.r.exitCode, 0, name);
    assert.equal(out.r.summary.verdict, "PASS", name);
    assert.ok(b.summary().notes.includes(`${name} was called: it needs no permission, so no allow-list covers it`), name);
  }
  const c = box();
  await run(c, c.argv("ISSUE2"), [ISSUE2_OK()]);
  assert.ok(!c.summary().notes.some((n) => /McpResource/.test(n)));
});

test("load split. a disallowed name refuses even if a turn's tools held it, and no tolerated name is on the disallowed list or caught by the scan", async () => {
  const b = box();
  const hook = (o) => ({ ...o, tools: [...o.tools, "Bash"] });
  const out = await run(b, b.argv("T2"), [[init({ mcp_servers: [], tools: ["Skill", "Bash"] })]], { testOptionsHook: hook });
  assert.equal(out.r.summary.verdict, "LOAD FAILURE");
  assert.deepEqual(out.client.prompts, []);
  for (const name of [...CONNECTOR_EXTRAS, "Skill"]) {
    assert.ok(!DISALLOWED_TOOLS.includes(name), name);
    assert.deepEqual(scanInitTools([name]), [], name);
  }
});

// ---------------------------------------------------------------- the account lines

const ACCOUNT = { email: "someone@example.test", organization: "Example Org Name", apiKeySource: "ANTHROPIC_API_KEY", tokenSource: "none", subscriptionType: "team" };
const accountResult = (over = {}) => ({ account: { ...ACCOUNT, ...over }, claude_code_version: "2.1.300", fast_mode_state: "off" });
const LINES = ["AUTH_SOURCE=ANTHROPIC_API_KEY", "TOKEN_SOURCE=none", "SUBSCRIPTION_TYPE=team"];
const assertNoAccountLeak = (b, d) => {
  const all = everything(b, d);
  for (const secret of [ACCOUNT.email, ACCOUNT.organization]) assert.ok(!all.includes(secret), secret);
};

test("account lines. both init forms print the three lines in order, and neither email nor organization reaches stdout, stderr, the ledger or evidence", async () => {
  const i = box();
  const plain = await run(i, i.initArgv(), [{ messages: [initForm()], initResult: accountResult() }]);
  assert.equal(plain.r.exitCode, 0);
  assert.deepEqual(plain.d.io.lines, LINES);
  assertNoAccountLeak(i, plain.d);
  const t = box();
  const turn = await run(t, withTurnArgv(t), [{ messages: [initForm(), result(0.25)], initResult: accountResult() }]);
  assert.equal(turn.r.exitCode, 0);
  assert.deepEqual(turn.d.io.lines, LINES);
  assertNoAccountLeak(t, turn.d);
});

test("account lines. absent, empty or non-string values print not shown; a value cannot add a line; a stated fast-mode stop prints them too, exit unchanged", async () => {
  for (const over of [{ tokenSource: undefined, subscriptionType: undefined }, { tokenSource: "", subscriptionType: "" }, { tokenSource: 7, subscriptionType: { a: 1 } }]) {
    const b = box();
    const out = await run(b, b.initArgv(), [{ messages: [initForm()], initResult: accountResult(over) }]);
    assert.equal(out.r.exitCode, 0);
    assert.deepEqual(out.d.io.lines, authOutput());
  }
  const n = box();
  const odd = await run(n, n.initArgv(), [{ messages: [initForm()], initResult: accountResult({ tokenSource: "a\nAUTH_SOURCE=x" }) }]);
  assert.equal(odd.d.io.lines.length, 3);
  assert.deepEqual(odd.d.io.lines[1], "TOKEN_SOURCE=a_AUTH_SOURCE_x");
  const f = box();
  const fast = await run(f, f.initArgv(), [{ messages: [initForm()], initResult: { ...accountResult(), fast_mode_state: undefined } }]);
  assert.equal(fast.r.exitCode, 5);
  assert.deepEqual(fast.d.io.lines, LINES);
  assertNoAccountLeak(f, fast.d);
});

test("account lines. a row prints none of them, and its summary and evidence carry no account field but the source", async () => {
  const b = box();
  const { r, d } = await run(b, b.argv("T2"), [{ messages: T2_OK(), initResult: accountResult() }]);
  assert.equal(r.exitCode, 0);
  assert.ok(!d.io.lines.some((l) => /^(AUTH_SOURCE|TOKEN_SOURCE|SUBSCRIPTION_TYPE)=/.test(l)));
  assertNoAccountLeak(b, d);
  const s = b.summary();
  assert.equal("tokenSource" in s.init, false);
  assert.equal("subscriptionType" in s.init, false);
  assert.equal(s.init.authSource, "ANTHROPIC_API_KEY");
});

test("expect-no-key. unchanged: source none is exit 0 with AUTH_SOURCE=none first, an absent source is exit 4 with no line, and it refuses with a turn", async () => {
  const noKey = liveEnv(); delete noKey.ANTHROPIC_API_KEY;
  const none = box();
  const ok = await run(none, none.initArgv(["--expect-no-key"]), [{ messages: [initForm({ apiKeySource: "none" })], initResult: { account: { apiKeySource: "none" }, claude_code_version: "2.1.300", fast_mode_state: "off" } }], {}, noKey);
  assert.equal(ok.r.exitCode, 0);
  assert.equal(ok.d.io.lines[0], "AUTH_SOURCE=none");
  assert.deepEqual(ok.d.io.lines, authOutput("none"));
  assert.deepEqual(ok.client.prompts, []);
  const absent = box();
  const a = await run(absent, absent.initArgv(["--expect-no-key"]), [{ messages: [initForm()], initResult: { account: {}, claude_code_version: "2.1.300", fast_mode_state: "off" } }], {}, noKey);
  assert.equal(a.r.exitCode, 4);
  assert.deepEqual(a.d.io.lines, []);
  const t = box();
  const turn = await run(t, withTurnArgv(t, { more: ["--expect-no-key"] }), [[initForm(), result(0.25)]], {}, noKey);
  assert.equal(turn.r.exitCode, 2);
  assert.equal(turn.client.calls.length, 0);
});

// ---------------------------------------------------------------- init-only

test("F9. init-only uses the session options and all gates: the AUTH_SOURCE lines, no prompt, empty config accepted, non-empty refused, nothing deleted", async () => {
  const b = box();
  const { r, client, d } = await run(b, b.initArgv(), [[initForm()]]);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(d.io.lines, authOutput());
  assert.deepEqual(client.prompts, []);
  const o = client.calls[0].options;
  assert.equal("extraArgs" in o, false);
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  for (const t of ["Agent", "Task", "Bash", "WebFetch"]) assert.ok(o.disallowedTools.includes(t));
  assert.ok(o.env.HOME.startsWith(b.p("tmp")));
  assert.ok(o.cwd.startsWith(b.p("tmp")));
  nodefs.writeFileSync(path.join(b.cfg, "keep.txt"), "x");
  const full = await run(b, b.initArgv(), [[init()]]);
  assert.equal(full.r.exitCode, 2);
  assert.equal(nodefs.readFileSync(path.join(b.cfg, "keep.txt"), "utf8"), "x");
  assert.deepEqual(full.d.io.lines, []);
});

test("G3. init-only gates: 3 for an init timeout only; other gate failures 5, with auth 4 and fast mode 2; none prints a line", async () => {
  const cases = [
    [[init({ apiKeySource: "oauth" })], 4],
    [[init({ plugin_errors: [{ plugin: "p", type: "x", message: "m" }] })], 5],
    [[init({ plugins: [] })], 5],
    [[init({ fast_mode_state: "on" })], 2],
    [[init({ claude_code_version: "1.0.0" })], 5],
    [[init({ tools: ["WebFetch"] })], 1],
    [{ messages: [init()], initResult: { account: {} } }, 4],
    [{ messages: [init()], initResult: "hang" }, 3],
    [{ messages: [init()], initResult: null }, 5],
    [{ messages: [init()], initResult: new Error("socket closed") }, 5],
    [{ messages: [init()], initResult: new Error("401") }, 4],
    [{ messages: [assistantText("x")], before: [assistantText("x")] }, 5],
  ];
  for (const [script, code] of cases) {
    const b = box();
    const { r, client, d } = await run(b, b.initArgv(), [script], { timeoutMs: 20 });
    assert.equal(r.exitCode, code, JSON.stringify(script).slice(0, 80));
    assert.deepEqual(d.io.lines, []);
    assert.deepEqual(client.prompts, []);
  }
  const hung = box();
  const slow = await run(hung, hung.initArgv(), [{ messages: [init()], initTiming: "after", initResult: "hang" }], { timeoutMs: 20 });
  assert.equal(slow.r.exitCode, 3);
});

test("F9. --expect-no-key waives only the key refusal, reports the source it sees, and cannot reach a prompt; with a turn it refuses", async () => {
  const b = box();
  const noKey = liveEnv(); delete noKey.ANTHROPIC_API_KEY;
  assert.equal((await run(b, b.initArgv(), [[init()]], {}, noKey)).r.exitCode, 2);
  for (const src of ["none", "oauth"]) {
    const c = box();
    const { r, client, d } = await run(c, c.initArgv(["--expect-no-key"]), [[initForm({ apiKeySource: src })]], {}, noKey);
    assert.equal(r.exitCode, 0);
    assert.deepEqual(d.io.lines, authOutput(src));
    assert.deepEqual(client.prompts, []);
  }
  const gated = box();
  assert.equal((await run(gated, gated.initArgv(["--expect-no-key"]), [[init({ apiKeySource: "none", plugin_errors: [{ plugin: "p", type: "x", message: "m" }] })]], {}, noKey)).r.exitCode, 5);
  const turn = box();
  const t = await run(turn, turn.initArgv(["--expect-no-key", "--init-only-with-turn", "--model", HAIKU, "--ledger", turn.ledger, "--max-session-usd", "1", "--max-run-usd", "2"]), [[init()]], {}, noKey);
  assert.equal(t.r.exitCode, 2);
  assert.equal(t.client.calls.length, 0);
  assert.equal((await run(b, [...b.argv("T2"), "--expect-no-key"], [T2_OK()], {}, noKey)).r.exitCode, 2);
});

test("F9. by construction: the init-only and gate files hold no code that produces a message, and init-only imports neither the call file nor the rows", () => {
  const lib = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "lib");
  const read = (n) => nodefs.readFileSync(path.join(lib, n), "utf8");
  for (const n of ["initonly.mjs", "gates.mjs"]) assert.ok(!/\byield\b/.test(read(n)), n);
  const init2 = read("initonly.mjs");
  assert.ok(!/call\.mjs|live\.mjs|rows\.mjs|FIXED_PROMPT/.test(init2));
  assert.ok(!/call\.mjs/.test(read("gates.mjs")));
  assert.deepEqual([...read("call.mjs").matchAll(/\byield\b/g)].length, 1);
});

const withTurnArgv = (b, extra = {}) => b.initArgv(["--init-only-with-turn", "--model", extra.model ?? HAIKU, "--ledger", b.ledger,
  "--max-session-usd", extra.session ?? "1", "--max-run-usd", extra.run ?? "2", ...(extra.more ?? [])]);

test("F2. --init-only-with-turn needs --model, --ledger, the session budget and the run ceiling", async () => {
  const b = box();
  const full = withTurnArgv(b);
  for (const flag of ["--model", "--ledger", "--max-session-usd", "--max-run-usd"]) {
    const a = [...full]; a.splice(a.indexOf(flag), 2);
    const { r, client } = await run(b, a, [[init(), result(0.25)]]);
    assert.equal(r.exitCode, 2, flag);
    assert.equal(client.calls.length, 0, flag);
  }
});

test("F2. --init-only-with-turn: one fixed prompt, maxTurns 1, the session options, writes its cost to the ledger, the AUTH_SOURCE lines", async () => {
  const b = box();
  const { r, client, d } = await run(b, withTurnArgv(b), [[initForm(), result(0.25)]]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.cost, 0.25);
  assert.deepEqual(d.io.lines, authOutput());
  const o = client.calls[0].options;
  assert.equal(o.maxTurns, 1);
  assert.equal(o.maxBudgetUsd, 1);
  assert.equal("extraArgs" in o, false);
  assert.deepEqual(o.tools, []);
  assert.equal(client.prompts.length, 1);
  assert.match(client.prompts[0].text, /single word/);
  assert.equal(b.calls()[0].spend, 0.25);
  assert.equal(b.calls()[0].row, "INIT");
  assert.equal(b.calls()[0].status, "closed");
});

test("G11. --init-only-with-turn has a deadline: a hung call stops at --row-timeout-seconds, exit 3, interrupted, and stays at its reservation", async () => {
  const b = box();
  const { r, client } = await run(b, withTurnArgv(b, { more: ["--row-timeout-seconds", "0.05"] }), [{ messages: [initForm()], hang: true }]);
  assert.equal(r.exitCode, 3);
  assert.equal(client.interrupted, 1);
  near(b.charged(), WORST_HAIKU);
  assert.equal(nodefs.existsSync(`${b.ledger}.lock`), false);
  const bad = box();
  assert.equal((await run(bad, withTurnArgv(bad, { more: ["--row-timeout-seconds", "0"] }), [[init(), result(0.25)]])).r.exitCode, 2);
});

test("F2. --init-only-with-turn reads the record: it refuses when the worst case cannot fit, and a gate failure sends no prompt and records zero", async () => {
  const b = box({ record: spent("x", 4.5, { model: HAIKU }) });
  const a = await run(b, withTurnArgv(b, { run: "10" }), [[init(), result(0.25)]]);
  assert.equal(a.r.exitCode, 2);
  assert.equal(a.client.calls.length, 0);
  const c = box();
  const g = await run(c, withTurnArgv(c), [[init({ apiKeySource: "oauth" }), result(0.25)]]);
  assert.equal(g.r.exitCode, 4);
  assert.deepEqual(g.client.prompts, []);
  assert.equal(c.calls()[0].spend, 0);
  assert.deepEqual(g.d.io.lines, []);
  const n = box();
  const none = await run(n, withTurnArgv(n), [[initForm(), { type: "result", subtype: "success" }]]);
  assert.equal(none.r.exitCode, 3);
  near(n.calls()[0].spend, WORST_HAIKU);
});

// ---------------------------------------------------------------- mode, home, settings

test("mode. no row passes the bare option; summary.json says not bare and has no confirmation field; stdout has no confirmation line; the dry line is exact", async () => {
  for (const [row, script] of [["T2", [T2_OK()]], ["T4", T4_OK()], ["ISSUE2", [ISSUE2_OK()]]]) {
    const b = box();
    const { client, d } = await run(b, b.argv(row), script);
    for (const c of client.calls) assert.equal("extraArgs" in c.options, false, row);
    assert.ok(!d.io.lines.some((l) => /bare/i.test(l)), row);
    assert.equal(b.summary().mode, "not bare");
    assert.equal("bareConfirmed" in b.summary(), false);
  }
  const b = box();
  const dry = b.deps();
  assert.equal((await main({ argv: ["--dry-run", "--row", "T2"], env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, ...dry })).exitCode, 0);
  assert.ok(dry.io.lines.includes("mode: not bare"));
});

test("F10. a settings file with hooks, a key helper, any env key, any allow rule, a default mode or a cache setting refuses before any call, exit 2", async () => {
  const perms = (o) => ({ permissions: { ...goodSettings().permissions, ...o } });
  for (const extra of [
    { hooks: {} },
    { apiKeyHelper: "/bin/x" },
    { env: { ANYTHING: "1" } },
    { env: {} },
    perms({ allow: ["mcp__quadron__future_you_capture"] }),
    perms({ allow: ["mcp__quadron__quad_commit"] }),
    perms({ allow: ["mcp__quadron"] }),
    perms({ allow: ["mcp__*"] }), // G13
    perms({ allow: ["*"] }),
    perms({ allow: ["Read"] }),
    perms({ allow: ["Read", "mcp__quadron__quad_search"] }),
    perms({ allow: "Read" }),
    perms({ defaultMode: "dontAsk" }),
    perms({ defaultMode: "bypassPermissions" }),
    { promptCacheTtl: "5m" },
    { subagentPromptCacheTtl: "5m" },
  ]) {
    for (const [form, argv] of [["row", (b) => b.argv("T2")], ["init-only", (b) => b.initArgv()]]) {
      const b = box({ settings: { ...goodSettings(), ...extra } });
      const { r, client, d } = await run(b, argv(b), [T2_OK()]);
      assert.equal(r.exitCode, 2, `${form} ${JSON.stringify(extra)}`);
      assert.equal(client.calls.length, 0);
      assert.ok(d.io.errors.some((l) => /settings file/.test(l)), JSON.stringify(extra));
    }
  }
});

const SETTINGS_SECRET = "value-that-must-not-print";
const OFF_LIST = [
  ["permissions.additionalDirectories", (s) => ({ ...s, permissions: { ...s.permissions, additionalDirectories: [SETTINGS_SECRET] } })],
  ["permissions.ask", (s) => ({ ...s, permissions: { ...s.permissions, ask: [SETTINGS_SECRET] } })],
  ["enabledPlugins", (s) => ({ ...s, enabledPlugins: { [SETTINGS_SECRET]: true } })],
  ["extraKnownMarketplaces", (s) => ({ ...s, extraKnownMarketplaces: { x: SETTINGS_SECRET } })],
  ["statusLine", (s) => ({ ...s, statusLine: { command: SETTINGS_SECRET } })],
  ["otelHeadersHelper", (s) => ({ ...s, otelHeadersHelper: SETTINGS_SECRET })],
  ["awsAuthRefresh", (s) => ({ ...s, awsAuthRefresh: SETTINGS_SECRET })],
  ["autoMemoryEnabled", (s) => ({ ...s, autoMemoryEnabled: SETTINGS_SECRET })],
  ["model", (s) => ({ ...s, model: SETTINGS_SECRET })],
];

test("settings allowlist. any other key refuses, exit 2 with no client call, naming the key and never its value, on rows and both init forms", async () => {
  for (const [key, widen] of OFF_LIST) {
    for (const [form, argv] of [["row", (b) => b.argv("T2")], ["init-only", (b) => b.initArgv()], ["with-turn", (b) => withTurnArgv(b)]]) {
      const b = box({ settings: widen(goodSettings()) });
      const { r, client, d } = await run(b, argv(b), [T2_OK()]);
      assert.equal(r.exitCode, 2, `${form} ${key}`);
      assert.equal(client.calls.length, 0, `${form} ${key}`);
      assert.ok(d.io.errors.some((l) => l.includes(`the settings file may carry only deny rules: it contains ${key}; refusing`)), `${form} ${key}`);
      assert.ok(!d.io.errors.join(" ").includes(SETTINGS_SECRET), `${form} ${key}`);
    }
  }
});

test("settings allowlist. the three allowed top-level keys pass; fastMode true and a file that is no object still refuse", async () => {
  for (const settings of [{ ...goodSettings(), fastMode: false }, { $schema: "https://example.test/s.json", ...goodSettings(), fastMode: false }]) {
    const b = box({ settings });
    const { r, client } = await run(b, b.argv("T2"), [T2_OK()]);
    assert.equal(r.exitCode, 0, JSON.stringify(settings));
    assert.equal(client.calls.length, 1);
  }
  const on = box({ settings: { ...goodSettings(), fastMode: true } });
  const fast = await run(on, on.argv("T2"), [T2_OK()]);
  assert.equal(fast.r.exitCode, 2);
  assert.equal(fast.client.calls.length, 0);
  const lifted = (b) => { nodefs.writeFileSync(b.p("ov.json"), JSON.stringify({ reason: "x", expires: "2026-11-05T01:00:00Z", lifts: ["settings_deny"] })); return b.argv("T2", {}, ["--override", b.p("ov.json")]); };
  for (const settings of [[], [1], 5, null, { permissions: [] }, { permissions: "x" }]) {
    const b = box({ settings: JSON.stringify(settings) }); // the lift gets these past the deny check, so this one is what stops them
    const { r, client, d } = await run(b, lifted(b), [T2_OK()]);
    assert.equal(r.exitCode, 2, JSON.stringify(settings));
    assert.equal(client.calls.length, 0, JSON.stringify(settings));
    assert.ok(d.io.errors.some((l) => /may carry only deny rules/.test(l)), JSON.stringify(settings));
  }
});

test("settings allowlist. the settings_deny lift waives only the required deny rules: it never reaches the allowlist, and neither does any other lift", async () => {
  const ov = (b, lifts) => { nodefs.writeFileSync(b.p("ov.json"), JSON.stringify({ reason: "x", expires: "2026-11-05T01:00:00Z", lifts })); return ["--override", b.p("ov.json")]; };
  const waived = box({ settings: { permissions: { deny: [] } } });
  assert.equal((await run(waived, waived.argv("T2", {}, ov(waived, ["settings_deny"])), [T2_OK()])).r.exitCode, 0); // this much it lifts
  const notWaived = box({ settings: { permissions: { deny: [] } } });
  assert.equal((await run(notWaived, notWaived.argv("T2"), [T2_OK()])).r.exitCode, 2);
  for (const [key, widen] of OFF_LIST) {
    const b = box({ settings: widen(goodSettings()) });
    const { r, client, d } = await run(b, b.argv("T2", {}, ov(b, ["settings_deny", "init_scan", "tool_use_scan"])), [T2_OK()]);
    assert.equal(r.exitCode, 2, key);
    assert.equal(client.calls.length, 0, key);
    assert.ok(d.io.errors.some((l) => l.includes(`it contains ${key}`)), key);
  }
});

test("F10. deny rules stay accepted, Bash(*)-style among them, and so does an empty allow list", async () => {
  for (const settings of [
    goodSettings(),
    { permissions: { deny: [...goodSettings().permissions.deny, "Bash(*)", "Read(//**/.env)"] } },
    { permissions: { ...goodSettings().permissions, allow: [] } },
  ]) {
    const b = box({ settings });
    assert.equal((await run(b, b.argv("T2"), [T2_OK()])).r.exitCode, 0, JSON.stringify(settings));
  }
});

test("T2 and Skill. a Skill call denied in either record, or errored, does not count; T2_OK still passes", async () => {
  const skillThen = (...msgs) => [[init({ mcp_servers: [] }), SKILL(), ...msgs]];
  const end = (o = {}) => result(0.1, { result: "An answer.", ...o });
  for (const [label, script] of [
    ["permission_denials", skillThen(toolResult("skill1", "ok"), end({ permission_denials: [denial("skill1", "Skill")] }))],
    ["permission_denied", skillThen(toolResult("skill1", "ok"), permissionDenied("skill1", "Skill"), end())],
    ["errored", skillThen(toolResult("skill1", "boom", true), end())],
  ]) {
    const b = box();
    const { r } = await run(b, b.argv("T2"), script);
    assert.equal(r.summary.verdict, "FAIL", label);
    assert.equal(r.exitCode, 1, label);
    assert.match(r.summary.notes.join(" "), /skill tool/, label);
  }
  const ran = box();
  assert.equal((await run(ran, ran.argv("T2"), skillThen(toolResult("skill1", "ok"), end()))).r.summary.verdict, "PASS");
  const ok = box();
  assert.equal((await run(ok, ok.argv("T2"), [T2_OK()])).r.summary.verdict, "PASS");
  // One good call is enough, beside one that failed.
  const both = box();
  assert.equal((await run(both, both.argv("T2"), skillThen(toolResult("skill1", "boom", true), toolUse("s2", "Skill", { skill: "quadron:quadron" }), toolResult("s2", "ok"), end()))).r.summary.verdict, "PASS");
});

test("T2 and Skill. options name the plugin's skill on rows and both init forms, and the rows keep 'Skill' on their allow-lists", async () => {
  const check = (client, label) => {
    assert.ok(client.calls.length > 0, label);
    for (const { options } of client.calls) assert.deepEqual(options.skills, ["quadron:quadron"], label);
  };
  const a = box();
  check((await run(a, a.initArgv(), [[initForm()]])).client, "init-only");
  const c = box();
  check((await run(c, c.initArgv(["--init-only-with-turn", "--model", HAIKU, "--ledger", c.ledger, "--max-session-usd", "1", "--max-run-usd", "2"]), [[initForm(), result(0.01, { result: "ok" })]])).client, "with-turn");
  for (const [row, script] of [["T2", [T2_OK()]], ["T4", T4_OK()], ["T5", T5_OK()], ["ISSUE2", [ISSUE2_OK()]]]) {
    const b = box();
    const { client } = await run(b, b.argv(row), script);
    check(client, row);
    for (const { options } of client.calls) assert.ok(options.allowedTools.includes("Skill"), row);
  }
});

test("G12. T5's file tools are never on its allow-list, and the check after a call holds them to the plugin directory, links followed", async () => {
  const b = box();
  const { client } = await run(b, b.argv("T5"), T5_OK());
  for (const { options } of client.calls) {
    for (const t of ["Read", "Glob", "Grep"]) assert.ok(!options.allowedTools.includes(t), t);
    assert.equal(options.cwd, b.plugin);
  }
  const scope = { root: b.plugin, fs: nodefs };
  assert.equal(inScope("Read", { file_path: path.join(b.plugin, "SKILL.md") }, scope), true);
  assert.equal(inScope("Read", { file_path: "SKILL.md" }, scope), true);
  assert.equal(inScope("Read", { file_path: b.settings }, scope), false);
  assert.equal(inScope("Read", { file_path: path.join(b.plugin, "..", "settings.json") }, scope), false);
  assert.equal(inScope("Read", {}, scope), false);
  nodefs.symlinkSync(b.root, path.join(b.plugin, "out-link"));
  assert.equal(inScope("Read", { file_path: path.join(b.plugin, "out-link", "settings.json") }, scope), false);
  assert.equal(inScope("Glob", { pattern: "**/*.md" }, scope), true);
  assert.equal(inScope("Glob", { pattern: "*.md", path: b.plugin }, scope), true);
  for (const input of [{ pattern: "*", path: b.root }, { pattern: "../*" }, { pattern: "a/../../b" }, { pattern: "/etc/*" }, {}]) {
    assert.equal(inScope("Glob", input, scope), false, JSON.stringify(input));
  }
  assert.equal(inScope("Grep", { pattern: "x" }, scope), true);
  assert.equal(inScope("Grep", { pattern: "\\.\\./x", path: b.plugin }, scope), true); // a regular expression, not a path
  assert.equal(inScope("Grep", { pattern: "x", path: b.root }, scope), false);
});

test("G12. a file tool aimed outside the plugin directory fails T5 on either turn, though the mode denied it", async () => {
  const q = { session_id: "q" };
  const clean = (cost) => [init(q), result(cost, { ...q, result: "No." })];
  for (const [turn, make] of [
    [1, (b) => ["Read", { file_path: b.settings }]],
    [1, (b) => ["Glob", { pattern: "*", path: b.root }]],
    [1, (b) => ["Grep", { pattern: "x", path: b.root }]],
    [2, (b) => ["Read", { file_path: b.settings }]],
  ]) {
    const b = box();
    const [name, input] = make(b);
    const reach = [init(q), toolUse("r", name, input), toolResult("r", "x"), result(0.05 * turn, { ...q, result: "Summary." })];
    const { r, client } = await run(b, b.argv("T5"), turn === 1 ? [reach, clean(0.08)] : [clean(0.01), reach]);
    assert.equal(r.summary.verdict, "FAIL", name);
    assert.equal(r.exitCode, 1, name);
    assert.equal(client.calls.length, turn, name);
    assert.match(r.summary.notes.join(" "), new RegExp(`${name} went outside the plugin directory`));
    assert.equal(r.summary.toolCalls[0].isError, true, name);
    assert.deepEqual(client.denials.map((d) => d.tool_name), [name]);
  }
});

test("G12. a read inside the plugin directory needs no rule and passes T5, with no denial", async () => {
  const b = box();
  const q = { session_id: "q" };
  const { r, client } = await run(b, b.argv("T5"), [
    [init(q), toolUse("r", "Read", { file_path: path.join(b.plugin, "SKILL.md") }), toolResult("r", "skill"), toolUse("g", "Grep", { pattern: "x" }), toolResult("g", "none"), result(0.05, { ...q, result: "Summary." })],
    [init(q), result(0.08, { ...q, result: "No." })],
  ]);
  assert.equal(r.summary.verdict, "PASS-MECHANICAL");
  assert.equal(r.exitCode, 0);
  assert.deepEqual(client.denials, []);
  assert.equal(r.summary.toolCalls[0].isError, false);
});

test("F9. dontAsk on rows and both init forms, with no callback and no prompt setting, and the two deny patterns for the SDK package", async () => {
  const PATTERNS = ["Read(//**/node_modules/@anthropic-ai/**)", "Edit(//**/node_modules/@anthropic-ai/**)"];
  const check = (client, label) => {
    assert.ok(client.calls.length > 0, label);
    for (const { options: o } of client.calls) {
      assert.equal(o.permissionMode, "dontAsk", label);
      assert.equal("canUseTool" in o, false, label);
      assert.equal("permissionPrompts" in o, false, label);
      assert.deepEqual(o.settingSources, [], label);
      for (const p of PATTERNS) assert.ok(o.disallowedTools.includes(p), `${label} ${p}`);
      assert.ok(o.disallowedTools.includes("Edit"), label); // the bare name stays
    }
  };
  const a = box();
  check((await run(a, a.initArgv(), [[initForm()]])).client, "init-only");
  const c = box();
  const withTurn = await run(c, c.initArgv(["--init-only-with-turn", "--model", HAIKU, "--ledger", c.ledger, "--max-session-usd", "1", "--max-run-usd", "2"]), [[initForm(), result(0.01, { result: "ok" })]]);
  assert.equal(withTurn.r.exitCode, 0);
  check(withTurn.client, "init-only-with-turn");
  assert.deepEqual(withTurn.client.calls[0].options.allowedTools, []);
  for (const [row, script] of [["T2", [T2_OK()]], ["T4", T4_OK()], ["T5", T5_OK()], ["ISSUE2", [ISSUE2_OK()]]]) {
    const b = box();
    check((await run(b, b.argv(row), script)).client, row);
  }
});

test("F11. the child's home variables point at a new empty directory outside the clone, never the inherited ones", async () => {
  const b = box();
  const { client } = await run(b, b.argv("T2"), [(args) => {
    const home = args.options.env.HOME;
    assert.deepEqual(nodefs.readdirSync(home), []);
    return T2_OK();
  }], {}, liveEnv({ HOME: SOME_HOME, USERPROFILE: SOME_HOME, HOMEDRIVE: "C:", HOMEPATH: "\\real" }));
  const env = client.calls[0].options.env;
  assert.equal(env.HOME, env.USERPROFILE);
  assert.ok(env.HOME.startsWith(b.out));
  assert.ok(!env.HOME.startsWith(b.repo));
  assert.ok(!("HOMEDRIVE" in env) && !("HOMEPATH" in env)); // a POSIX path has no drive
  const win = buildChildEnv({ HOME: "/real", HOMEDRIVE: "D:", HOMEPATH: "\\real" }, { configDir: "c", homeDir: "C:\\work\\home", maxOutputTokens: 4096 });
  assert.deepEqual([win.HOME, win.USERPROFILE, win.HOMEDRIVE, win.HOMEPATH], ["C:\\work\\home", "C:\\work\\home", "C:", "\\work\\home"]);
  assert.throws(() => buildChildEnv({}, { configDir: "c", maxOutputTokens: 4096 }), /home/);
});

test("H2. every live form's child env sets the output limit and the retry and traffic switches, and a parent environment cannot loosen them", async () => {
  const loose = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "128000", CLAUDE_CODE_MAX_RETRIES: "10", CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "5", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0" };
  const expected = { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096", CLAUDE_CODE_MAX_RETRIES: "1", CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "0", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
  const forms = [["row", (b) => b.argv("T2"), [T2_OK()]], ["init", (b) => b.initArgv(), [[initForm()]]], ["turn", (b) => withTurnArgv(b), [[initForm(), result(0.1)]]]];
  for (const [name, argv, script] of forms) {
    const b = box();
    const { client } = await run(b, argv(b), script, {}, liveEnv(loose));
    for (const [k, v] of Object.entries(expected)) assert.equal(client.calls[0].options.env[k], v, `${name} ${k}`);
  }
  assert.throws(() => buildChildEnv({}, { configDir: "c", homeDir: "/h" }), /output token limit/);
});

const FIXED_ENV = ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "CLAUDE_CODE_DISABLE_AGENT_VIEW", "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL"];

test("env. every live form sets the fixed switches to 1 whatever the parent says; none is a refused name; the allowlist is the only way in", async () => {
  const parent = Object.fromEntries(FIXED_ENV.map((k) => [k, "0"]));
  const forms = [["row", (b) => b.argv("T2"), [T2_OK()]], ["init", (b) => b.initArgv(), [[initForm()]]], ["turn", (b) => withTurnArgv(b), [[initForm(), result(0.1)]]]];
  for (const [name, argv, script] of forms) {
    const b = box();
    const { r, client } = await run(b, argv(b), script, {}, liveEnv(parent));
    assert.equal(r.exitCode, 0, name);
    for (const k of FIXED_ENV) assert.equal(client.calls[0].options.env[k], "1", `${name} ${k}`);
    for (const k of Object.keys(client.calls[0].options.env)) assert.ok(k in ENV_ALLOWLIST, `${name} ${k}`);
  }
  for (const k of FIXED_ENV) {
    assert.ok(k in ENV_ALLOWLIST, k);
    assert.ok(!REFUSED_ENV.includes(k), k);
  }
});

test("env. APPDATA and LOCALAPPDATA are not passed", async () => {
  const parent = { APPDATA: "C:\\real\\Roaming", LOCALAPPDATA: "C:\\real\\Local" };
  const built = buildChildEnv(parent, { configDir: "c", homeDir: "/h", maxOutputTokens: 4096 });
  for (const k of Object.keys(parent)) {
    assert.ok(!(k in ENV_ALLOWLIST), k);
    assert.ok(!(k in built), k);
  }
  const b = box();
  const { client } = await run(b, b.argv("T2"), [T2_OK()], {}, liveEnv(parent));
  for (const k of Object.keys(parent)) assert.ok(!(k in client.calls[0].options.env), k);
});

test("cache. every live form's child env pins 5-minute cache writes: a parent cannot loosen it, and the 1-hour switches and TTL variables are dropped, not refused", async () => {
  const parent = { ENABLE_PROMPT_CACHING_1H: "1", CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "1h", FORCE_PROMPT_CACHING_5M: "0" };
  const forms = [["row", (b) => b.argv("T2"), [T2_OK()]], ["init", (b) => b.initArgv(), [[initForm()]]], ["turn", (b) => withTurnArgv(b), [[initForm(), result(0.1)]]]];
  for (const [name, argv, script] of forms) {
    const b = box();
    const { r, client } = await run(b, argv(b), script, {}, liveEnv(parent));
    assert.equal(r.exitCode, 0, name);
    const env = client.calls[0].options.env;
    assert.equal(env.FORCE_PROMPT_CACHING_5M, "1", name);
    for (const k of ["ENABLE_PROMPT_CACHING_1H", "CLAUDE_CODE_PROMPT_CACHE_TTL", "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL"]) assert.ok(!(k in env), `${name} ${k}`);
  }
});

test("cache. the 1-hour write count from a result's modelUsage goes to summary.json and the ledger call entry, with no effect on the verdict; absent is not shown", async () => {
  const usage = (model, n) => ({ modelUsage: { [model]: { cacheCreationEphemeral1hInputTokens: n } } });
  const b = box();
  const seen = await run(b, b.argv("T2"), [[init({ mcp_servers: [] }), SKILL(), result(0.1, { result: "x", ...usage("claude-opus-5-5", 2000) })]]);
  assert.equal(seen.r.exitCode, 0);
  assert.equal(seen.r.summary.verdict, "PASS"); // a broken pin is recorded, not judged
  assert.equal(b.summary().turns[0].cacheWrite1hTokens, 2000);
  assert.equal(b.calls()[0].cacheWrite1hTokens, 2000);
  const none = box();
  await run(none, none.argv("T2"), [T2_OK()]);
  assert.equal(none.summary().turns[0].cacheWrite1hTokens, "not shown");
  assert.equal(none.calls()[0].cacheWrite1hTokens, "not shown");
  const zero = box();
  await run(zero, zero.argv("T2"), [[init({ mcp_servers: [] }), SKILL(), result(0.1, { result: "x", ...usage("claude-opus-5-5", 0) })]]);
  assert.equal(zero.calls()[0].cacheWrite1hTokens, 0);
  const turn = box();
  await run(turn, withTurnArgv(turn), [[initForm(), result(0.1, usage("claude-haiku-5-5", 5))]]);
  assert.equal(turn.calls()[0].cacheWrite1hTokens, 5);
});

test("the child env holds only allowlisted keys, and no connector variable or inherited switch", async () => {
  const b = box();
  const { client } = await run(b, b.argv("T4"), T4_OK(), {}, liveEnv({ SOME_FAST_SWITCH: "1", REGION_HINT: "us" }));
  const o = client.calls[0].options;
  for (const k of Object.keys(o.env)) assert.ok(k in ENV_ALLOWLIST, `unexpected child env key ${k}`);
  assert.ok(!JSON.stringify(o.env).includes(REFRESH));
  assert.ok(!Object.keys(o.env).some((k) => k.startsWith("QUADRON_CAMPAIGN"))); // the child is never told where the record is
  assert.ok(!JSON.stringify(o.env).includes(b.record));
  assert.equal(o.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  assert.equal(o.env.CLAUDE_CONFIG_DIR, b.cfg);
  assert.deepEqual(Object.keys(o.mcpServers), ["quadron"]);
  assert.equal(o.mcpServers.quadron.url, MCP_URL);
  assert.match(o.mcpServers.quadron.headers.Authorization, /^Bearer eyJ/);
});

// ---------------------------------------------------------------- connector

test("F13. staging means https, a quadron.tech host and a first label of exactly staging", () => {
  for (const ok of ["https://staging.quadron.tech/x", "https://staging.quadron.tech", "https://staging.eu.quadron.tech/mcp"]) assert.equal(isStagingUrl(ok), true, ok);
  for (const bad of ["http://staging.quadron.tech", "https://staging.evil.example", "https://staging.com", "https://app.quadron.tech", "https://mcp.quadron.tech/mcp", "https://xstaging.quadron.tech",
    "https://staging.quadron.tech.evil.example", "https://staging.xquadron.tech", "https://user:pw@staging.quadron.tech", "ftp://staging.quadron.tech", "nonsense"]) {
    assert.equal(isStagingUrl(bad), false, bad);
  }
});

test("F13. a bad issuer or MCP host refuses with no fetch and no call", async () => {
  for (const bad of ["https://staging.evil.example/realms/x", "https://staging.com/realms/x", "http://staging.quadron.tech/x"]) {
    const b = box();
    const f = fetchStub();
    const { r, client } = await run(b, b.argv("T4"), T4_OK(), { fetch: f }, liveEnv({ QUADRON_CONNECTOR_ISSUER: bad }));
    assert.equal(r.exitCode, 2, bad);
    assert.equal(client.calls.length, 0);
    assert.equal(f.seen.length, 0);
    const c = box();
    const argv = c.argv("T4").map((a) => (a === MCP_URL ? bad : a));
    const f2 = fetchStub();
    assert.equal((await run(c, argv, T4_OK(), { fetch: f2 })).r.exitCode, 2, bad);
    assert.equal(f2.seen.length, 0);
  }
});

test("F13. a foreign or plain-http token_endpoint from discovery refuses with no token sent", async () => {
  for (const tokenEndpoint of ["https://evil.example/token", "http://staging.quadron.tech/token", "https://other.quadron.tech/token", "https://staging.eu.quadron.tech/token", "nonsense", null]) {
    const b = box();
    const f = fetchStub({ tokenEndpoint });
    const { r, client, d } = await run(b, b.argv("T4"), T4_OK(), { fetch: f });
    assert.equal(r.exitCode, 2, String(tokenEndpoint));
    assert.equal(f.seen.length, 1); // discovery only
    assert.equal(f.seen.some((s) => s.body?.includes(REFRESH)), false);
    assert.equal(client.calls.length, 0);
    assert.match(d.io.errors.join(" "), /no token sent/);
  }
  const f = fetchStub();
  const b = box();
  await run(b, b.argv("T4"), T4_OK(), { fetch: f });
  assert.ok(f.seen.every((s) => s.redirect === "error"));
});

test("F13. dry-run's loopback parser accepts only http and https", () => {
  for (const ok of ["http://127.0.0.1:9", "https://localhost/x", "http://[::1]:9"]) assert.equal(isLoopbackUrl(ok), true, ok);
  for (const bad of ["ftp://127.0.0.1", "file://localhost/x", "gopher://localhost", "ws://127.0.0.1", "garbage"]) assert.equal(isLoopbackUrl(bad), false, bad);
});

test("F14. an expected-account mismatch refuses", async () => {
  const b = box();
  const { r, client } = await run(b, b.argv("T4", {}, ["--account-label", "x"]), T4_OK(), { fetch: fetchStub({ identity: "someone-else" }) });
  assert.equal(r.exitCode, 2);
  assert.equal(client.calls.length, 0);
});

test("F14. no identity exposed: --account-label is required and printed as a label, and --expected-account is not restated as one", async () => {
  const b = box();
  const missing = await run(b, b.argv("T4"), T4_OK(), { fetch: fetchStub({ identity: null }) });
  assert.equal(missing.r.exitCode, 2);
  assert.equal(missing.client.calls.length, 0);
  assert.match(missing.d.io.errors.join(" "), /--account-label/);
  const c = box();
  const { r, d } = await run(c, c.argv("T4", {}, ["--account-label", "label-from-the-operator"]), T4_OK(), { fetch: fetchStub({ identity: null }) });
  assert.equal(r.summary.account.check, "not shown");
  assert.ok(d.io.lines.includes("account label (not verified): label-from-the-operator"));
  assert.ok(!d.io.lines.join("\n").includes("acct-test"));
  assert.ok(!c.summary().account.note.includes("acct-test"));
});

test("F15. unknown-flag and dry-report output pass through the redactor; home paths are not printed", async () => {
  const b = box();
  const d = b.deps();
  const r = await main({ argv: [`--${SOME_HOME}/secret-dir`], env: {}, ...d });
  assert.equal(r.exitCode, 2);
  const d1 = b.deps();
  await main({ argv: ["--sk-abcdefgh12345678"], env: {}, ...d1 });
  assert.ok(!d1.io.errors.join(" ").includes("sk-abcdefgh12345678"));
  assert.ok(!d.io.errors.join(" ").includes("/someone"));
  const d2 = b.deps();
  const dry = await main({
    argv: ["--dry-run", "--row", "T2", "--ledger", `${SOME_HOME}/ledger.json`, "--expected-account", "C:\\Users\\bob\\x", "--model", "/mnt/c/Users/bob/m"],
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, ...d2,
  });
  assert.equal(dry.exitCode, 0);
  const text = d2.io.lines.join("\n");
  for (const s of ["/someone", "bob", SOME_HOME]) assert.ok(!text.includes(s), s);
});

test("auth. a failed refresh or an unusable scope is exit 4, and no token appears anywhere", async () => {
  const b1 = box();
  const a = await run(b1, b1.argv("T4"), T4_OK(), { fetch: fetchStub({ tokenStatus: 401 }) });
  assert.equal(a.r.exitCode, 4);
  assert.match(a.d.io.errors.join(" "), /token refresh failed/);
  for (const s of [REFRESH, KEY]) assert.ok(!everything(b1, a.d).includes(s));
  const b2 = box();
  const c = await run(b2, b2.argv("T4"), T4_OK(), { fetch: async () => { throw new Error(`socket closed for ${REFRESH}`); } });
  assert.equal(c.r.exitCode, 4);
  assert.ok(!everything(b2, c.d).includes(REFRESH));
  const b3 = box();
  assert.equal((await run(b3, b3.argv("T4"), T4_OK(), { fetch: fetchStub({ scope: "other" }) })).r.exitCode, 4);
});

test("auth. subscription or credential variables refuse; a missing key refuses without printing any value", async () => {
  for (const v of REFUSED_ENV) {
    const b = box();
    const { r, client, d } = await run(b, b.argv("T2"), [T2_OK()], {}, liveEnv({ [v]: "value-xyz-123456" }));
    assert.equal(r.exitCode, 2, v);
    assert.equal(client.calls.length, 0);
    assert.ok(!everything(b, d).includes("value-xyz-123456"));
  }
  const b = box();
  const env = liveEnv(); delete env.ANTHROPIC_API_KEY;
  const { r, d } = await run(b, b.argv("T2"), [T2_OK()], {}, env);
  assert.equal(r.exitCode, 2);
  assert.match(d.io.errors.join(" "), /ANTHROPIC_API_KEY/);
});

test("print mode. print-mode flags refuse with exit 2 and nothing starts", async () => {
  const b = box();
  for (const argv of [["-p", "hi"], ["--print"], ["--output-format", "stream-json"], [...b.argv("T2"), "-p"]]) {
    const { r, client } = await run(b, argv, [T2_OK()]);
    assert.equal(r.exitCode, 2);
    assert.equal(client.calls.length, 0);
  }
});

// ---------------------------------------------------------------- web and browser tool restrictions

test("web-tools. settings must exist and carry the deny rules; browser libraries, env and arguments refuse", async () => {
  for (const settings of [{ permissions: { deny: ["WebFetch"] } }, "not json", {}]) {
    const b = box({ settings });
    const { r, client } = await run(b, b.argv("T2"), [T2_OK()]);
    assert.equal(r.exitCode, 2);
    assert.equal(client.calls.length, 0);
  }
  const b = box();
  nodefs.unlinkSync(b.settings);
  assert.equal((await run(b, b.argv("T2"), [T2_OK()])).r.exitCode, 2);
  const c = box();
  const lib = await run(c, c.argv("T2"), [T2_OK()], { resolve: (n) => (n === "puppeteer" ? "/x" : (() => { throw new Error("no"); })()) });
  assert.equal(lib.r.exitCode, 2);
  assert.equal(lib.client.calls.length, 0);
  assert.equal((await run(c, c.argv("T2"), [T2_OK()], {}, liveEnv({ PLAYWRIGHT_BROWSERS_PATH: "x" }))).r.exitCode, 2);
});

test("web-tools. options disallow web tools; init tools and every tool_use are scanned", async () => {
  const b = box();
  const { client } = await run(b, b.argv("T2"), [T2_OK()]);
  for (const t of ["WebFetch", "WebSearch", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) assert.ok(client.calls[0].options.disallowedTools.includes(t), t);
  for (const name of ["WebFetch", "mcp__playwright__navigate", "mcp__other__tool"]) {
    const c = box();
    const { r } = await run(c, c.argv("T2"), [[init({ mcp_servers: [] }), toolUse("u", name), result(0.01, { result: "x" })]]);
    assert.equal(r.exitCode, 1, name);
  }
  const bad = box();
  const inInit = await run(bad, bad.argv("T2"), [[init({ mcp_servers: [], tools: ["Skill", "mcp__chrome__open"] })]]);
  assert.equal(inInit.r.exitCode, 1);
  assert.deepEqual(inInit.client.prompts, []);
});

test("web-tools. override is time-boxed (240 min), lifts only what it names, never the library check, and is reported", async () => {
  const now = Date.parse("2026-11-05T00:00:00Z");
  const ok = (o) => JSON.stringify({ reason: "r", expires: new Date(now + 60 * 60000).toISOString(), lifts: ["init_scan"], ...o });
  assert.deepEqual(loadOverride(ok(), now).lifts, ["init_scan"]);
  assert.throws(() => loadOverride(ok({ expires: new Date(now - 1).toISOString() }), now), /expired/);
  assert.throws(() => loadOverride(ok({ expires: new Date(now + 241 * 60000).toISOString() }), now), /240/);
  assert.throws(() => loadOverride(ok({ lifts: ["library"] }), now), /library/);
  assert.throws(() => loadOverride(ok({ lifts: ["nonsense"] }), now), /do not exist/);
  const b = box();
  nodefs.writeFileSync(b.p("ov.json"), ok());
  const { r } = await run(b, [...b.argv("T2"), "--override", b.p("ov.json")], [[init({ mcp_servers: [], tools: ["Skill", "mcp__chrome__open"] }), SKILL(), result(0.01, { result: "x" })]]);
  assert.equal(r.summary.override.lifts[0], "init_scan");
  assert.equal(r.exitCode, 0);
  const c = box({ settings: {} });
  nodefs.writeFileSync(c.p("ov.json"), ok());
  assert.equal((await run(c, [...c.argv("T2"), "--override", c.p("ov.json")], [])).r.exitCode, 2);
});

test("version floor: versionAtLeast", () => {
  assert.ok(versionAtLeast("2.1.286") && versionAtLeast("2.2.0") && !versionAtLeast("2.1.285") && !versionAtLeast("x") && !versionAtLeast(undefined));
});

// ---------------------------------------------------------------- evidence

test("F21. each attempt writes a uniquely named directory with stream.jsonl and summary.json holding every required field", async () => {
  const b = box();
  const { r, client } = await run(b, b.argv("ISSUE2"), [[
    init({ session_id: "sess-1", fast_mode_state: "off" }), toolUse("r", READ, { topic: "x" }), toolResult("r", "tool text"), assistantText("Keep this in quadron-connect: keeps raw streams?"),
    result(0.2, { session_id: "sess-1", result: "Keep this in quadron-connect: keeps raw streams?" }),
  ]]);
  assert.equal(r.exitCode, 0);
  const dirs = b.attemptDirs();
  assert.equal(dirs.length, 1);
  assert.match(dirs[0], /^ISSUE2-claude-opus-5-5-2026-11-05T00-00-00-000Z$/);
  const lines = nodefs.readFileSync(path.join(b.out, dirs[0], "stream.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((m) => m.type), ["system", "assistant", "user", "assistant", "result"]);
  const s = b.summary();
  assert.ok(s.command.includes("--row") && s.command.includes("ISSUE2"));
  assert.equal(s.cwd, client.calls[0].options.cwd);
  assert.equal(s.exitCode, 0);
  assert.equal(s.head, HEAD);
  assert.equal(s.sessionId, "sess-1");
  assert.equal(s.init.authSource, "ANTHROPIC_API_KEY");
  assert.equal(s.init.version, "2.1.300");
  assert.equal(s.init.plugins[0].name, "quadron");
  assert.equal(s.init.servers[0].status, "connected");
  assert.equal(s.init.fastState, "off");
  assert.deepEqual(s.toolCalls, [{ name: READ, input: { topic: "x" }, result: "tool text", isError: false }]);
  assert.match(s.answer, /raw streams/);
  assert.equal(s.turns[0].spendUsd, 0.2);
  assert.equal(s.totalCostUsd, 0.2);
  assert.equal(s.verdict, "PASS");
  assert.ok(Array.isArray(s.notes));
});

test("F21. nothing is overwritten: two attempts at the same instant get two directories, and an existing directory stays", async () => {
  const b = box();
  await run(b, b.argv("T2"), [T2_BAD(0.1, "a")]);
  const first = b.attemptDirs()[0];
  const kept = nodefs.readFileSync(path.join(b.out, first, "summary.json"), "utf8");
  await run(b, b.argv("T2"), [T2_OK(0.2, "b")]);
  const dirs = b.attemptDirs();
  assert.equal(dirs.length, 2);
  assert.equal(new Set(dirs).size, 2);
  assert.equal(nodefs.readFileSync(path.join(b.out, first, "summary.json"), "utf8"), kept);
});

test("F21. cwd is a new empty directory under --out for T2, T4, T6 and ISSUE2, and the plugin directory for T5", async () => {
  for (const [row, script] of [["T2", [T2_OK()]], ["T4", T4_OK()], ["ISSUE2", [ISSUE2_OK()]]]) {
    const b = box();
    let empty = null;
    const fns = script.map((s) => (args) => { empty = empty ?? nodefs.readdirSync(args.options.cwd).length === 0; return s; });
    const { client } = await run(b, b.argv(row), fns);
    assert.ok(client.calls[0].options.cwd.startsWith(b.out), row);
    assert.notEqual(client.calls[0].options.cwd, b.out);
    assert.equal(empty, true, row);
  }
  const b = box();
  const { client } = await run(b, b.argv("T5"), [[init({ session_id: "q" }), result(0.05, { session_id: "q", result: "Summary." })], [init({ session_id: "q" }), result(0.08, { session_id: "q", result: "No." })]]);
  assert.deepEqual(client.calls.map((c) => c.options.cwd), [b.plugin, b.plugin]);
});

test("clone. T5 runs in the plugin directory and writes nothing there; a change there during the row fails it loudly", async () => {
  const b = box();
  const before = nodefs.readdirSync(b.plugin);
  const clean = await run(b, b.argv("T5"), [[init({ session_id: "q" }), result(0.05, { session_id: "q", result: "Summary." })], [init({ session_id: "q" }), result(0.08, { session_id: "q", result: "No." })]]);
  assert.equal(clean.r.summary.verdict, "PASS-MECHANICAL");
  assert.deepEqual(nodefs.readdirSync(b.plugin), before);
  const c = box();
  const dirty = await run(c, c.argv("T5"), [(args) => {
    nodefs.writeFileSync(path.join(args.options.cwd, "written-by-child"), "x");
    return [init({ session_id: "q" }), result(0.05, { session_id: "q", result: "Summary." })];
  }, [init({ session_id: "q" }), result(0.08, { session_id: "q", result: "No." })]]);
  assert.equal(dirty.r.summary.verdict, "FAIL");
  assert.equal(dirty.r.exitCode, 1);
  assert.ok(dirty.d.io.lines.some((l) => /hygiene failure: the plugin directory changed/.test(l)));
});

test("clone. a file appearing anywhere in the clone during any row fails it loudly; a temporary root inside the clone refuses with nothing created", async () => {
  const b = box();
  const dirty = await run(b, b.argv("T2"), [() => { nodefs.writeFileSync(path.join(b.repo, "written-by-child"), "x"); return T2_OK(); }]);
  assert.equal(dirty.r.summary.verdict, "FAIL");
  assert.equal(dirty.r.exitCode, 1);
  assert.ok(dirty.d.io.lines.some((l) => /hygiene failure: the clone changed/.test(l)));
  const i = box();
  const inTmp = path.join(i.repo, "tmp");
  nodefs.mkdirSync(inTmp);
  const out = await run(i, i.initArgv(), [[init()]], { tmpRoot: inTmp });
  assert.equal(out.r.exitCode, 2);
  assert.equal(out.client.calls.length, 0);
  assert.deepEqual(nodefs.readdirSync(inTmp), []);
  const t = box();
  const inTmp2 = path.join(t.repo, "tmp");
  nodefs.mkdirSync(inTmp2);
  const turn = await run(t, withTurnArgv(t), [[init(), result(0.25)]], { tmpRoot: inTmp2 });
  assert.equal(turn.r.exitCode, 2);
  assert.deepEqual(nodefs.readdirSync(inTmp2), []);
  assert.equal(nodefs.existsSync(`${t.ledger}.lock`), false);
});

test("F21. a failed evidence write is a run failure, exit 3, never PASS: at the start, mid-stream and on the summary", async () => {
  const swapOut = (b) => { nodefs.writeFileSync(b.p("afile"), "x"); const a = b.argv("T2"); a[a.indexOf("--out") + 1] = b.p("afile"); return a; };
  const a = box();
  const blocked = await run(a, swapOut(a), [T2_OK()]);
  assert.equal(blocked.r.exitCode, 3);
  assert.equal(blocked.client.calls.length, 0);

  const bad = (match) => ({
    ...nodefs,
    appendFileSync: (p, ...r) => { if (match(String(p))) throw new Error("disk full"); return nodefs.appendFileSync(p, ...r); },
    writeFileSync: (p, ...r) => { if (match(String(p))) throw new Error("disk full"); return nodefs.writeFileSync(p, ...r); },
  });
  for (const name of ["summary.json"]) {
    const b = box();
    const { r } = await run(b, b.argv("T2"), [T2_OK()], { fs: bad((p) => p.endsWith(name)) });
    assert.equal(r.exitCode, 3, name);
    assert.match(r.summary.verdict, /evidence write failed/);
    assert.ok(!/^PASS/.test(b.rowsOf().at(-1).verdict));
  }
  const s = box();
  let first = true;
  const midStream = {
    ...nodefs,
    appendFileSync: (p, ...r) => { if (String(p).endsWith("stream.jsonl")) { if (first) { first = false; throw new Error("disk full"); } } return nodefs.appendFileSync(p, ...r); },
  };
  const m = await run(s, s.argv("T2"), [T2_OK()], { fs: midStream });
  assert.equal(m.r.exitCode, 3);
  assert.ok(!/^PASS/.test(s.rowsOf().at(-1).verdict));
  assert.ok(!/^PASS/.test(s.summary().verdict));
  assert.equal(s.summary().exitCode, 3);
});

test("F21. hygiene: a credential- or token-named file in the config or home directory fails the run and is printed", async () => {
  for (const where of ["cfg", "home"]) {
    const b = box();
    const { r, d } = await run(b, b.argv("T2"), [(args) => {
      const dir = where === "cfg" ? b.cfg : args.options.env.HOME;
      nodefs.writeFileSync(path.join(dir, ".credentials.json"), "x");
      return T2_OK();
    }]);
    assert.equal(r.exitCode, 1, where);
    assert.equal(r.summary.verdict, "FAIL");
    assert.match(r.summary.notes.join(" "), /credential-named file/);
    assert.ok(d.io.lines.some((l) => /hygiene failure/.test(l)));
  }
  const i = box();
  const out = await run(i, i.initArgv(), [(args) => { nodefs.writeFileSync(path.join(args.options.env.HOME, "token.txt"), "x"); return [initForm()]; }]);
  assert.equal(out.r.exitCode, 1);
  assert.deepEqual(out.d.io.lines, []);
  assert.match(out.d.io.errors.join(" "), /hygiene failure/);
});

test("F25. token test: a secret in tool output and answer text never reaches stream.jsonl, summary.json, the ledger, findings or the console", async () => {
  const b = box();
  let access = null;
  const secretPath = `${SOME_HOME}/private/file`;
  const { r, d } = await run(b, b.argv("ISSUE2"), [(args) => {
    access = args.options.mcpServers.quadron.headers.Authorization.slice(7);
    const leak = `key ${KEY} refresh ${REFRESH} access ${access} path ${secretPath} refresh_token=abc123xyz Bearer plainvalue capture_owner_unavailable`;
    return [init({ session_id: "s", cwd: `${SOME_HOME}/cwd` }),
      toolUse("r", READ, { q: leak, access_token: "plain-under-a-key" }),
      toolResult("r", leak),
      assistantText(`Keep this? It keeps raw streams ${leak}`),
      result(0.1, { session_id: "s", result: `Keep this? It keeps raw streams ${leak}` })];
  }]);
  assert.equal(r.exitCode, 0);
  const dir = path.join(b.out, b.attemptDirs()[0]);
  const stream = nodefs.readFileSync(path.join(dir, "stream.jsonl"), "utf8");
  const summary = nodefs.readFileSync(path.join(dir, "summary.json"), "utf8");
  assert.match(stream, /<redacted>/);
  assert.match(summary, /<redacted>/);
  for (const text of [stream, summary, everything(b, d)]) {
    for (const s of [KEY, REFRESH, access, SOME_HOME, "abc123xyz", "plainvalue", "plain-under-a-key"]) assert.ok(!text.includes(s), s);
  }
  assert.equal(b.findings()[0].kind, "capture_owner_unavailable");
});

test("G10. evidence keeps cwd and path arguments readable and masks only the home and credentials; the console stays strict", async () => {
  const b = box();
  const readable = ["/opt/data/SKILL.md", "/mnt/c/work/plugin/README.md", "C:\\work\\plugin\\x.md", "https://staging.quadron.tech/mcp"];
  const { r, client, d } = await run(b, b.argv("ISSUE2"), [[
    init({ session_id: "s" }),
    toolUse("r", READ, { paths: readable, under_home: `${SOME_HOME}/private/file`, url: "https://me:hunter2@host.example/x" }),
    toolResult("r", `read ${readable.join(" ")} token ${KEY}`),
    assistantText("Keep this? It keeps raw streams."),
    result(0.1, { session_id: "s", result: "Keep this? It keeps raw streams." }),
  ]]);
  assert.equal(r.exitCode, 0);
  const dir = path.join(b.out, b.attemptDirs()[0]);
  for (const name of ["summary.json", "stream.jsonl"]) {
    const text = nodefs.readFileSync(path.join(dir, name), "utf8");
    for (const p of readable) assert.ok(text.includes(JSON.stringify(p).slice(1, -1)), `${name} ${p}`);
    assert.ok(text.includes("~/private/file"), name);
    for (const s of [SOME_HOME, KEY, "hunter2"]) assert.ok(!text.includes(s), `${name} ${s}`);
  }
  const s = b.summary();
  assert.equal(s.cwd, client.calls[0].options.cwd);
  assert.deepEqual(s.toolCalls[0].input.paths, readable);
  assert.ok(s.command.includes(b.ledger));
  const red = new Redactor({ home: SOME_HOME, repoRoot: "/repo-root" });
  assert.equal(red.text("/repo-root/c /opt/x", { keepPaths: true }), "/repo-root/c /opt/x");
  assert.equal(red.text("/repo-root/c https://x.example.test/p"), "<repository root>/c <url>");
  assert.ok(!d.io.lines.concat(d.io.errors).join("\n").includes("/opt/data"));
});

test("redaction: secrets, bearer values, URLs, home and repository paths are masked, and a number under a token-named key stays", () => {
  const r = new Redactor({ home: SOME_HOME, repoRoot: "/repo-root" });
  r.add("super-secret-value");
  const out = r.text(`super-secret-value Bearer abc123 https://x.example.test/p ${SOME_HOME}/a/b /repo-root/c C:\\Users\\bob\\x`);
  for (const s of ["super-secret-value", "abc123", "x.example.test", "someone", "bob"]) assert.ok(!out.includes(s), s);
  assert.deepEqual(r.deep({ output_tokens: 5, access_token: "x" }), { output_tokens: 5, access_token: "<redacted>" });
});

// ---------------------------------------------------------------- pin and head

test("F23. the installed version is checked against the pin, reading only package.json files; a mismatch refuses before any call", async () => {
  const b = box();
  const installed = path.join(b.journey, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
  nodefs.writeFileSync(installed, JSON.stringify({ version: "9.9.9" }));
  const { r, client, d } = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(r.exitCode, 2);
  assert.equal(client.calls.length, 0);
  assert.match(d.io.errors.join(" "), /does not match the pin/);
  nodefs.unlinkSync(installed);
  assert.equal((await run(b, b.argv("T2"), [T2_OK()])).r.exitCode, 2);
  const real = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
  assert.equal(checkInstalledSdk(real, nodefs), "0.3.316");
});

test("head: read from git's files for a plain ref, a packed ref, a linked worktree and a detached head; unreadable refuses", async () => {
  const b = box();
  assert.equal(readHead(b.repo, nodefs), HEAD);
  const sha = "c".repeat(40);
  const plain = b.p("plain");
  nodefs.mkdirSync(path.join(plain, ".git/refs/heads"), { recursive: true });
  nodefs.writeFileSync(path.join(plain, ".git/HEAD"), "ref: refs/heads/main\n");
  nodefs.writeFileSync(path.join(plain, ".git/refs/heads/main"), `${sha}\n`);
  assert.equal(readHead(plain, nodefs), sha);
  const packed = b.p("packed");
  nodefs.mkdirSync(path.join(packed, ".git"), { recursive: true });
  nodefs.writeFileSync(path.join(packed, ".git/HEAD"), "ref: refs/heads/main\n");
  nodefs.writeFileSync(path.join(packed, ".git/packed-refs"), `# pack-refs\n${sha} refs/heads/main\n`);
  assert.equal(readHead(packed, nodefs), sha);
  const wt = b.p("wt");
  nodefs.mkdirSync(wt);
  nodefs.mkdirSync(path.join(plain, ".git/worktrees/w"), { recursive: true });
  nodefs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(plain, ".git/worktrees/w")}\n`);
  nodefs.writeFileSync(path.join(plain, ".git/worktrees/w/HEAD"), "ref: refs/heads/main\n");
  nodefs.writeFileSync(path.join(plain, ".git/worktrees/w/commondir"), "../..\n");
  assert.equal(readHead(wt, nodefs), sha);
  assert.throws(() => readHead(b.p("nowhere"), nodefs), /head commit/);
  const noHead = box();
  nodefs.unlinkSync(path.join(noHead.repo, ".git/HEAD"));
  assert.equal((await run(noHead, noHead.argv("T2"), [T2_OK()])).r.exitCode, 2);
});
