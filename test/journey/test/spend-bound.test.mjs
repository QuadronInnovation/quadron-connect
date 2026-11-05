// The spend stop as a hard bound, on real temp files with a fake client.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodefs from "node:fs";
import path from "node:path";
import { main } from "../lib/main.mjs";
import { CAMPAIGN_CEILING_USD, DEFAULT_CONTEXT_TOKENS, MAX_OUTPUT_TOKENS, MODEL_RATES, worstCase } from "../lib/spend.mjs";
import {
  box, fakeClient, liveEnv, init, initForm, result, assistantText, toolUse, toolResult, T2_OK, T4_OK, T5_OK, ISSUE2_OK, OPUS, HAIKU, OFFER, READ, WORST_OPUS, WORST_HAIKU, reserveLine, settleLine, spent, callEntry, WORKSPACE, CAMPAIGN, rowEntry,
} from "./helpers.mjs";

const run = (b, argv, scripts, over = {}, env = liveEnv()) => {
  const client = Array.isArray(scripts) ? fakeClient(scripts) : scripts;
  const d = b.deps(over);
  return main({ argv, env: { ...b.campaign, ...env }, client, ...d }).then((r) => ({ r, client, d }));
};
const near = (a, e) => assert.ok(Math.abs(a - e) < 1e-9, `${a} vs ${e}`);
const errors = (out) => out.d.io.errors.join(" ");

// ---------------------------------------------------------------- the worst case

test("H1. the constants: the ceiling is 5, the output limit 4096, the context 100,000, and the rates are the published ones", () => {
  assert.equal(CAMPAIGN_CEILING_USD, 5);
  assert.equal(MAX_OUTPUT_TOKENS, 4096);
  assert.equal(DEFAULT_CONTEXT_TOKENS, 100_000);
  assert.deepEqual(MODEL_RATES["claude-opus-5-5"], { family: "opus", input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 });
  assert.deepEqual(MODEL_RATES["claude-haiku-5-5"], { family: "haiku", input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 });
  assert.deepEqual(Object.keys(MODEL_RATES).sort(), ["claude-haiku-5-5", "claude-opus-5-5"]);
});

test("H1. worst case arithmetic: session budget + output limit x output price + context x the higher of input and cache write", () => {
  near(worstCase({ model: OPUS, sessionUsd: 0.5 }).reservationUsd, 0.5 + 0.08192 + 0.5);
  near(worstCase({ model: HAIKU, sessionUsd: 0.05 }).reservationUsd, 0.05 + 0.01024 + 0.0625);
  near(worstCase({ model: OPUS, sessionUsd: 1, measuredTokens: 20_000 }).reservationUsd, 1 + 0.08192 + 0.5); // D1: never below the constant
  near(worstCase({ model: OPUS, sessionUsd: 1, measuredTokens: 150_000 }).reservationUsd, 1 + 0.08192 + 0.75);
  near(worstCase({ model: OPUS, sessionUsd: 1, maxOutputTokens: 1000 }).reservationUsd, 1 + 0.02 + 0.5);
  assert.equal(worstCase({ model: OPUS, sessionUsd: 1 }).contextSource, "constant");
  assert.equal(worstCase({ model: OPUS, sessionUsd: 1, measuredTokens: 5 }).contextSource, "constant");
  assert.equal(worstCase({ model: OPUS, sessionUsd: 1, measuredTokens: 100_000 }).contextSource, "constant");
  assert.equal(worstCase({ model: OPUS, sessionUsd: 1, measuredTokens: 150_000 }).contextSource, "measured");
  assert.throws(() => worstCase({ model: "claude-opus", sessionUsd: 1 }), /exactly one of/);
});

// ---------------------------------------------------------------- required tests

test("H1. successive commands stop before a call whose worst case would pass 5: exit 2, and that call does not start", async () => {
  const b = box();
  let started = 0;
  const go = async (row, scripts) => {
    const out = await run(b, b.argv(row), scripts);
    started += out.client.calls.length;
    return out;
  };
  assert.equal((await go("T2", [T2_OK(1, "a")])).r.exitCode, 0);
  near(b.charged(), 1);
  assert.equal((await go("ISSUE2", [ISSUE2_OK(1, "b")])).r.exitCode, 0);
  near(b.charged(), 2);
  assert.equal((await go("T5", T5_OK(0.75, 1.5))).r.exitCode, 0);
  near(b.charged(), 3.5);
  assert.equal(started, 4);
  // 3.5 + 1.58192 > 5, though 3.5 + the session budget of 1 would have fitted.
  const next = await go("T4", T4_OK());
  assert.equal(next.r.exitCode, 2);
  assert.equal(next.client.calls.length, 0);
  assert.deepEqual(next.client.prompts, []);
  assert.match(errors(next), /total ceiling/);
  assert.equal(started, 4);
  near(b.charged(), 3.5);
  assert.ok(b.charged() <= 5);
});

test("H1. a new ledger with the same record still refuses", async () => {
  const b = box({ record: spent("earlier", 3.5) });
  const fresh = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(fresh.r.exitCode, 2);
  assert.equal(fresh.client.calls.length, 0);
  // The ledger emptied, then a new file at another path: the record still holds the spend.
  nodefs.writeFileSync(b.ledger, JSON.stringify({ entries: [] }));
  assert.equal((await run(b, b.argv("T2"), [T2_OK()])).r.exitCode, 2);
  const other = b.p("other-ledger.json");
  nodefs.writeFileSync(other, JSON.stringify({ entries: [] }));
  const argv = b.argv("T2");
  argv[argv.indexOf("--ledger") + 1] = other;
  const moved = await run(b, argv, [T2_OK()]);
  assert.equal(moved.r.exitCode, 2);
  assert.equal(moved.client.calls.length, 0);
  assert.equal(JSON.parse(nodefs.readFileSync(other, "utf8")).entries.filter((e) => e.kind === "call").length, 0);
});

test("H1. --max-total-usd 50 refuses, exit 2, on rows and init with a turn; a lower value lowers the ceiling", async () => {
  const b = box();
  const row = await run(b, b.argv("T2", { total: "50" }), [T2_OK()]);
  assert.equal(row.r.exitCode, 2);
  assert.equal(row.client.calls.length, 0);
  assert.match(errors(row), /above the campaign ceiling of 5/);
  const just = await run(b, b.argv("T2", { total: "5.01" }), [T2_OK()]);
  assert.equal(just.r.exitCode, 2);
  const turn = await run(b, b.initArgv(["--init-only-with-turn", "--model", HAIKU, "--ledger", b.ledger, "--max-session-usd", "1", "--max-run-usd", "2", "--max-total-usd", "50"]), [[init(), result(0.25)]]);
  assert.equal(turn.r.exitCode, 2);
  assert.equal(turn.client.calls.length, 0);
  const lowered = await run(b, b.argv("T2", { total: "1.5" }), [T2_OK()]); // 1.58192 does not fit under 1.5
  assert.equal(lowered.r.exitCode, 2);
  assert.equal(lowered.client.calls.length, 0);
  assert.equal(b.calls().length, 0);
});

test("H1. --max-total-usd is optional: the constant applies without it", async () => {
  const b = box({ record: spent("earlier", 3.5) });
  const refused = await run(b, b.argv("T2", { total: null }), [T2_OK()]);
  assert.equal(refused.r.exitCode, 2);
  const c = box();
  assert.equal((await run(c, c.argv("T2", { total: null }), [T2_OK()])).r.exitCode, 0);
});

test("H1. separate invocations share the record, whichever model spent it", async () => {
  const b = box({ entries: [rowEntry({ row: "T2" })] });
  const a = await run(b, b.argv("ISSUE2"), [ISSUE2_OK(1.25, "a")]);
  assert.equal(a.r.exitCode, 0);
  const c = await run(b, b.argv("T2", { model: HAIKU }), [T2_OK(1, "c")]);
  assert.equal(c.r.exitCode, 0);
  near(b.charged(), 2.25);
  const lines = b.recordLines();
  assert.deepEqual(lines.filter((l) => l.type !== "limit").map((l) => l.type), ["reserve", "settle", "reserve", "settle"]);
  near(lines.find((l) => l.type === "reserve" && l.model === OPUS).reservationUsd, WORST_OPUS);
  near(lines.find((l) => l.type === "reserve" && l.model === HAIKU).reservationUsd, WORST_HAIKU);
  assert.deepEqual(new Set(lines.map((l) => l.workspace)), new Set([WORKSPACE]));
  assert.deepEqual(new Set(lines.map((l) => l.campaign)), new Set([CAMPAIGN]));
  assert.ok(lines.filter((l) => l.type === "reserve").every((l) => l.head && l.row && l.contextSource === "constant" && l.maxOutputTokens === 4096));
});

test("H1. a kill-shaped open reservation stays charged at its reservation, on a new ledger too", async () => {
  const killed = [reserveLine("killed", 3.5)]; // no settle line: the process died mid-call
  const b = box({ record: killed });
  const out = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(out.r.exitCode, 2); // 3.5 + 1.58192 > 5
  assert.equal(out.client.calls.length, 0);
  const fits = box({ record: [reserveLine("killed", 3)] });
  assert.equal((await run(fits, fits.argv("T2"), [T2_OK(0.1)])).r.exitCode, 0);
  near(fits.charged(), 3.1);
});

test("H1. a real reservation is on disk before the prompt, stays charged if the process dies there, and is settled afterwards", async () => {
  const b = box();
  let during = null;
  const { r } = await run(b, b.argv("T2"), [() => { during = nodefs.readFileSync(b.record, "utf8"); return T2_OK(0.25); }]);
  assert.equal(r.exitCode, 0);
  const lines = during.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.type !== "limit");
  assert.equal(lines.length, 1); // what a kill at this moment would leave
  assert.equal(lines[0].type, "reserve");
  near(lines[0].reservationUsd, WORST_OPUS);
  near(lines[0].sessionUsd, 1);
  near(lines[0].responseUsd, WORST_OPUS - 1);
  near(b.charged(), 0.25);
});

test("H1. a fake overshooting within one response stays under the line: the session budget plus one response is what was reserved", async () => {
  const b = box({ record: spent("earlier", 3.4) });
  const out = await run(b, b.argv("T2"), [T2_OK(WORST_OPUS)]); // budget 1, reports 1.58192
  assert.equal(out.r.exitCode, 0);
  near(b.charged(), 3.4 + WORST_OPUS);
  assert.ok(b.charged() <= 5);
  const next = await run(b, b.argv("ISSUE2"), [ISSUE2_OK()]);
  assert.equal(next.r.exitCode, 2);
  assert.equal(next.client.calls.length, 0);
  assert.ok(b.charged() <= 5);
});

test("H1. a fake overshooting past its reservation breaks the bound's assumption: charged in full, stopped at once and loudly, and the next command refuses", async () => {
  const b = box();
  const over = await run(b, b.argv("T2"), [T2_OK(4.5)]);
  assert.equal(over.r.exitCode, 3);
  assert.equal(over.r.summary.partial, true);
  assert.match(over.r.summary.stoppedBecause, /passed its reservation/);
  near(b.charged(), 4.5);
  const next = await run(b, b.argv("ISSUE2"), [ISSUE2_OK()]);
  assert.equal(next.r.exitCode, 2);
  assert.equal(next.client.calls.length, 0);
  const two = box();
  const mid = await run(two, two.argv("T4"), T4_OK({ first: 4.5, second: 4.6 }));
  assert.equal(mid.client.calls.length, 1); // turn 2 never starts
  assert.equal(mid.r.exitCode, 3);
  assert.match(mid.r.summary.verdict, /PARTIAL/);
});

test("H1. absent record variables refuse, exit 2, and no flag can supply them", async () => {
  const b = box();
  const client = fakeClient([T2_OK()]);
  for (const missing of ["QUADRON_CAMPAIGN_RECORD", "QUADRON_CAMPAIGN_WORKSPACE", "QUADRON_CAMPAIGN_ID"]) {
    const env = { ...b.campaign, ...liveEnv() };
    delete env[missing];
    const d = b.deps();
    const r = await main({ argv: b.argv("T2"), env, client, ...d });
    assert.equal(r.exitCode, 2, missing);
    assert.match(d.io.errors.join(" "), new RegExp(missing));
  }
  const none = b.deps();
  assert.equal((await main({ argv: b.argv("T2"), env: liveEnv(), client, ...none })).exitCode, 2);
  for (const flag of ["--record", "--campaign-record", "--campaign-id", "--campaign-workspace", "--QUADRON_CAMPAIGN_RECORD", "--quadron-campaign-record"]) {
    const d = b.deps();
    const r = await main({ argv: [...b.argv("T2"), flag, b.record], env: liveEnv(), client, ...d });
    assert.equal(r.exitCode, 2, flag);
    assert.match(d.io.errors.join(" "), /unknown flag/);
  }
  assert.equal((await main({ argv: b.initArgv(), env: liveEnv(), client, ...b.deps() })).exitCode, 2);
  assert.equal(client.calls.length, 0);
  assert.equal(b.calls().length, 0);
});

// ---------------------------------------------------------------- the record's state

test("H1. an empty record is a total of zero; a missing one refuses and is never created", async () => {
  const b = box();
  assert.equal(nodefs.statSync(b.record).size, 0);
  const ok = await run(b, b.argv("T2"), [T2_OK(0.5)]);
  assert.equal(ok.r.exitCode, 0);
  near(b.charged(), 0.5);
  for (const content of ["﻿", "\r\n", "\n\n"]) { // what a script's own empty file may hold
    const c = box();
    nodefs.writeFileSync(c.record, content);
    assert.equal((await run(c, c.argv("T2"), [T2_OK(0.5)])).r.exitCode, 0, JSON.stringify(content));
    near(c.charged(), 0.5);
  }
  const m = box();
  nodefs.unlinkSync(m.record);
  const gone = await run(m, m.argv("T2"), [T2_OK()]);
  assert.equal(gone.r.exitCode, 2);
  assert.equal(gone.client.calls.length, 0);
  assert.match(errors(gone), /missing or unreadable/);
  assert.equal(nodefs.existsSync(m.record), false);
  assert.equal(nodefs.existsSync(`${m.record}.lock`), false);
});

test("H1. a corrupt or unreadable record refuses before any call, exit 2", async () => {
  const lines = (...o) => o.map((l) => JSON.stringify(l)).join("\n");
  for (const content of [
    "{not json",
    "[1]",
    lines({ type: "reserve" }),
    lines(reserveLine("a", -1)),
    lines(reserveLine("a", 1), reserveLine("a", 1)),
    lines(settleLine("a", 1)),
    lines(reserveLine("a", 1), settleLine("a", 1), settleLine("a", 1)),
    lines(reserveLine("a", 1), settleLine("a", "x")),
    lines(reserveLine("a", 1), settleLine("a", 0, { actualUsd: null })), // no reported cost must stay at its reservation
    lines({ type: "other", workspace: WORKSPACE, campaign: CAMPAIGN }),
    `${lines(reserveLine("a", 1))}\n{"type":"settle","work`, // a torn last line
  ]) {
    const b = box();
    nodefs.writeFileSync(b.record, content);
    const { r, client, d } = await run(b, b.argv("T2"), [T2_OK()]);
    assert.equal(r.exitCode, 2, content);
    assert.equal(client.calls.length, 0, content);
    assert.match(d.io.errors.join(" "), /corrupt/, content);
    assert.equal(nodefs.readFileSync(b.record, "utf8"), content); // left on disk untouched
  }
  const dir = box();
  nodefs.unlinkSync(dir.record);
  nodefs.mkdirSync(dir.record);
  assert.equal((await run(dir, dir.argv("T2"), [T2_OK()])).r.exitCode, 2);
});

test("H1. the record inside the clone refuses, also through a link; a relative path or a bad label refuses", async () => {
  const b = box();
  const inside = path.join(b.repo, "campaign.jsonl");
  nodefs.writeFileSync(inside, "");
  const one = await run(b, b.argv("T2"), [T2_OK()], {}, liveEnv({ QUADRON_CAMPAIGN_RECORD: inside }));
  assert.equal(one.r.exitCode, 2);
  assert.match(errors(one), /outside the clone/);
  nodefs.symlinkSync(inside, b.p("link.jsonl"));
  const viaLink = await run(b, b.argv("T2"), [T2_OK()], {}, liveEnv({ QUADRON_CAMPAIGN_RECORD: b.p("link.jsonl") }));
  assert.equal(viaLink.r.exitCode, 2);
  assert.equal(viaLink.client.calls.length, 0);
  assert.equal(nodefs.readFileSync(inside, "utf8"), "");
  assert.equal((await run(b, b.argv("T2"), [T2_OK()], {}, liveEnv({ QUADRON_CAMPAIGN_RECORD: "campaign.jsonl" }))).r.exitCode, 2);
  assert.equal((await run(b, b.argv("T2"), [T2_OK()], {}, liveEnv({ QUADRON_CAMPAIGN_ID: "has space" }))).r.exitCode, 2);
  assert.equal((await run(b, b.argv("T2"), [T2_OK()], {}, liveEnv({ QUADRON_CAMPAIGN_WORKSPACE: "../x" }))).r.exitCode, 2);
});

test("H1. the record is keyed: another workspace's or campaign's lines do not count, and are kept", async () => {
  const others = [...spent("a", 4.9, { workspace: "other-workspace" }), ...spent("a", 4.9, { campaign: "other-campaign" })];
  const b = box({ record: others });
  assert.equal((await run(b, b.argv("T2"), [T2_OK(0.5)])).r.exitCode, 0);
  const lines = b.recordLines();
  assert.equal(lines.filter((l) => l.workspace === "other-workspace").length, 2);
  assert.equal(lines.filter((l) => l.campaign === "other-campaign").length, 2);
  // The same record under the other label is charged what it spent there.
  const refused = await run(b, b.argv("ISSUE2"), [ISSUE2_OK()], {}, liveEnv({ QUADRON_CAMPAIGN_ID: "other-campaign" }));
  assert.equal(refused.r.exitCode, 2);
});

test("H1. the record is only ever appended", async () => {
  const seed = [...spent("x", 0.5)];
  const b = box({ record: seed });
  const before = nodefs.readFileSync(b.record, "utf8");
  await run(b, b.argv("T2"), [T2_OK(0.1)]);
  const after = nodefs.readFileSync(b.record, "utf8");
  assert.ok(after.startsWith(before));
  assert.ok(after.length > before.length);
});

test("H1. the record's lock refuses a second run on a different ledger, is named, and is never removed", async () => {
  const b = box();
  nodefs.writeFileSync(`${b.record}.lock`, "");
  const out = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(out.r.exitCode, 2);
  assert.equal(out.client.calls.length, 0);
  assert.match(errors(out), /campaign\.jsonl\.lock/);
  assert.equal(nodefs.existsSync(`${b.record}.lock`), true);
  assert.equal(nodefs.existsSync(`${b.ledger}.lock`), false); // the first lock is given back
  nodefs.unlinkSync(`${b.record}.lock`);
  let during = null;
  const ok = await run(b, b.argv("T2"), [() => { during = nodefs.existsSync(`${b.record}.lock`); return T2_OK(); }]);
  assert.equal(ok.r.exitCode, 0);
  assert.equal(during, true);
  assert.equal(nodefs.existsSync(`${b.record}.lock`), false);
});

test("H1. a record that cannot be appended to stops the call before it starts; after a call the reservation stands and the run stops", async () => {
  const noWrite = (when) => ({
    ...nodefs,
    writeSync: (fd, line) => { if (when(line)) throw new Error("disk full"); return nodefs.writeSync(fd, line); },
  });
  const a = box();
  const first = await run(a, a.argv("T2", { total: null }), [T2_OK()], { fs: noWrite((l) => l.includes('"reserve"')) });
  assert.equal(first.r.exitCode, 3);
  assert.equal(first.client.calls.length, 0);
  const b = box();
  const after = await run(b, b.argv("T4", { total: null }), T4_OK(), { fs: noWrite((l) => l.includes('"settle"')) });
  assert.equal(after.r.exitCode, 3);
  assert.equal(after.client.calls.length, 1); // turn 2 never starts
  assert.match(after.r.summary.stoppedBecause, /reservation stands/);
  near(b.charged(), WORST_OPUS);
});

// ---------------------------------------------------------------- within a row

test("H1. inside a two-turn row each call is checked: turn 2 stops, exit 3, partial, when its worst case would pass the line", async () => {
  const b = box({ record: spent("earlier", 3.3) });
  const { r, client } = await run(b, b.argv("T4"), T4_OK({ first: 0.3 })); // 3.3 + 1.58 fits; 3.6 + 1.58 does not
  assert.equal(client.calls.length, 1);
  assert.equal(r.exitCode, 3);
  assert.equal(r.summary.partial, true);
  assert.match(r.summary.stoppedBecause, /total ceiling/);
  near(b.charged(), 3.6);
});

const turnOneUsing = (first, tokens) => {
  const scripts = T4_OK({ first, second: first + 0.05 });
  scripts[0][2] = result(first, { session_id: "s9", result: OFFER, usage: { input_tokens: 10, cache_creation_input_tokens: tokens - 10, cache_read_input_tokens: 0 } });
  return scripts;
};

test("D1. a small measured prompt never shrinks turn 2's reservation; a larger one raises it; a new command starts again from the constant", async () => {
  const small = box();
  await run(small, small.argv("T4"), turnOneUsing(0.1, 20_000));
  const low = small.recordLines().filter((l) => l.type === "reserve");
  assert.equal(low[0].contextSource, "constant");
  near(low[0].reservationUsd, WORST_OPUS);
  assert.equal(low[1].contextSource, "constant");
  assert.equal(low[1].contextTokens, 100_000);
  near(low[1].reservationUsd, WORST_OPUS);

  const large = box();
  await run(large, large.argv("T4"), turnOneUsing(0.1, 150_000));
  const high = large.recordLines().filter((l) => l.type === "reserve");
  assert.equal(high[1].contextSource, "measured");
  assert.equal(high[1].contextTokens, 150_000);
  near(high[1].reservationUsd, 1 + 0.08192 + 0.75);
  await run(large, large.argv("T2"), [T2_OK()]);
  assert.equal(large.recordLines().filter((l) => l.type === "reserve")[2].contextSource, "constant");
});

test("D1. a two-turn row starting turn 2 from 3.91808 refuses it: exit 3, partial, one call, and the total stays at 3.91808", async () => {
  const b = box({ record: spent("earlier", 3.31808) });
  const { r, client } = await run(b, b.argv("T4"), turnOneUsing(0.6, 1_000)); // turn 1: 3.31808 + 1.58192 fits
  assert.equal(client.calls.length, 1);
  assert.equal(r.exitCode, 3);
  assert.equal(r.summary.partial, true);
  assert.match(r.summary.stoppedBecause, /total ceiling/);
  near(b.charged(), 3.91808);
});

test("D1. the same stop below the old shrunk line: from 3.5, where a measured 20,000 used to reserve only 1.18192", async () => {
  const b = box({ record: spent("earlier", 3.4) });
  const { r, client } = await run(b, b.argv("T4"), turnOneUsing(0.1, 20_000));
  assert.equal(client.calls.length, 1);
  assert.equal(r.exitCode, 3);
  near(b.charged(), 3.5);
});

test("D1. the calculated worst case with the output cap honoured: turn 2 starts from 3.41808 at most, and a full spend of its reservation lands on 5.00", async () => {
  const b = box({ record: spent("earlier", 3.31808) });
  const scripts = T4_OK({ first: 0.1, second: 0.1 + WORST_OPUS }); // cumulative on the resumed session
  const { r, client } = await run(b, b.argv("T4"), scripts);
  assert.equal(client.calls.length, 2);
  assert.equal(r.exitCode, 0);
  near(b.charged(), 5);
  const over = box({ record: spent("earlier", 3.31809) }); // a hundred-thousandth of a dollar more, and turn 2 never starts
  const refused = await run(over, over.argv("T4"), T4_OK({ first: 0.1 }));
  assert.equal(refused.client.calls.length, 1);
  assert.equal(refused.r.exitCode, 3);
  assert.ok(over.charged() <= 5);
});

test("H1. a kill mid-row leaves the record charging the open call, and the ledger's attempt stands", async () => {
  const killedAt = [...spent("r-1", 0.1), reserveLine("r-2", WORST_OPUS)];
  const entries = [callEntry({ row: "T4", turn: 1, status: "closed" }), callEntry({ row: "T4", turn: 2, status: "open" })];
  const b = box({ record: killedAt, entries });
  const { r } = await run(b, b.argv("T2"), [T2_OK(0.2)]);
  assert.equal(r.exitCode, 0);
  near(b.charged(), 0.1 + WORST_OPUS + 0.2);
});

// ---------------------------------------------------------------- init with a turn

const withTurn = (b, { session = "1", run: runUsd = "10", extra = [] } = {}) => b.initArgv(["--init-only-with-turn", "--model", HAIKU, "--ledger", b.ledger, "--max-session-usd", session, "--max-run-usd", runUsd, ...extra]);

test("H1. init with a turn: reserved and settled on the record, refused when its worst case passes the line, needing the same variables", async () => {
  const b = box();
  const ok = await run(b, withTurn(b), [[initForm(), result(0.25)]]);
  assert.equal(ok.r.exitCode, 0);
  near(b.charged(), 0.25);
  assert.equal(b.recordLines().find((l) => l.type === "reserve").row, "INIT");
  near(b.recordLines().find((l) => l.type === "reserve").reservationUsd, WORST_HAIKU);
  const full = box({ record: spent("earlier", 4) });
  const no = await run(full, withTurn(full), [[init(), result(0.25)]]); // 4 + 1.07274 > 5
  assert.equal(no.r.exitCode, 2);
  assert.equal(no.client.calls.length, 0);
  assert.match(errors(no), /total ceiling/);
  const fits = box({ record: spent("earlier", 3.9) });
  assert.equal((await run(fits, withTurn(fits), [[initForm(), result(0.25)]])).r.exitCode, 0);
  assert.equal((await main({ argv: withTurn(b), env: liveEnv(), client: fakeClient([]), ...b.deps() })).exitCode, 2);
});

test("H1. init with a turn: a kill-shaped reservation stays charged; no reported cost stays at the reservation", async () => {
  const b = box({ record: [reserveLine("killed", 4)] });
  const out = await run(b, withTurn(b), [[init(), result(0.25)]]);
  assert.equal(out.r.exitCode, 2);
  assert.equal(out.client.calls.length, 0);
  const n = box();
  const none = await run(n, withTurn(n), [[initForm(), { type: "result", subtype: "success" }]]);
  assert.equal(none.r.exitCode, 3);
  near(n.charged(), WORST_HAIKU);
  const z = box();
  const zero = await run(z, withTurn(z), [[initForm(), result(0)]]);
  assert.equal(zero.r.exitCode, 3);
  near(z.charged(), WORST_HAIKU);
});

test("H1. plain init-only needs the record and validates it, and writes nothing to it", async () => {
  const b = box();
  const ok = await run(b, b.initArgv(), [[initForm()]]);
  assert.equal(ok.r.exitCode, 0);
  assert.equal(nodefs.readFileSync(b.record, "utf8"), "");
  assert.equal(nodefs.existsSync(`${b.record}.lock`), false);
  nodefs.writeFileSync(b.record, "{not json");
  assert.equal((await run(b, b.initArgv(), [[init()]])).r.exitCode, 2);
});

// ---------------------------------------------------------------- run ceiling and limit binding

test("G4. --max-total-usd is stored at first use: a later flag can lower it and never raise it, and a new ledger does not undo it", async () => {
  const b = box();
  assert.equal((await run(b, b.argv("T2", { total: "3" }), [T2_OK(0.1, "a")])).r.exitCode, 0);
  assert.deepEqual(b.entries().filter((e) => e.kind === "limit").map((e) => e.maxTotalUsd), [3]);
  assert.deepEqual(b.recordLines().filter((l) => l.type === "limit").map((l) => l.maxTotalUsd), [3]);
  const raised = await run(b, b.argv("ISSUE2", { total: "4" }), [ISSUE2_OK()]);
  assert.equal(raised.r.exitCode, 2);
  assert.equal(raised.client.calls.length, 0);
  assert.match(errors(raised), /above the 3 USD limit in force/);
  // No flag: the stored limit still applies. 0.1 + 1.58192 fits 3, and the next, seeded higher, does not.
  assert.equal((await run(b, b.argv("ISSUE2", { total: null }), [ISSUE2_OK(1.5, "b")])).r.exitCode, 0);
  const noFlag = await run(b, b.argv("T5", { total: null }), T5_OK());
  assert.equal(noFlag.r.exitCode, 2); // 1.6 + 1.58192 > 3
  assert.match(errors(noFlag), /total ceiling/);
  const fresh = b.p("fresh.json");
  nodefs.writeFileSync(fresh, JSON.stringify({ entries: [] }));
  const argv = b.argv("T5", { total: "4" });
  argv[argv.indexOf("--ledger") + 1] = fresh;
  assert.equal((await run(b, argv, T5_OK())).r.exitCode, 2); // the record remembers
  const lower = box();
  await run(lower, lower.argv("T2", { total: "4" }), [T2_OK(0.1, "a")]);
  assert.equal((await run(lower, lower.argv("ISSUE2", { total: "3" }), [ISSUE2_OK()])).r.exitCode, 0);
  assert.deepEqual(lower.entries().filter((e) => e.kind === "limit").map((e) => e.maxTotalUsd), [4, 3]);
});

test("G4. the ledger's stored limit binds on its own too", async () => {
  const b = box({ entries: [{ kind: "limit", maxTotalUsd: 2, at: "x" }] });
  const out = await run(b, b.argv("T2", { total: "3" }), [T2_OK()]);
  assert.equal(out.r.exitCode, 2);
  assert.equal(out.client.calls.length, 0);
});

test("F1. --max-run-usd holds across commands on the record: worst case against the model's spend", async () => {
  const b = box();
  const opts = { run: "3.2" };
  assert.equal((await run(b, b.argv("T2", opts), [T2_OK(1, "a")])).r.exitCode, 0);
  assert.equal((await run(b, b.argv("ISSUE2", opts), [ISSUE2_OK(1, "b")])).r.exitCode, 0);
  const third = await run(b, b.argv("T5", opts), T5_OK()); // 2 + 1.58192 > 3.2
  assert.equal(third.r.exitCode, 2);
  assert.equal(third.client.calls.length, 0);
  assert.match(errors(third), /run ceiling/);
  near(b.charged(), 2);
});

test("F1. the run ceiling counts only the model in use; another model's spend still counts toward the total", async () => {
  const entries = [rowEntry({ row: "T2", model: OPUS, verdict: "PASS" })];
  const opts = { model: HAIKU, session: "0.5", run: "1", total: "4" };
  const b = box({ entries, record: spent("o", 2) });
  assert.equal((await run(b, b.argv("T2", opts), [T2_OK(0.5)])).r.exitCode, 0); // Haiku 0 + 0.57274 fits 1; 2 + 0.57274 fits 4
  const b2 = box({ entries, record: spent("o", 3.5) });
  const over = await run(b2, b2.argv("T2", opts), [T2_OK(0.5)]);
  assert.equal(over.r.exitCode, 2); // run fits, total does not
  assert.equal(over.client.calls.length, 0);
});

// ---------------------------------------------------------------- a load failure's charge

const badFirst = (cost, o = {}) => ({ messages: [assistantText("from the model"), result(cost, { result: "accepted?", ...o })] });
const late = (cost) => ({ messages: [init({ mcp_servers: [], plugins: [] }), result(cost, { result: "accepted?" })], initTiming: "after" });

test("load charge. a load failure charges the larger of the reservation and a reported cost, and later calls see the larger total", async () => {
  const high = box();
  const out = await run(high, high.argv("T2"), [late(3.56)], { timeoutMs: 20 });
  assert.equal(out.r.exitCode, 3);
  assert.equal(out.r.summary.verdict, "LOAD FAILURE");
  near(high.charged(), 3.56);
  near(high.calls()[0].spend, 3.56);
  const settle = high.recordLines().find((l) => l.type === "settle");
  assert.equal(settle.actualUsd, 3.56);
  assert.equal(settle.chargedUsd, 3.56);
  assert.match(out.r.summary.notes.join(" "), /passed its reservation/);
  const next = await run(high, high.argv("ISSUE2"), [ISSUE2_OK()]); // 3.56 + 1.58192 > 5; at 1.58192 it would have fitted
  assert.equal(next.r.exitCode, 2);
  assert.equal(next.client.calls.length, 0);
  assert.match(errors(next), /total ceiling/);
  const low = box();
  await run(low, low.argv("T2"), [late(0.1)], { timeoutMs: 20 });
  near(low.charged(), WORST_OPUS); // a lower cost never replaces the reservation
  assert.equal(low.recordLines().find((l) => l.type === "settle").actualUsd, null);
});

test("load charge. a result already in hand before the load check tripped counts too: it is a reported cost", async () => {
  const b = box();
  const out = await run(b, b.argv("T2"), [{ messages: [result(3.56, { result: "accepted?" })] }], { timeoutMs: 20 });
  assert.equal(out.r.summary.verdict, "LOAD FAILURE");
  assert.equal(out.r.summary.turns[0].costAfterInterrupt, null);
  near(b.charged(), 3.56);
  const a = box();
  await run(a, a.argv("T2"), [badFirst(3.56)], { timeoutMs: 20 }); // drained after the interrupt
  near(a.charged(), 3.56);
});

test("load charge. the same on the auth failure from init, on a second init's partial stop, and on init with a turn", async () => {
  const auth = box();
  const a = await run(auth, auth.argv("ISSUE2"), [{ messages: [init({ mcp_servers: [{ name: "quadron", status: "needs-auth" }] }), result(3.56, { result: "x" })], initTiming: "after" }], { timeoutMs: 20 });
  assert.equal(a.r.exitCode, 4);
  near(auth.charged(), 3.56);
  const second = box();
  const s = await run(second, second.argv("T2"), [[init({ mcp_servers: [] }), init({ mcp_servers: [], plugins: [] }), result(3.56, { result: "x" })]]);
  assert.equal(s.r.exitCode, 3);
  assert.match(s.r.summary.verdict, /PARTIAL/);
  near(second.charged(), 3.56);
  const turn = box();
  const t = await run(turn, turn.initArgv(["--init-only-with-turn", "--model", HAIKU, "--ledger", turn.ledger, "--max-session-usd", "1", "--max-run-usd", "10"]), [late(3.56)], { timeoutMs: 20 });
  assert.equal(t.r.exitCode, 5);
  near(turn.charged(), 3.56);
  const line = turn.recordLines().find((l) => l.type === "settle");
  assert.equal(line.actualUsd, 3.56);
  const lower = box();
  await run(lower, lower.initArgv(["--init-only-with-turn", "--model", HAIKU, "--ledger", lower.ledger, "--max-session-usd", "1", "--max-run-usd", "10"]), [late(0.1)], { timeoutMs: 20 });
  near(lower.charged(), WORST_HAIKU);
});

test("load charge. a resumed session's total is differenced: turn 2's load failure is charged what turn 2 cost, if that passes its reservation", async () => {
  const [one] = T4_OK({ first: 0.1 });
  const b = box();
  const out = await run(b, b.argv("T4"), [one, { messages: [init({ session_id: "s9", plugins: [] }), result(3.66, { session_id: "s9", result: "x" })], initTiming: "after" }], { timeoutMs: 20 });
  assert.equal(out.r.exitCode, 3);
  assert.equal(out.r.summary.verdict, "LOAD FAILURE");
  near(b.calls()[1].spend, 3.56);
  near(b.charged(), 3.66);
});

test("load charge. the calculated uncapped worst case: from 3.91808 at a session of 0.5, a load failure reporting 3.56 records 7.47808, exit 3, and the next call is refused", async () => {
  const b = box({ record: spent("earlier", 3.91808) });
  const opts = { session: "0.5" };
  const out = await run(b, b.argv("T2", opts), [late(3.56)], { timeoutMs: 20 });
  assert.equal(out.r.exitCode, 3);
  near(b.charged(), 7.47808);
  const next = await run(b, b.argv("ISSUE2", opts), [ISSUE2_OK()]);
  assert.equal(next.r.exitCode, 2);
  assert.equal(next.client.calls.length, 0);
  near(b.charged(), 7.47808);
});

test("load charge. a row ending pending with no connector call charges the larger too", async () => {
  const pending = [{ name: "quadron", status: "pending" }];
  const b = box();
  await run(b, b.argv("ISSUE2"), [[init({ session_id: "s", mcp_servers: pending }), result(3.56, { session_id: "s", result: "x" })]]);
  near(b.charged(), 3.56);
  const low = box();
  await run(low, low.argv("ISSUE2"), [[init({ session_id: "s", mcp_servers: pending }), result(0.1, { session_id: "s", result: "x" })]]);
  near(low.charged(), WORST_OPUS);
  const called = box();
  await run(called, called.argv("ISSUE2"), [[init({ session_id: "s", mcp_servers: pending }), toolUse("r", READ), toolResult("r", "x"), result(0.1, { session_id: "s", result: "x" })]]);
  near(called.charged(), 0.1); // it reached the connector: its actual cost
});

test("F1. boundary: a worst case that lands exactly on the ceiling still runs", async () => {
  const b = box({ record: spent("x", 5 - WORST_OPUS) });
  const { r, client } = await run(b, b.argv("T2"), [T2_OK(0.5)]);
  assert.equal(r.exitCode, 0);
  assert.equal(client.calls.length, 1);
});
