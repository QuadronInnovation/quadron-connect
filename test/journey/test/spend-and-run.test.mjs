import test from "node:test";
import assert from "node:assert/strict";
import * as nodefs from "node:fs";
import path from "node:path";
import { main } from "../lib/main.mjs";
import { SpendTracker } from "../lib/spend.mjs";
import {
  box, fakeClient, liveEnv, init, result, toolUse, toolResult, assistantText, T2_OK, T2_BAD, T4_OK, T5_OK, T6_OK, ISSUE2_OK, OPUS, HAIKU, HEAD, CAPTURE, OFFER, READ, SKILL,
  WORST_OPUS, WORDING, JID, t6Ready, rowEntry, callEntry, fetchStub, reserveLine, settleLine, denial, permissionDenied, OFFER_ROW,
} from "./helpers.mjs";

const run = (b, argv, scripts, over = {}, env = liveEnv()) => {
  const client = Array.isArray(scripts) ? fakeClient(scripts) : scripts;
  const d = b.deps(over);
  return main({ argv, env: { ...b.campaign, ...env }, client, ...d }).then((r) => ({ r, client, d }));
};
const near = (a, e) => assert.ok(Math.abs(a - e) < 1e-9, `${a} vs ${e}`);
const assistantTextCut = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }], stop_reason: "max_tokens" } });

// ---------------------------------------------------------------- ceilings (the bound itself is in spend-bound.test.mjs)

test("F1. cumulative total_cost_usd on a resumed turn is differenced, not added; maxBudgetUsd equals the session budget on every call", async () => {
  const b = box();
  const { r, client } = await run(b, b.argv("T4"), T4_OK());
  assert.equal(r.exitCode, 0);
  assert.equal(client.calls.length, 2);
  for (const c of client.calls) assert.equal(c.options.maxBudgetUsd, 1);
  near(b.calls()[0].spend, 0.1);
  near(b.calls()[1].spend, 0.05);
  const t = new SpendTracker();
  near(t.record("a", 0.1).spend, 0.1);
  near(t.record("a", 0.15).spend, 0.05);
  assert.equal(t.record("a", 0.1).unknown, true);
});

// ---------------------------------------------------------------- ledger and lock

test("F3. an open entry at the reservation is on disk before the prompt goes out, and the actual spend replaces it afterwards", async () => {
  const b = box();
  let during = null;
  const { r } = await run(b, b.argv("T2"), [() => { during = b.calls(); return T2_OK(0.25); }]);
  assert.equal(r.exitCode, 0);
  assert.equal(during.length, 1);
  assert.equal(during[0].status, "open");
  near(during[0].spend, WORST_OPUS);
  near(during[0].ceiling, WORST_OPUS);
  const after = b.calls();
  assert.equal(after.length, 1);
  assert.equal(after[0].status, "closed");
  near(after[0].spend, 0.25);
});

test("F3. an existing lock refuses with exit 2, names the lock and is never removed; a finished run releases its own", async () => {
  const b = box();
  const lock = `${b.ledger}.lock`;
  nodefs.writeFileSync(lock, "");
  const { r, client, d } = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(r.exitCode, 2);
  assert.equal(client.calls.length, 0);
  assert.match(d.io.errors.join(" "), /ledger\.json\.lock/);
  assert.match(d.io.errors.join(" "), /stale/);
  assert.equal(nodefs.existsSync(lock), true);
  nodefs.unlinkSync(lock);
  const two = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(two.r.exitCode, 0);
  assert.equal(nodefs.existsSync(lock), false);
});

test("F3. a lock is held during the call, so a concurrent invocation refuses", async () => {
  const b = box();
  let second = null;
  const first = await run(b, b.argv("T2"), [(args) => {
    assert.ok(args);
    assert.equal(nodefs.existsSync(`${b.ledger}.lock`), true);
    second = main({ argv: b.argv("ISSUE2"), env: { ...b.campaign, ...liveEnv() }, client: fakeClient([ISSUE2_OK()]), ...b.deps() });
    return T2_OK();
  }]);
  assert.equal(first.r.exitCode, 0);
  assert.equal((await second).exitCode, 2);
});

test("F3. missing path, missing file or corrupt ledger refuse with exit 2", async () => {
  const b = box();
  const noFlag = b.argv("T2"); noFlag.splice(noFlag.indexOf("--ledger"), 2);
  assert.equal((await run(b, noFlag, [T2_OK()])).r.exitCode, 2);
  for (const content of ["{not json", JSON.stringify({ entries: [{ kind: "call", spend: "x" }] }), JSON.stringify({ nope: 1 })]) {
    const c = box();
    nodefs.writeFileSync(c.ledger, content);
    const { r, client } = await run(c, c.argv("T2"), [T2_OK()]);
    assert.equal(r.exitCode, 2);
    assert.equal(client.calls.length, 0);
  }
  const m = box();
  nodefs.unlinkSync(m.ledger);
  assert.equal((await run(m, m.argv("T2"), [T2_OK()])).r.exitCode, 2);
});

test("clone. --out, the ledger, the config directory and a temporary directory inside the clone refuse with exit 2 and write nothing; a link into the clone is caught", async () => {
  const b = box();
  const inside = (name) => path.join(b.repo, name);
  nodefs.mkdirSync(inside("cfg"));
  nodefs.writeFileSync(inside("ledger.json"), JSON.stringify({ entries: [] }));
  const swap = (flag, value) => { const a = b.argv("T2"); a[a.indexOf(flag) + 1] = value; return a; };
  for (const argv of [swap("--out", inside("out")), swap("--ledger", inside("ledger.json")), swap("--config-dir", inside("cfg"))]) {
    const { r, client, d } = await run(b, argv, [T2_OK()]);
    assert.equal(r.exitCode, 2);
    assert.equal(client.calls.length, 0);
    assert.match(d.io.errors.join(" "), /outside the clone/);
  }
  assert.equal(nodefs.existsSync(inside("out")), false);
  assert.equal(nodefs.existsSync(`${inside("ledger.json")}.lock`), false);
  assert.equal((await run(b, b.argv("T2"), [T2_OK()], {}, liveEnv({ TMPDIR: inside("tmp") }))).r.exitCode, 2);
  nodefs.symlinkSync(b.repo, b.p("link"));
  const viaLink = await run(b, swap("--out", b.p("link/out")), [T2_OK()]);
  assert.equal(viaLink.r.exitCode, 2);
  assert.equal(nodefs.existsSync(inside("out")), false);
});

test("clone. the clone root defaults to the harness's own location: paths inside the real clone refuse, in live, dry and the confirmation form, and nothing is created", async () => {
  const b = box();
  const realRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "..");
  const inside = path.join(realRoot, "should-not-exist-ledger.json");
  const d = b.deps(); delete d.repoRoot;
  const swap = (a, flag, value) => { const c = [...a]; c[c.indexOf(flag) + 1] = value; return c; };
  const env = { ...b.campaign, ...liveEnv() };
  const live = await main({ argv: swap(b.argv("T2"), "--ledger", inside), env, client: fakeClient([T2_OK()]), ...d });
  assert.equal(live.exitCode, 2);
  const out = await main({ argv: swap(b.argv("T2"), "--out", path.join(realRoot, "should-not-exist-out")), env, client: fakeClient([T2_OK()]), ...d });
  assert.equal(out.exitCode, 2);
  const inRecord = await main({ argv: b.argv("T2"), env: { ...env, QUADRON_CAMPAIGN_RECORD: inside }, client: fakeClient([T2_OK()]), ...d });
  assert.equal(inRecord.exitCode, 2);
  const dry = await main({ argv: ["--dry-run", "--row", "T2", "--ledger", inside], env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, ...d });
  assert.equal(dry.exitCode, 2);
  const mark = await main({ argv: ["--mark-judgment-confirmed", "x", "--ledger", inside], env: {}, ...d });
  assert.equal(mark.exitCode, 2);
  assert.equal(nodefs.existsSync(inside), false);
  assert.equal(nodefs.existsSync(`${inside}.lock`), false);
  assert.equal(nodefs.existsSync(path.join(realRoot, "should-not-exist-out")), false);
});

test("clone. every directory a row hands the child, or writes to, resolves outside the clone, and the clone is unchanged", async () => {
  const b = box();
  const before = nodefs.readdirSync(b.repo).sort();
  const { client } = await run(b, b.argv("T4"), T4_OK());
  for (const c of client.calls) {
    for (const p of [c.options.cwd, c.options.env.HOME, c.options.env.USERPROFILE, c.options.env.CLAUDE_CONFIG_DIR]) assert.ok(!p.startsWith(b.repo), p);
  }
  assert.deepEqual(nodefs.readdirSync(b.repo).sort(), before);
});

// ---------------------------------------------------------------- spend on gates and cost

test("F4. a gate failure before the prompt records zero spend and is no attempt, so it does not poison the ledger", async () => {
  const b = box();
  const bad = await run(b, b.argv("T2"), [[init({ mcp_servers: [], plugin_errors: [{ plugin: "inline[0]", type: "path-not-found", message: "x" }] })]]);
  assert.equal(bad.r.exitCode, 3);
  assert.deepEqual(bad.client.prompts, []);
  assert.equal(b.calls()[0].spend, 0);
  assert.equal(b.calls()[0].promptYielded, false);
  assert.equal((await run(b, b.argv("T2"), [T2_BAD(0.1, "s0")])).r.exitCode, 1); // two real attempts remain
  assert.equal((await run(b, b.argv("T2"), [T2_OK(0.1, "s1")])).r.exitCode, 0);
  near(b.sum(), 0.2);
  near(b.charged(), 0.2);
});

test("F4. a call that started and reports no cost stops the run and stays at its reservation; later runs are not refused for it", async () => {
  const b = box();
  const noCost = [[init({ session_id: "s9" }), { type: "result", subtype: "success", session_id: "s9", result: OFFER }], T2_OK()];
  const { r, client } = await run(b, b.argv("T4"), noCost);
  assert.equal(client.calls.length, 1);
  assert.equal(r.exitCode, 3);
  assert.equal(r.summary.partial, true);
  near(b.calls()[0].spend, WORST_OPUS);
  assert.equal(b.calls()[0].status, "closed");
  const later = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(later.r.exitCode, 0);
  near(b.sum(), WORST_OPUS + 0.1);
  near(b.charged(), WORST_OPUS + 0.1);
});

test("F4. a call that throws after the prompt stays at its reservation and stops the run, exit 3", async () => {
  const b = box();
  const client = fakeClient([{ messages: [init({ mcp_servers: [] })] }]);
  const realQuery = client.query.bind(client);
  client.query = (args) => {
    const q = realQuery(args);
    const it = q[Symbol.asyncIterator];
    q[Symbol.asyncIterator] = async function* () { yield* it(); throw new Error("boom"); };
    return q;
  };
  const { r } = await run(b, b.argv("T2"), client);
  assert.equal(r.exitCode, 3);
  near(b.calls()[0].spend, WORST_OPUS);
});

test("D7. client.query throwing after the reservation: exit 3, verdict partial with the reason, summary written, the reservation stays charged, and no refusal", async () => {
  const b = box();
  const client = { calls: [], prompts: [], interrupted: 0, query() { throw new Error("spawn failed"); } };
  const { r, d } = await run(b, b.argv("T2"), client);
  assert.equal(r.exitCode, 3);
  assert.equal(r.refused, undefined);
  assert.match(r.summary.verdict, /^PARTIAL/);
  assert.equal(r.summary.partial, true);
  assert.match(r.summary.stoppedBecause, /call failed: spawn failed/);
  assert.equal(b.summary().exitCode, 3);
  assert.match(b.summary().stoppedBecause, /spawn failed/);
  near(b.charged(), WORST_OPUS);
  near(b.calls()[0].spend, WORST_OPUS);
  assert.equal(b.calls()[0].status, "closed");
  assert.equal(b.rowsOf().at(-1).verdict, r.summary.verdict);
  assert.ok(!d.io.errors.join(" ").includes("refused"));
  assert.equal(nodefs.existsSync(`${b.ledger}.lock`), false);
  const again = await run(b, b.argv("T2"), [T2_OK()]); // the charge counts as an attempt: one left of two
  assert.equal(again.r.exitCode, 0);
  const t = box();
  const turn = await run(t, t.initArgv(["--init-only-with-turn", "--model", HAIKU, "--ledger", t.ledger, "--max-session-usd", "1", "--max-run-usd", "2"]), { query() { throw new Error("spawn failed"); } });
  assert.equal(turn.r.exitCode, 3);
  assert.equal(turn.r.refused, undefined);
  near(t.charged(), 1 + (4096 * 2.5 + 100_000 * 0.625) / 1_000_000);
});

// ---------------------------------------------------------------- attempts

test("F5. Opus: at most two attempts of a row; the third refuses, exit 2, and each entry holds row, model, head and verdict", async () => {
  const b = box();
  for (const [i, sid] of ["a", "b"].entries()) assert.equal((await run(b, b.argv("T2"), [T2_BAD(0.1, sid)])).r.exitCode, 1, String(i));
  const third = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(third.r.exitCode, 2);
  assert.equal(third.client.calls.length, 0);
  assert.match(third.d.io.errors.join(" "), /2 of 2 attempt/);
  for (const e of [...b.calls(), ...b.rowsOf()]) {
    assert.equal(e.row, "T2"); assert.equal(e.model, OPUS); assert.equal(e.head, HEAD); assert.equal(e.verdict, "FAIL");
  }
});

const attemptLine = (call, o = {}) => reserveLine(call, 0.1, { row: "T2", turn: 1, head: HEAD, ...o });

test("attempts. the count comes from the campaign record: a new ledger does not reset it", async () => {
  const b = box();
  for (const sid of ["a", "b"]) assert.equal((await run(b, b.argv("T2"), [T2_BAD(0.1, sid)])).r.exitCode, 1);
  nodefs.writeFileSync(b.ledger, JSON.stringify({ entries: [] }));
  const emptied = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(emptied.r.exitCode, 2);
  assert.equal(emptied.client.calls.length, 0);
  assert.match(emptied.d.io.errors.join(" "), /2 of 2 attempt/);
  const other = b.p("other-ledger.json");
  nodefs.writeFileSync(other, JSON.stringify({ entries: [] }));
  const argv = b.argv("T2");
  argv[argv.indexOf("--ledger") + 1] = other;
  assert.equal((await run(b, argv, [T2_OK()])).r.exitCode, 2);
  const t6 = box({ entries: t6Ready() });
  assert.equal((await run(t6, t6.argv("T6"), [T6_OK()])).r.exitCode, 0);
  nodefs.writeFileSync(t6.ledger, JSON.stringify({ entries: t6Ready() })); // a fresh ledger holding only the facts T6 needs
  const again = await run(t6, t6.argv("T6"), [T6_OK()]);
  assert.equal(again.r.exitCode, 2);
  assert.match(again.d.io.errors.join(" "), /1 of 1 attempt/);
});

test("attempts. what counts on the record: an open reservation and a charged call do; a stop before the prompt, turn 2, another row, model, head or campaign do not; a ledger's own call entries are not read", async () => {
  const counted = async (record, entries = record.filter((l) => l.type === "reserve").map((l) => callEntry({ id: l.call }))) => {
    const b = box({ record, entries });
    const out = await run(b, b.argv("T2"), [T2_OK()]);
    return out.r.exitCode;
  };
  assert.equal(await counted([attemptLine("a"), attemptLine("b")]), 2); // kills mid-call
  assert.equal(await counted([attemptLine("a"), settleLine("a", 0.1), attemptLine("b"), settleLine("b", 0.1, { actualUsd: null, chargedUsd: 0.1 })]), 2);
  assert.equal(await counted([attemptLine("a"), settleLine("a", 0), attemptLine("b"), settleLine("b", 0)]), 0); // gates before the prompt
  assert.equal(await counted([attemptLine("a"), attemptLine("b", { turn: 2 })]), 0);
  assert.equal(await counted([attemptLine("a"), attemptLine("b", { row: "T4" })]), 0);
  assert.equal(await counted([attemptLine("a"), attemptLine("b", { model: HAIKU })]), 0);
  assert.equal(await counted([attemptLine("a"), attemptLine("b", { head: "b".repeat(40) })]), 0);
  assert.equal(await counted([attemptLine("a"), attemptLine("b", { campaign: "other-campaign" })]), 0);
  assert.equal(await counted([reserveLine("old", 0.1), reserveLine("older", 0.1)]), 0); // lines naming no row
  assert.equal(await counted([], [callEntry(), callEntry()]), 0);
});

const refusesOnMismatch = (out, b) => {
  assert.equal(out.r.exitCode, 2);
  assert.equal(out.client.calls.length, 0);
  assert.deepEqual(out.client.prompts, []);
  const text = out.d.io.errors.join(" ");
  assert.ok(text.includes(path.basename(b.ledger)) && text.includes(path.basename(b.record)), text);
  assert.match(text, /Check by hand/);
  assert.match(text, /killed after writing its reservation/);
};

test("ledger match. a different ledger never sends a second T4 capture: the record holds the attempt, so it refuses, exit 2, no prompt, no reservation, naming both files", async () => {
  const b = box();
  assert.equal((await run(b, b.argv("T4"), T4_OK({ captureResult: JSON.stringify({ id: JID }) }))).r.exitCode, 0);
  const reserves = () => b.recordLines().filter((l) => l.type === "reserve").length;
  const before = reserves();
  const other = b.p("other-ledger.json");
  nodefs.writeFileSync(other, JSON.stringify({ entries: [] }));
  const argv = b.argv("T4");
  argv[argv.indexOf("--ledger") + 1] = other;
  const out = await run(b, argv, T4_OK());
  assert.equal(out.r.exitCode, 2);
  assert.equal(out.client.calls.length, 0);
  assert.ok(out.d.io.errors.join(" ").includes("other-ledger.json") && out.d.io.errors.join(" ").includes(path.basename(b.record)));
  assert.equal(reserves(), before);
  assert.deepEqual(JSON.parse(nodefs.readFileSync(other, "utf8")).entries.filter((e) => e.kind === "call"), []);
});

test("ledger match. a new ledger loses neither T6's prerequisite nor a pass: T6 on it refuses on the T4 attempt, and a Haiku run refuses on the Opus pass it lacks, or on the attempt if a pass was copied across", async () => {
  const b = box({ record: [attemptLine("t4", { row: "T4" })] });
  const t6 = await run(b, b.argv("T6"), [T6_OK()]);
  refusesOnMismatch(t6, b);
  assert.match(t6.d.io.errors.join(" "), /T4 on claude-opus-5-5/);
  assert.deepEqual(b.findings(), []);
  const h = box({ record: [attemptLine("t2")] });
  const none = await run(h, h.argv("T2", { model: HAIKU }), [T2_OK()]);
  assert.equal(none.r.exitCode, 2);
  assert.equal(none.client.calls.length, 0);
  assert.match(none.d.io.errors.join(" "), /no Opus pass at this head/);
  const copied = box({ record: [attemptLine("t2")], entries: [rowEntry({})] });
  refusesOnMismatch(await run(copied, copied.argv("T2", { model: HAIKU }), [T2_OK()]), copied);
});

test("ledger match. a kill between the reservation and the ledger write refuses, and says to check by hand; so does the second attempt on a ledger holding only the first", async () => {
  const b = box({ record: [attemptLine("killed")] });
  const out = await run(b, b.argv("T2"), [T2_OK()]);
  refusesOnMismatch(out, b);
  assert.deepEqual(b.recordLines().filter((l) => l.type === "reserve").map((l) => l.call), ["killed"]);
  assert.deepEqual(b.calls(), []);
  const second = box({ record: [attemptLine("a"), settleLine("a", 0.1)], entries: [callEntry({ id: "b" })] });
  refusesOnMismatch(await run(second, second.argv("T2"), [T2_OK()]), second);
});

test("ledger match. the normal order of writes never trips it: a reservation is in the ledger before the prompt, and a second attempt and a later row both run", async () => {
  const b = box();
  let during = null;
  await run(b, b.argv("T2"), [() => {
    during = { record: b.recordLines().filter((l) => l.type === "reserve").map((l) => l.call), ledger: b.calls().map((e) => e.id) };
    return T2_BAD(0.1, "a");
  }]);
  assert.equal(during.record.length, 1);
  assert.deepEqual(during.ledger, during.record);
  assert.equal((await run(b, b.argv("T2"), [T2_OK(0.1, "b")])).r.exitCode, 0);
  const t4 = await run(b, b.argv("T4"), T4_OK({ captureResult: JSON.stringify({ id: JID }) }));
  assert.equal(t4.r.exitCode, 0);
  assert.equal((await main({ argv: ["--mark-judgment-confirmed", JID, "--ledger", b.ledger], env: {}, ...b.deps() })).exitCode, 0);
  assert.equal((await run(b, b.argv("T6"), [T6_OK()])).r.exitCode, 0);
});

test("ledger match. what does not trip it: a stop before the prompt, another head, another row, a line naming no row; and a used-up count keeps its own message", async () => {
  for (const record of [
    [attemptLine("a"), settleLine("a", 0)],
    [attemptLine("a", { head: "b".repeat(40) })],
    [attemptLine("a", { row: "ISSUE2" })],
    [reserveLine("old", 0.1)],
  ]) {
    const b = box({ record });
    assert.equal((await run(b, b.argv("T2"), [T2_OK()])).r.exitCode, 0, JSON.stringify(record[0]));
  }
  const used = box({ record: [attemptLine("a"), attemptLine("b")] });
  assert.match((await run(used, used.argv("T2"), [T2_OK()])).d.io.errors.join(" "), /2 of 2 attempt/);
});

test("G6. attempts count per row, model and head: a new head has its own, and a row that passed on Opus does not run again at that head", async () => {
  const OTHER = "b".repeat(40);
  const used = [attemptLine("x", { head: OTHER }), attemptLine("y", { head: OTHER })];
  const b = box({ entries: [rowEntry({ head: OTHER, verdict: "FAIL" })], record: used });
  assert.equal((await run(b, b.argv("T2"), [T2_BAD(0.1, "a")])).r.exitCode, 1); // two used at the other head, none here
  assert.equal((await run(b, b.argv("T2"), [T2_OK(0.1, "b")])).r.exitCode, 0);
  const again = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(again.r.exitCode, 2);
  assert.equal(again.client.calls.length, 0);
  assert.match(again.d.io.errors.join(" "), /2 of 2 attempt/);
  const passed = box();
  assert.equal((await run(passed, passed.argv("T2"), [T2_OK(0.1, "a")])).r.exitCode, 0);
  const rerun = await run(passed, passed.argv("T2"), [T2_OK()]);
  assert.equal(rerun.r.exitCode, 2);
  assert.equal(rerun.client.calls.length, 0);
  assert.match(rerun.d.io.errors.join(" "), /already passed on Opus at this head/);
  const moved = box({ entries: [rowEntry({ head: OTHER, verdict: "PASS" })], record: [attemptLine("x", { head: OTHER })] });
  assert.equal((await run(moved, moved.argv("T2"), [T2_OK()])).r.exitCode, 0); // a re-run at a new head
  const t6 = box({ entries: [...t6Ready(), rowEntry({ row: "T6", head: OTHER, verdict: "FAIL" })], record: [attemptLine("x", { row: "T6", head: OTHER })] });
  assert.equal((await run(t6, t6.argv("T6"), [T6_OK()])).r.exitCode, 0); // once per model per head
});

test("F5. a kill mid-call counts as an attempt", async () => {
  const b = box({ record: [attemptLine("a"), attemptLine("b")] });
  const { r, client } = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(r.exitCode, 2);
  assert.equal(client.calls.length, 0);
});

test("F5. Haiku: refused unless that row passed on Opus at this head; then one attempt only", async () => {
  const none = box();
  const h = { model: HAIKU };
  assert.equal((await run(none, none.argv("T2", h), [T2_OK()])).r.exitCode, 2);
  const other = box({ entries: [rowEntry({ head: "b".repeat(40) })] });
  assert.equal((await run(other, other.argv("T2", h), [T2_OK()])).r.exitCode, 2);
  const failed = box({ entries: [rowEntry({ verdict: "FAIL" })] });
  assert.equal((await run(failed, failed.argv("T2", h), [T2_OK()])).r.exitCode, 2);
  const wrongRow = box({ entries: [rowEntry({ row: "ISSUE2" })] });
  assert.equal((await run(wrongRow, wrongRow.argv("T2", h), [T2_OK()])).r.exitCode, 2);
  const ok = box({ entries: [rowEntry({})] });
  assert.equal((await run(ok, ok.argv("T2", h), [T2_OK()])).r.exitCode, 0);
  const again = await run(ok, ok.argv("T2", h), [T2_OK()]);
  assert.equal(again.r.exitCode, 2);
  assert.equal(again.client.calls.length, 0);
});

test("G5. only the exact model ids run: another model, an alias or a near miss refuses before anything is written", async () => {
  for (const model of ["some-other-model", "opus", "haiku", "claude-opus", "claude-opus-5-5-20261101", "claude-opus-5-5[1m]", "CLAUDE-OPUS-5-5", "my-haiku-clone", "constructor"]) {
    const b = box();
    const { r, client, d } = await run(b, b.argv("T2", { model }), [T2_OK()]);
    assert.equal(r.exitCode, 2, model);
    assert.equal(client.calls.length, 0, model);
    assert.match(d.io.errors.join(" "), /must be exactly one of/, model);
    assert.deepEqual(b.entries(), [], model);
    assert.deepEqual(b.recordLines(), [], model);
  }
  const wt = box();
  assert.equal((await run(wt, wt.initArgv(["--init-only-with-turn", "--model", "opus", "--ledger", wt.ledger, "--max-session-usd", "1", "--max-run-usd", "2"]), [[init(), result(0.1)]])).r.exitCode, 2);
});

test("G5. init reporting another model than the one requested stops before the prompt, zero spend; after the prompt it fails the row as a load failure", async () => {
  const b = box();
  const before = await run(b, b.argv("T2"), [[init({ mcp_servers: [], model: "claude-haiku-5-5" }), SKILL(), result(0.1, { result: "x" })]]);
  assert.equal(before.r.exitCode, 3);
  assert.deepEqual(before.client.prompts, []);
  assert.equal(b.calls()[0].spend, 0);
  assert.match(before.r.summary.stoppedBecause, /different model/);
  const late = box();
  const after = await run(late, late.argv("T2"), [{ messages: [init({ mcp_servers: [], model: "other" }), SKILL(), result(0.1, { result: "x" })], initTiming: "after" }], { timeoutMs: 20 });
  assert.equal(after.client.prompts.length, 1);
  assert.equal(after.r.exitCode, 3);
  assert.equal(after.client.interrupted, 1);
  assert.equal(after.r.summary.verdict, "LOAD FAILURE");
  assert.match(after.r.summary.stoppedBecause, /different model/);
  near(late.charged(), WORST_OPUS);
  const init2 = box();
  assert.equal((await run(init2, init2.initArgv(["--model", OPUS]), [[init({ model: HAIKU })]])).r.exitCode, 5);
});

// ---------------------------------------------------------------- two-turn rows, timeouts, stops

test("F6. T4 and T5: turn 2 never starts without a success result on turn 1; the row fails and nothing further is spent", async () => {
  for (const [row, first] of [
    ["T4", [init({ session_id: "s" }), result(0.1, { session_id: "s", subtype: "error_during_execution", result: OFFER })]],
    ["T5", [init({ session_id: "s" }), result(0.1, { session_id: "s", subtype: "error_during_execution" })]],
  ]) {
    const b = box();
    const { r, client } = await run(b, b.argv(row), [first, []]);
    assert.equal(client.calls.length, 1, row);
    assert.equal(r.exitCode, 1, row);
    assert.equal(r.summary.verdict, "FAIL");
    assert.equal(b.calls().length, 1);
  }
});

test("F6. T4: naming only the project on turn 1 is no offer; a capture call on turn 1 is no offer; turn 2 never starts", async () => {
  const projectOnly = box();
  const a = await run(projectOnly, projectOnly.argv("T4"), [[init({ session_id: "s" }), result(0.1, { session_id: "s", result: "Keep it in quadron-connect?" })], []]);
  assert.equal(a.client.calls.length, 1);
  assert.equal(a.r.exitCode, 1);
  assert.match(a.r.summary.notes.join(" "), /recall only/);
  const captured = box();
  const b = await run(captured, captured.argv("T4"), [[init({ session_id: "s" }), toolUse("u", CAPTURE, { quad_name: "x" }), result(0.1, { session_id: "s", result: OFFER })], []]);
  assert.equal(b.client.calls.length, 1);
  assert.equal(b.r.exitCode, 1);
  assert.match(b.r.summary.notes.join(" "), /captured before confirmation/);
  const text = box();
  const c = await run(text, text.argv("T4"), T4_OK().map((s, i) => (i === 0 ? [s[0], assistantText("It ships recall only in quadron-connect. Shall I keep that?"), result(0.1, { session_id: "s9", result: "ok" })] : s)));
  assert.equal(c.client.calls.length, 2); // the offer in assistant text counts
  const echo = box();
  const e = await run(echo, echo.argv("T4"), [[init({ session_id: "s" }), result(0.1, { session_id: "s", result: "Noted: the plugin ships recall only." })], []]);
  assert.equal(e.client.calls.length, 1); // G8: an echo of the phrase is no offer
  assert.equal(e.r.exitCode, 1);
});

const COMMIT = "mcp__quadron__quad_commit";
const ABSENT = `capture names absent at init: ${CAPTURE}, ${COMMIT}; fallback quad_commit`;
const offerTurn = (tools) => [init({ session_id: "s9", tools }), assistantText(OFFER), result(0.1, { session_id: "s9", result: OFFER })];
const captureTurn = (tools, name) => [init({ session_id: "s9", tools }), toolUse("u1", name, { quad_name: "quadron-connect", decided: WORDING }), toolResult("u1", "Saved for your review"), result(0.15, { session_id: "s9", result: "Saved." })];

test("capture names. neither listed at turn 1's init: the row goes on to turn 2 with quad_commit, and the line is in the notes and printed once", async () => {
  const b = box();
  const { r, client, d } = await run(b, b.argv("T4"), [offerTurn(["Skill", "ToolSearch"]), captureTurn(["Skill", "ToolSearch", COMMIT], COMMIT)]);
  assert.equal(client.calls.length, 2);
  assert.ok(client.calls[1].options.allowedTools.includes(COMMIT));
  assert.ok(!client.calls[1].options.allowedTools.includes(CAPTURE));
  assert.equal(r.summary.verdict, "PASS");
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.notes.filter((n) => n === ABSENT).length, 1);
  assert.equal(d.io.lines.filter((l) => l === ABSENT).length, 1);
});

test("capture names. a name listed goes on with that name and no line, and a row whose next turn needs no capture tool has no line", async () => {
  for (const name of [CAPTURE, COMMIT]) {
    const b = box();
    const { r, client, d } = await run(b, b.argv("T4"), [offerTurn(["Skill", "ToolSearch", name]), captureTurn(["Skill", "ToolSearch", name], name)]);
    assert.equal(client.calls.length, 2, name);
    assert.ok(client.calls[1].options.allowedTools.includes(name), name);
    assert.equal(r.summary.verdict, "PASS", name);
    assert.equal(r.exitCode, 0, name);
    assert.ok(!r.summary.notes.includes(ABSENT), name);
    assert.ok(!d.io.lines.includes(ABSENT), name);
  }
  const t5 = box();
  const out = await run(t5, t5.argv("T5"), T5_OK().map(([i, ...more]) => [{ ...i, tools: ["Skill", "ToolSearch"] }, ...more]));
  assert.equal(out.client.calls.length, 2);
  assert.equal(out.r.exitCode, 0);
  assert.ok(!out.d.io.lines.includes(ABSENT));
});

const t2Line = (out) => out.d.io.lines.find((l) => l.startsWith("T2: "));
const t2Skills = (b, inputs, ...end) => run(b, b.argv("T2"), [[init({ mcp_servers: [] }), ...inputs.map((input, n) => toolUse(`s${n}`, "Skill", input)), ...end]]);

test("T2 skill name. a partial stop and a failed row with no verdict still print the Skill names on the verdict line", async () => {
  const input = { skill: "other:skill", args: "x" };
  const partial = await t2Skills(box(), [input], result(0.1, { subtype: "error_max_budget_usd" }));
  assert.equal(partial.r.exitCode, 3);
  assert.equal(partial.r.summary.partial, true);
  assert.ok(t2Line(partial).endsWith("; Skill names [other:skill]"), t2Line(partial));
  const cut = await t2Skills(box(), [input], result(0.1, { result: "partial", stop_reason: "max_tokens" }));
  assert.equal(cut.r.exitCode, 1);
  assert.equal(cut.r.summary.verdict, "FAIL");
  assert.equal(cut.r.summary.cutOff, true);
  assert.ok(t2Line(cut).startsWith("T2: FAIL;"), t2Line(cut));
  assert.ok(t2Line(cut).endsWith("; Skill names [other:skill]"), t2Line(cut));
});

test("T2 skill name. the printed line ends with one label per Skill call, on a pass and a fail, and the verdict rule stands", async () => {
  const end = result(0.1, { result: "An answer." });
  for (const [inputs, verdict, names] of [
    [[{ skill: "quadron:quadron", args: "x" }], "PASS", "quadron:quadron"],
    [[{ name: "quadron:quadron" }], "PASS", "quadron:quadron"],
    [[{ skill: "other:skill", args: "quadron:quadron" }], "FAIL", "other:skill"], // the rule and the label read input.skill or input.name only
    [[{ a: { b: ["quadron:quadron"] } }], "FAIL", "no skill name"],
    [[{ skill: "quadron:quadron" }, { skill: "other:skill" }], "FAIL", "quadron:quadron, other:skill"],
    [[{ skill: "quadron" }], "FAIL", "quadron"],
    [[{ n: 1 }], "FAIL", "no skill name"],
    [[], "FAIL", ""],
  ]) {
    const out = await t2Skills(box(), inputs, end);
    assert.equal(out.r.summary.verdict, verdict, names);
    assert.ok(t2Line(out).startsWith(`T2: ${verdict};`), t2Line(out));
    assert.ok(t2Line(out).endsWith(`; Skill names [${names}]`), t2Line(out));
  }
  const masked = await t2Skills(box(), [{ skill: "sk-abcdefghijkl" }], end); // the whole line goes through redaction
  assert.ok(t2Line(masked).endsWith("; Skill names [<redacted>]"), t2Line(masked));
});

test("T2 skill name. a secret under skill is masked before the label is reduced or cut: a long registered value and pattern-shaped ones", async () => {
  const end = result(0.1, { result: "An answer." });
  const LONG = "fakeregisteredvalue".repeat(4);
  for (const [skill, label] of [[LONG, "<redacted>"], [`name ${LONG}`, "name_<redacted>"]]) {
    const b = box();
    const done = await run(b, b.argv("T2"), [[init({ mcp_servers: [] }), toolUse("s", "Skill", { skill }), end]], {}, liveEnv({ ANTHROPIC_API_KEY: LONG }));
    const line = t2Line(done);
    assert.ok(line.endsWith(`; Skill names [${label}]`), line);
    for (let i = 0; i + 40 <= LONG.length; i++) assert.ok(!line.includes(LONG.slice(i, i + 40)), String(i));
  }
  for (const [skill, label, secret] of [
    ["key sk-ant-fakevalue0123", "key_<redacted>", "sk-ant-fakevalue0123"],
    ["Bearer fakevalue0123", "Bearer_<redacted>", "fakevalue0123"],
  ]) {
    const out = await t2Skills(box(), [{ skill }], end);
    assert.ok(t2Line(out).endsWith(`; Skill names [${label}]`), t2Line(out));
    assert.ok(!t2Line(out).includes(secret), secret);
  }
});

test("T2 skill name. nothing but the names prints, whatever shape a secret takes in the input, and skillInputs is gone from the summary", async () => {
  const GHP = `ghp_${"madeupvalue0".repeat(3)}`;
  const SECRETS = ["made-up-string-1", "made-up-nested-2", "made-up-array-3", "made-up-args-4", "made-up-key-string-5", "made-up-key-array-6", "made-up-key-object-7", "made-up-password-8", "made-up-bare-token-9", GHP];
  const inputsNaming = (skill) => [
    { skill, note: SECRETS[0], nested: { deep: SECRETS[1], list: [SECRETS[2], { inner: SECRETS[2] }] }, args: SECRETS[3], api_key: SECRETS[4] },
    { skill, api_key: [SECRETS[5]], password: SECRETS[7] },
    { skill, api_key: { value: SECRETS[6] }, token: SECRETS[8], other: GHP },
  ];
  for (const [skill, end, verdict] of [
    ["quadron:quadron", result(0.1, { result: "An answer." }), /^PASS$/],
    ["other:skill", result(0.1, { result: "An answer." }), /^FAIL$/],
    ["quadron:quadron", result(0.1, { subtype: "error_max_budget_usd" }), /^PARTIAL/],
  ]) {
    const b = box();
    const out = await t2Skills(b, inputsNaming(skill), end);
    assert.match(out.r.summary.verdict, verdict);
    assert.ok(t2Line(out).endsWith(`; Skill names [${skill}, ${skill}, ${skill}]`), t2Line(out));
    const printed = [...out.d.io.lines, ...out.d.io.errors].join("\n");
    for (const secret of SECRETS) assert.ok(!printed.includes(secret), secret);
    assert.equal("skillInputs" in out.r.summary, false);
    assert.equal("skillInputs" in b.summary(), false);
    assert.equal(out.r.summary.toolCalls.filter((c) => c.name === "Skill").length, 3); // the inputs stay here alone
  }
});

test("F6. --row-timeout-seconds aborts a hung call: exit 3, partial, the call stays at its reservation, and the default is 600", async () => {
  const b = box();
  const { r, client } = await run(b, b.argv("T2", {}, ["--row-timeout-seconds", "0.05"]), [{ messages: [init({ mcp_servers: [] })], hang: true }]);
  assert.equal(r.exitCode, 3);
  assert.equal(r.summary.partial, true);
  assert.match(r.summary.stoppedBecause, /row timeout/);
  near(b.calls()[0].spend, WORST_OPUS);
  near(b.charged(), WORST_OPUS);
  assert.equal(client.interrupted, 1);
  assert.equal((await import("../lib/live.mjs")).DEFAULT_ROW_TIMEOUT_SECONDS, 600);
  const bad = box();
  assert.equal((await run(bad, bad.argv("T2", {}, ["--row-timeout-seconds", "0"]), [T2_OK()])).r.exitCode, 2);
});

test("F6. a budget stop is partial, not FAIL, and never a Haiku finding", async () => {
  const b = box({ entries: [rowEntry({})] });
  const { r } = await run(b, b.argv("T2", { model: HAIKU }), [[init({ mcp_servers: [] }), SKILL(), result(1, { subtype: "error_max_budget_usd" })]]);
  assert.equal(r.exitCode, 3);
  assert.equal(r.summary.partial, true);
  assert.match(r.summary.verdict, /PARTIAL/);
  assert.deepEqual(b.findings(), []);
});

test("G13. --max-run-turns is gone: the per-command count could not hold across commands, and the spend bound does the stopping", async () => {
  const b = box();
  const { r, client, d } = await run(b, b.argv("T2", {}, ["--max-run-turns", "7"]), [T2_OK()]);
  assert.equal(r.exitCode, 2);
  assert.equal(client.calls.length, 0);
  assert.match(d.io.errors.join(" "), /unknown flag --max-run-turns/);
});

// ---------------------------------------------------------------- model, effort, caps

const optsWithoutPerAttempt = (o) => {
  const { cwd, env, ...rest } = o;
  const { HOME, USERPROFILE, ...envRest } = env;
  assert.ok(cwd && HOME && USERPROFILE);
  return { ...rest, env: envRest };
};
const differing = (a, b) => Object.keys({ ...a, ...b }).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();

test("F25. model and effort reach the SDK exactly on T2; the two passes differ only in model and ceiling", async () => {
  const opus = box();
  const a = (await run(opus, opus.argv("T2"), [T2_OK()])).client.calls[0].options;
  const haiku = box({ entries: [rowEntry({})] });
  const b = (await run(haiku, haiku.argv("T2", { model: HAIKU, session: "2" }), [T2_OK()])).client.calls[0].options;
  assert.equal(a.model, OPUS); assert.equal(a.effort, "low");
  assert.equal(b.model, HAIKU); assert.equal(b.effort, "low");
  const clean = (o) => { const c = optsWithoutPerAttempt(o); delete c.settings; delete c.plugins; delete c.env.CLAUDE_CONFIG_DIR; return c; };
  assert.deepEqual(differing(clean(a), clean(b)), ["maxBudgetUsd", "model"]);
  assert.equal("thinking" in a, false);
  assert.equal("thinking" in b, false);
});

test("F25. model and effort equality on a two-turn row: both turns carry them, and the turns differ only in caps, tools and resume", async () => {
  for (const [row, script] of [["T4", T4_OK()], ["T5", T5_OK()]]) {
    const b = box();
    const { client } = await run(b, b.argv(row), script);
    assert.equal(client.calls.length, 2, row);
    for (const c of client.calls) { assert.equal(c.options.model, OPUS); assert.equal(c.options.effort, "low"); assert.equal(c.options.maxBudgetUsd, 1); }
    assert.deepEqual(differing(...client.calls.map((c) => c.options)).filter((k) => !["allowedTools", "resume", "maxTurns", "abortController"].includes(k)), [], row);
    assert.ok(client.calls[1].options.resume);
    assert.equal(client.calls[0].options.resume, undefined);
    assert.equal(client.calls[0].options.cwd, client.calls[1].options.cwd); // a resume needs the same directory
  }
  const h = box({ entries: [rowEntry({ row: "T4" })] });
  const { client } = await run(h, h.argv("T4", { model: HAIKU }), T4_OK());
  assert.deepEqual(client.calls.map((c) => c.options.model), [HAIKU, HAIKU]);
  assert.deepEqual(client.calls.map((c) => c.options.effort), ["low", "low"]);
});

test("F25. each row's maxTurns is exact", async () => {
  const expected = { T2: [7], T4: [5, 5], T5: [5, 5], ISSUE2: [6], "T4O-S": [5], "T4O-N": [5], "T4O-C": [5] };
  const scripts = { T2: [T2_OK()], T4: T4_OK(), T5: T5_OK(), ISSUE2: [ISSUE2_OK()], "T4O-S": [OFFER_ROW("T4O-S")], "T4O-N": [OFFER_ROW("T4O-N")], "T4O-C": [OFFER_ROW("T4O-C")] };
  for (const [row, caps] of Object.entries(expected)) {
    const b = box();
    const { client } = await run(b, b.argv(row), scripts[row]);
    assert.deepEqual(client.calls.map((c) => c.options.maxTurns), caps, row);
  }
  const b = box({ entries: t6Ready() });
  const { client } = await run(b, b.argv("T6"), [T6_OK()]);
  assert.deepEqual(client.calls.map((c) => c.options.maxTurns), [10]);
});

test("F25. one row per command: no whole-suite option, and a list of rows refuses", async () => {
  const b = box();
  for (const bad of [["--rows", "T2,T4"], ["--all"], ["--suite"]]) {
    const { r, client } = await run(b, [...b.argv("T2"), ...bad], [T2_OK()]);
    assert.equal(r.exitCode, 2);
    assert.equal(client.calls.length, 0);
  }
  assert.equal((await run(b, b.argv("T2,T4"), [T2_OK()])).r.exitCode, 2);
});

test("F25. no automatic retry: an error result is not re-sent, exit is exactly 1, and no retry option is set", async () => {
  const b = box();
  const { r, client } = await run(b, b.argv("T2"), [[init({ mcp_servers: [] }), SKILL(), result(0.02, { subtype: "error_during_execution" })], T2_OK()]);
  assert.equal(client.calls.length, 1);
  assert.ok(!("retry" in client.calls[0].options) && !("maxRetries" in client.calls[0].options));
  assert.equal(r.exitCode, 1);
});

// ---------------------------------------------------------------- tools

test("F8. Agent and Task are both disallowed on every call and flagged in init or a tool_use", async () => {
  const b = box();
  const { client } = await run(b, b.argv("T2"), [T2_OK()]);
  for (const t of ["Agent", "Task"]) assert.ok(client.calls[0].options.disallowedTools.includes(t), t);
  for (const name of ["Agent", "Task"]) {
    const c2 = box();
    const inInit = await run(c2, c2.argv("T2"), [[init({ tools: ["Skill", name], mcp_servers: [] })]]);
    assert.equal(inInit.r.exitCode, 1, name);
    assert.deepEqual(inInit.client.prompts, []);
    assert.equal(c2.calls()[0].spend, 0);
    const c3 = box();
    const used = await run(c3, c3.argv("T2"), [[init({ mcp_servers: [] }), toolUse("u", name), result(0.01, { result: "x" })]]);
    assert.equal(used.r.exitCode, 1, name);
    assert.match(used.r.summary.notes.join(" "), /sub-agent/);
  }
});

test("F12. no-write rows keep capture tools listed and dontAsk denies them: not allowed, not disallowed, and an attempt fails the row", async () => {
  const cases = {
    T2: [[init({ mcp_servers: [] }), SKILL(), toolUse("c", CAPTURE, {}), toolResult("c", "denied", true), result(0.1, { result: "done" })]],
    ISSUE2: [[init({ session_id: "i" }), toolUse("c", CAPTURE, {}), toolResult("c", "denied", true), result(0.1, { session_id: "i", result: "keeps raw streams" })]],
    T5: [[init({ session_id: "q" }), result(0.05, { session_id: "q", result: "Summary." })],
      [init({ session_id: "q" }), toolUse("c", CAPTURE, {}), toolResult("c", "denied", true), result(0.08, { session_id: "q", result: "ok" })]],
    T6: [[init({ session_id: "t6" }), toolUse("r", READ), toolResult("r", "x"), toolUse("c", CAPTURE, {}), toolResult("c", "denied", true), result(0.1, { session_id: "t6", result: "quadron-connect" })]],
  };
  for (const [row, script] of Object.entries(cases)) {
    const b = box({ entries: row === "T6" ? t6Ready() : [] });
    const { r, client } = await run(b, b.argv(row), script);
    for (const c of client.calls) {
      assert.ok(!c.options.allowedTools.includes(CAPTURE), row);
      assert.ok(!c.options.disallowedTools.includes(CAPTURE), row);
    }
    assert.deepEqual(client.denials.filter((d) => d.tool_name === CAPTURE).map((d) => d.tool_use_id), ["c"], row);
    assert.equal(r.summary.verdict, "FAIL", row);
    assert.equal(r.exitCode, 1, row);
    assert.equal(r.summary.captureAttempts.length, 1, row);
    assert.equal(r.summary.captureAttempts[0].name, CAPTURE, row);
    assert.equal(r.summary.toolCalls.find((u) => u.name === CAPTURE).isError, true, row);
  }
});

// Each row with a capture attempt the stream reports in `extra` alone, with no tool_use: only the
// record in a result, or only a best-effort message.
const noWriteRows = {
  T5: (extra, resultExtra) => [[init({ session_id: "q" }), result(0.05, { session_id: "q", result: "Summary." })],
    [init({ session_id: "q" }), ...extra, result(0.08, { session_id: "q", result: "ok", ...resultExtra })]],
  T6: (extra, resultExtra) => [[init({ session_id: "t6" }), toolUse("r", READ), toolResult("r", `Judgment: ${WORDING}. Status: confirmed.`), ...extra, result(0.1, { session_id: "t6", result: "From quadron-connect.", ...resultExtra })]],
  ISSUE2: (extra, resultExtra) => [[init({ session_id: "i" }), assistantText("Keep this in quadron-connect: the runner keeps raw streams?"), ...extra, result(0.1, { session_id: "i", result: "ok", ...resultExtra })]],
};

for (const [form, make] of [
  ["only a permission_denials entry", (f) => f([], { permission_denials: [denial("c", CAPTURE, { decided: "x" })] })],
  ["only a permission_denied message", (f) => f([permissionDenied("c", CAPTURE)], {})],
  ["both, which count once", (f) => f([permissionDenied("c", CAPTURE)], { permission_denials: [denial("c", CAPTURE, { decided: "x" })] })],
]) {
  test(`F12. a capture attempt with ${form} fails T5, T6 and ISSUE2 and is reported`, async () => {
    for (const [row, script] of Object.entries(noWriteRows)) {
      const b = box({ entries: row === "T6" ? t6Ready() : [] });
      const { r } = await run(b, b.argv(row), make(script));
      assert.equal(r.summary.verdict, "FAIL", row);
      assert.equal(r.exitCode, 1, row);
      assert.match(r.summary.notes.join(" "), /capture tool was called|called a capture tool/, row);
      assert.deepEqual(r.summary.captureAttempts.map((c) => c.name), [CAPTURE], row);
      assert.equal(typeof r.summary.captureAttempts[0].input, "object", row);
    }
  });
}

test("F12. a denied call that is no capture tool is not reported as a capture attempt, and does not fail the row", async () => {
  const b = box();
  const { r } = await run(b, b.argv("ISSUE2"), [noWriteRows.ISSUE2([permissionDenied("x", "mcp__quadron__quad_read")], {})[0].map((m) => (m.type === "result" ? { ...m, result: "Keep this in quadron-connect: the runner keeps raw streams?" } : m))]);
  assert.deepEqual(r.summary.captureAttempts, []);
  assert.equal(r.summary.verdict, "PASS");
});

test("F12. a denied capture counts as a connector call: a pending server with only that denial is no load failure", async () => {
  for (const [label, extra, resultExtra] of [
    ["permission_denials", [], { permission_denials: [denial("c", CAPTURE)] }],
    ["permission_denied", [permissionDenied("c", CAPTURE)], {}],
  ]) {
    const b = box();
    const { r } = await run(b, b.argv("ISSUE2"), [[init({ session_id: "i", mcp_servers: [{ name: "quadron", status: "pending" }] }), ...extra, result(0.1, { session_id: "i", result: "ok", ...resultExtra })]]);
    assert.equal(r.summary.verdict, "FAIL", label);
    assert.equal(r.exitCode, 1, label);
    assert.deepEqual(r.summary.captureAttempts.map((c) => c.name), [CAPTURE], label);
  }
});

test("F12. captures lists every capture call by turn and outcome; captureAttempts keeps the denied ones only", async () => {
  const b = box();
  const ok = await run(b, b.argv("T4"), T4_OK());
  assert.deepEqual(ok.r.summary.captures, [{ turn: 2, name: CAPTURE, outcome: "accepted" }]);
  assert.deepEqual(ok.r.summary.captureAttempts, []);
  for (const [label, script] of [
    ["a denied tool_use", [[init({ session_id: "q" }), result(0.05, { session_id: "q", result: "Summary." })],
      [init({ session_id: "q" }), toolUse("c", CAPTURE, {}), toolResult("c", "denied", true), result(0.08, { session_id: "q", result: "ok" })]]],
    ["a denial with no tool_use", noWriteRows.T5([], { permission_denials: [denial("c", CAPTURE)] })],
  ]) {
    const c = box();
    const { r } = await run(c, c.argv("T5"), script);
    assert.deepEqual(r.summary.captures, [{ turn: 2, name: CAPTURE, outcome: "denied" }], label);
    assert.deepEqual(r.summary.captureAttempts.map((a) => a.name), [CAPTURE], label);
  }
});

test("F12. T4 turn 1 leaves capture off the allow-list; turn 2 is the one turn that lists it, and only the one tool", async () => {
  const b = box();
  const { client } = await run(b, b.argv("T4"), T4_OK());
  assert.ok(!client.calls[0].options.allowedTools.includes(CAPTURE));
  assert.ok(client.calls[1].options.allowedTools.includes(CAPTURE));
  assert.ok(!client.calls[1].options.allowedTools.includes("mcp__quadron__quad_commit"));
  assert.deepEqual(client.denials, []);
});

test("F12. T4: a capture attempt on turn 1 reported only by a denial stops the row before turn 2", async () => {
  for (const [extra, resultExtra] of [[[], { permission_denials: [denial("c", CAPTURE)] }], [[permissionDenied("c", CAPTURE)], {}]]) {
    const b = box();
    const { r, client } = await run(b, b.argv("T4"), [[init({ session_id: "s" }), assistantText(OFFER), ...extra, result(0.1, { session_id: "s", result: OFFER, ...resultExtra })]]);
    assert.equal(r.summary.verdict, "FAIL");
    assert.equal(client.calls.length, 1);
    assert.match(r.summary.notes.join(" "), /captured before confirmation/);
  }
});

test("F18. T4 turn 2: a capture whose id is in either denial record is not accepted, even with a clean tool result", async () => {
  for (const [extra, resultExtra] of [[[], { permission_denials: [denial("u1", CAPTURE)] }], [[permissionDenied("u1", CAPTURE)], {}]]) {
    const [first, second] = T4_OK();
    const [i, use, res] = second;
    const b = box();
    const { r } = await run(b, b.argv("T4"), [first, [i, use, res, ...extra, result(0.15, { session_id: "s9", result: "Saved.", ...resultExtra })]]);
    assert.equal(r.summary.verdict, "FAIL");
    assert.match(r.summary.notes.join(" "), /calls: 1, accepted: 0/);
  }
});

test("F12. every connector row lists ToolSearch on every turn, and calling it is no forbidden tool", async () => {
  for (const [row, script] of [["T4", T4_OK()], ["T5", T5_OK()], ["T6", [T6_OK()]], ["ISSUE2", [ISSUE2_OK()]]]) {
    const b = box({ entries: row === "T6" ? t6Ready() : [] });
    const { client } = await run(b, b.argv(row), script);
    for (const c of client.calls) assert.ok(c.options.allowedTools.includes("ToolSearch"), row);
  }
  const b = box();
  const [i, ...rest] = ISSUE2_OK();
  const { r, client } = await run(b, b.argv("ISSUE2"), [[{ ...i, tools: [...i.tools, "ToolSearch"] }, toolUse("t", "ToolSearch", { query: "quadron" }), toolResult("t", "found"), ...rest]]);
  assert.equal(r.summary.verdict, "PASS");
  assert.deepEqual(client.denials, []);
});

test("F12. the summary records the permission mode init reports, with no effect on the verdict", async () => {
  const b = box();
  const plain = await run(b, b.argv("T2"), [T2_OK()]);
  assert.equal(plain.r.summary.init.permissionMode, "dontAsk");
  assert.equal(b.summary().init.permissionMode, "dontAsk");
  for (const [mode, shown] of [["default", "default"], [undefined, "not shown"]]) {
    const c = box();
    const { r } = await run(c, c.argv("T2"), [[init({ mcp_servers: [], permissionMode: mode }), SKILL(), result(0.1, { result: "An answer." })]]);
    assert.equal(r.summary.init.permissionMode, shown);
    assert.equal(r.summary.verdict, "PASS");
    assert.equal(r.exitCode, 0);
  }
});

// ---------------------------------------------------------------- findings

test("F16. capture_owner_unavailable is a finding on an error result and on a non-error one: no crash, hang or retry", async () => {
  const b = box();
  const { r, client } = await run(b, b.argv("T4"), [
    [init({ session_id: "s" }), assistantText(OFFER), result(0.05, { session_id: "s", result: OFFER })],
    [init({ session_id: "s" }), toolUse("u1", CAPTURE, { quad_name: "quadron-connect" }), toolResult("u1", "error: capture_owner_unavailable", true), result(0.08, { session_id: "s", result: "x" })],
  ]);
  assert.equal(client.calls.length, 2);
  assert.ok(r.summary.findings.some((f) => f.kind === "capture_owner_unavailable"));
  assert.equal(b.findings()[0].kind, "capture_owner_unavailable");
  assert.equal(r.exitCode, 1); // a row verdict, not a crash

  const c = box();
  const plain = await run(c, c.argv("ISSUE2"), [[init({ session_id: "i" }), toolUse("r", READ), toolResult("r", "capture_owner_unavailable"), assistantText("Keep this: it keeps raw streams?"), result(0.1, { session_id: "i", result: "Keep this: it keeps raw streams?" })]]);
  assert.equal(c.findings()[0].kind, "capture_owner_unavailable");
  assert.equal(plain.r.exitCode, 0);
});

test("F16. a capture_owner_unavailable is still recorded when a stop fires first", async () => {
  const b = box();
  const { r } = await run(b, b.argv("ISSUE2"), [[init({ session_id: "i" }), toolUse("r", READ), toolResult("r", "capture_owner_unavailable"), { type: "result", subtype: "success", session_id: "i", result: "x" }]]);
  assert.equal(r.exitCode, 3); // no cost: stopped
  assert.equal(b.findings()[0].kind, "capture_owner_unavailable");
});

test("F16. an MCP 401 in a row is exit 4, verdict auth failure, no finding: on a non-error result, in a tool error, and when a stop fires first", async () => {
  const scripts = [
    [init({ session_id: "i" }), toolUse("r", READ), toolResult("r", "HTTP 401 from the server"), result(0.1, { session_id: "i", result: "keeps raw streams" })], // non-error
    [init({ session_id: "i" }), toolUse("r", READ), toolResult("r", "status: 401", true), result(0.1, { session_id: "i", subtype: "error_during_execution" })],
    [init({ session_id: "i" }), toolUse("r", READ), toolResult("r", "401 Unauthorized"), { type: "result", subtype: "success", session_id: "i" }], // no cost would stop it
    [init({ session_id: "i" }), toolUse("r", READ), toolResult("r", "MCP server returned 401"), result(1, { session_id: "i", subtype: "error_max_budget_usd" })], // budget stop
  ];
  for (const s of scripts) {
    const b = box();
    const { r, client } = await run(b, b.argv("ISSUE2"), [s]);
    assert.equal(r.exitCode, 4);
    assert.equal(r.summary.verdict, "auth failure");
    assert.deepEqual(b.findings(), []);
    assert.equal(client.calls.length, 1);
    assert.equal(b.rowsOf()[0].verdict, "auth failure");
  }
});

test("F16. a bare 401 in an answer is not an auth failure", async () => {
  const b = box();
  const text = "Keep this? Room 401 keeps raw streams, unauthorized or not";
  const { r } = await run(b, b.argv("ISSUE2"), [[init({ session_id: "i" }), assistantText(text), result(0.1, { session_id: "i", result: text })]]);
  assert.equal(r.exitCode, 0);
});

test("G14. other 401 wordings read as an auth failure: errored tool text, a status field in structured or JSON results, api_error_status, a result's errors list", async () => {
  const fixed = (...middle) => [[init({ session_id: "i" }), ...middle, result(0.1, { session_id: "i", result: "x" })]];
  const scripts = [
    fixed(toolUse("r", READ), toolResult("r", "Unauthorized", true)),
    fixed(toolUse("r", READ), toolResult("r", "invalid_token", true)),
    fixed(toolUse("r", READ), toolResult("r", "Error: token has expired", true)),
    fixed(toolUse("r", READ), toolResult("r", "Authentication required", true)),
    fixed(toolUse("r", READ), toolResult("r", "request failed (401)", true)),
    fixed(toolUse("r", READ), toolResult("r", "see data", false, { error: { status: 401 } })),
    fixed(toolUse("r", READ), toolResult("r", JSON.stringify({ code: "401", message: "no" }))),
    [[init({ session_id: "i" }), result(0.1, { session_id: "i", result: "x", api_error_status: 401 })]],
    [[init({ session_id: "i" }), result(0.1, { session_id: "i", subtype: "error_during_execution", errors: ["authentication failed"] })]],
  ];
  for (const s of scripts) {
    const b = box();
    const { r } = await run(b, b.argv("ISSUE2"), s);
    assert.equal(r.exitCode, 4, JSON.stringify(s[0][1]).slice(0, 90));
    assert.equal(r.summary.verdict, "auth failure");
  }
  const c = box();
  const notAuth = await run(c, c.argv("ISSUE2"), [[init({ session_id: "i" }), toolUse("r", READ), toolResult("r", "the word unauthorized, in a result that is no error"), assistantText("Keep this: it keeps raw streams?"), result(0.1, { session_id: "i", result: "Keep this: it keeps raw streams?" })]]);
  assert.equal(notAuth.r.exitCode, 0);
});

test("G13. a reported cost of 0 after a real call is no cost: stays at its reservation and stops", async () => {
  const b = box();
  const { r } = await run(b, b.argv("T2"), [[init({ mcp_servers: [] }), SKILL(), result(0, { result: "x" })]]);
  assert.equal(r.exitCode, 3);
  assert.match(r.summary.stoppedBecause, /without a reported cost/);
  near(b.charged(), WORST_OPUS);
  const t = new SpendTracker();
  assert.equal(t.record("a", 0).unknown, true);
  assert.equal(t.record("a", 0.1).spend, 0.1);
  assert.equal(t.record("a", 0.1).unknown, true); // a turn that adds nothing
});

test("H2. a response cut off at the limit fails the row plainly, on any model: no product finding, and no next turn", async () => {
  const cut = [init({ mcp_servers: [] }), SKILL(), result(0.1, { result: "partial", stop_reason: "max_tokens" })];
  const b = box({ entries: [rowEntry({})] });
  const { r, client } = await run(b, b.argv("T2", { model: HAIKU }), [cut]);
  assert.equal(r.summary.verdict, "FAIL");
  assert.equal(r.exitCode, 1);
  assert.equal(r.summary.cutOff, true);
  assert.match(r.summary.notes.join(" "), /cut off at the output limit of 4096 tokens/);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(b.findings(), []);
  const two = box();
  const t = await run(two, two.argv("T4"), [[init({ session_id: "s" }), assistantTextCut(OFFER), result(0.1, { session_id: "s", result: OFFER })], []]);
  assert.equal(t.client.calls.length, 1);
  assert.equal(t.r.exitCode, 1);
});

test("H2. --max-output-tokens lowers the child's limit and the reservation, and cannot raise them", async () => {
  const b = box();
  const { client } = await run(b, b.argv("T2", {}, ["--max-output-tokens", "1000"]), [T2_OK()]);
  assert.equal(client.calls[0].options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "1000");
  near(b.recordLines().find((l) => l.type === "reserve").reservationUsd, 1 + 0.02 + 0.5);
  for (const v of ["4097", "128000", "0", "-1", "1.5", "lots"]) {
    const c = box();
    const out = await run(c, c.argv("T2", {}, ["--max-output-tokens", v]), [T2_OK()]);
    assert.equal(out.r.exitCode, 2, v);
    assert.equal(out.client.calls.length, 0, v);
  }
});

test("F22. a Haiku failure on a row that passed on Opus is an appended finding and triggers no retry; findings.jsonl is only ever appended", async () => {
  const b = box({ entries: [rowEntry({})] });
  nodefs.writeFileSync(path.join(b.out, "findings.jsonl"), `${JSON.stringify({ kind: "earlier" })}\n`);
  const { r, client } = await run(b, b.argv("T2", { model: HAIKU }), [[init({ mcp_servers: [] }), toolUse("u", "mcp__quadron__quad_context"), result(0.01, { result: "x" })]]);
  assert.equal(r.summary.verdict, "FAIL");
  assert.equal(client.calls.length, 1);
  assert.deepEqual(b.findings().map((f) => f.kind), ["earlier", "haiku_failure_after_opus_pass"]);
});

// ---------------------------------------------------------------- T6 and confirmation

test("G7. --mark-judgment-confirmed requires a T4 PASS at this head, and the id must match the one shared pattern", async () => {
  const OTHER = "b".repeat(40);
  const mark = (b, id) => main({ argv: ["--mark-judgment-confirmed", id, "--ledger", b.ledger], env: {}, ...b.deps() });
  for (const entries of [
    [rowEntry({ row: "T4", verdict: "FAIL", judgmentId: JID })],
    [rowEntry({ row: "T4", verdict: "PASS", judgmentId: JID, head: OTHER })],
    [rowEntry({ row: "T2", verdict: "PASS", judgmentId: JID })],
    [],
  ]) {
    const b = box({ entries });
    assert.equal((await mark(b, JID)).exitCode, 2);
    assert.equal(b.entries().length, entries.length);
  }
  const b = box({ entries: [rowEntry({ row: "T4", judgmentId: "good_id-1" }), rowEntry({ row: "T4", judgmentId: "a".repeat(64) })] });
  assert.equal((await mark(b, "good_id-1")).exitCode, 0);
  assert.equal((await mark(b, "a".repeat(64))).exitCode, 0);
  const before = b.entries().length;
  for (const id of ["a".repeat(65), "-leading", "_leading", "has space", "not shown", "x/y", "a.b", "$(x)"]) {
    const d = b.deps();
    const r = await main({ argv: ["--mark-judgment-confirmed", id, "--ledger", b.ledger], env: {}, ...d });
    assert.equal(r.exitCode, 2, id);
  }
  assert.equal(b.entries().length, before);
});

test("G7. the confirmation form reads no campaign variable, key or URL: closed-port URLs, a key, an empty home and no record all leave it working", async () => {
  const base = {
    ANTHROPIC_API_KEY: "dummy", ANTHROPIC_BASE_URL: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9",
    QUADRON_MCP_URL: "http://127.0.0.1:9", QUADRON_ISSUER: "http://127.0.0.1:9", QUADRON_API: "http://127.0.0.1:9",
    QUADRON_CAMPAIGN_RECORD: "/no/such/record", HOME: "/empty", USERPROFILE: "/empty",
  };
  const b = box({ entries: [rowEntry({ row: "T4", judgmentId: JID })] });
  const reads = [];
  const env = new Proxy(base, { get(t, k) { reads.push(String(k)); return t[k]; } });
  const f = fetchStub();
  let loaded = 0;
  const d = b.deps({ fetch: f, loadSdk: () => { loaded++; return {}; } });
  const r = await main({ argv: ["--mark-judgment-confirmed", JID, "--ledger", b.ledger], env, ...d });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(reads, ["QUADRON_HARNESS_DRY"]);
  assert.equal(f.seen.length, 0);
  assert.equal(loaded, 0);
  assert.deepEqual(d.io.lines, ["judgment confirmation recorded"]);
  assert.deepEqual(b.recordLines(), []);
  assert.equal(b.entries().at(-1).kind, "confirmation");
  const emptyEnv = box({ entries: [rowEntry({ row: "T4", judgmentId: JID })] });
  assert.equal((await main({ argv: ["--mark-judgment-confirmed", JID, "--ledger", emptyEnv.ledger], env: {}, ...emptyEnv.deps() })).exitCode, 0);
});

test("F19. --mark-judgment-confirmed appends a confirmation record with no model or network call; the id must match a T4 entry", async () => {
  const b = box({ entries: [rowEntry({ row: "T4", judgmentId: JID })] });
  const fetchFn = fetchStub();
  let loaded = 0;
  const d = b.deps({ fetch: fetchFn });
  const r = await main({ argv: ["--mark-judgment-confirmed", JID, "--ledger", b.ledger], env: {}, loadSdk: () => { loaded++; return {}; }, ...d });
  assert.equal(r.exitCode, 0);
  assert.equal(loaded, 0);
  assert.equal(fetchFn.seen.length, 0);
  const rec = b.entries().at(-1);
  assert.deepEqual({ kind: rec.kind, judgmentId: rec.judgmentId, head: rec.head }, { kind: "confirmation", judgmentId: JID, head: HEAD });
  assert.ok(Date.parse(rec.at));
  assert.equal(nodefs.existsSync(`${b.ledger}.lock`), false);

  const before = b.entries().length;
  assert.equal((await main({ argv: ["--mark-judgment-confirmed", "nope", "--ledger", b.ledger], env: {}, ...b.deps() })).exitCode, 2);
  assert.equal((await main({ argv: ["--mark-judgment-confirmed", "not shown", "--ledger", b.ledger], env: {}, ...b.deps() })).exitCode, 2);
  assert.equal((await main({ argv: ["--mark-judgment-confirmed", JID], env: {}, ...b.deps() })).exitCode, 2);
  assert.equal((await main({ argv: ["--mark-judgment-confirmed", JID, "--ledger", b.ledger, "--live"], env: {}, ...b.deps() })).exitCode, 2);
  assert.equal((await main({ argv: ["--mark-judgment-confirmed", JID, "--ledger", b.ledger], env: { QUADRON_HARNESS_DRY: "1" }, ...b.deps() })).exitCode, 2);
  assert.equal(b.entries().length, before);
});

test("F19. T6 refuses before any call, exit 2, without a T4 PASS at this head with the id and a matching confirmation; the reason goes to findings.jsonl", async () => {
  const cases = [
    [],
    [rowEntry({ row: "T4", verdict: "FAIL", judgmentId: JID }), { kind: "confirmation", judgmentId: JID, head: HEAD, at: "x" }],
    [rowEntry({ row: "T4", verdict: "PASS", judgmentId: JID, head: "b".repeat(40) }), { kind: "confirmation", judgmentId: JID, head: HEAD, at: "x" }],
    [rowEntry({ row: "T4", verdict: "PASS", judgmentId: "not shown" })],
    [rowEntry({ row: "T4", verdict: "PASS", judgmentId: JID })],
    [rowEntry({ row: "T4", verdict: "PASS", judgmentId: JID }), { kind: "confirmation", judgmentId: "other", head: HEAD, at: "x" }],
    [rowEntry({ row: "T4", verdict: "PASS", judgmentId: JID }), { kind: "confirmation", judgmentId: JID, head: "b".repeat(40), at: "x" }],
    t6Ready({ savedWording: "not shown" }), // H3: nothing to compare the read against
    t6Ready({ savedWording: undefined }),
  ];
  for (const entries of cases) {
    const b = box({ entries });
    const f = fetchStub();
    const { r, client } = await run(b, b.argv("T6"), [T6_OK()], { fetch: f });
    assert.equal(r.exitCode, 2);
    assert.equal(client.calls.length, 0);
    assert.equal(f.seen.length, 0);
    assert.equal(b.findings().at(-1).kind, "t6_refused");
    assert.match(b.findings().at(-1).reason, /T4|confirmation/);
    assert.deepEqual(b.recordLines().filter((l) => l.type === "reserve"), []);
  }
});

test("H3. through the whole row: staging's read without the wording FAILs with the ledger fully ready; an answer that only claims it does too", async () => {
  for (const [toolText, answer] of [["FIT: no_match", "From quadron-connect."], ["FIT: no_match", `From quadron-connect: ${WORDING}`]]) {
    const b = box({ entries: t6Ready() });
    const { r } = await run(b, b.argv("T6"), [[init({ session_id: "t6" }), toolUse("r", READ), toolResult("r", toolText), result(0.1, { session_id: "t6", result: answer })]]);
    assert.equal(r.summary.verdict, "FAIL");
    assert.equal(r.exitCode, 1);
    assert.match(r.summary.notes.join(" "), /holds T4's saved wording/);
  }
});

test("T6 structure. a confirmed status field on the record does not stand in for the confirmation record: T6 still refuses before any call without it", async () => {
  const read = [[init({ session_id: "t6" }), toolUse("r", READ), toolResult("r", "see data", false, { items: [{ text: WORDING, status: "confirmed" }] }), result(0.1, { session_id: "t6", result: "From quadron-connect." })]];
  const b = box({ entries: [rowEntry({ row: "T4", verdict: "PASS", judgmentId: JID, savedWording: WORDING })] });
  const out = await run(b, b.argv("T6"), read);
  assert.equal(out.r.exitCode, 2);
  assert.equal(out.client.calls.length, 0);
  assert.match(out.d.io.errors.join(" "), /no confirmation record/);
  const ready = box({ entries: t6Ready() });
  const ok = await run(ready, ready.argv("T6"), read);
  assert.equal(ok.r.exitCode, 0);
  assert.equal(ok.r.summary.verdict, "PASS");
});

test("F19. T6 PASS records the id, and T6 runs once per model at most", async () => {
  const b = box({ entries: t6Ready() });
  const { r, client } = await run(b, b.argv("T6"), [T6_OK()]);
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.verdict, "PASS");
  assert.equal(r.summary.judgmentId, JID);
  assert.equal(b.summary().judgmentId, JID);
  assert.equal(b.rowsOf().at(-1).judgmentId, JID);
  assert.ok(client.calls[0]);
  const again = await run(b, b.argv("T6"), [T6_OK()]);
  assert.equal(again.r.exitCode, 2);
  assert.equal(again.client.calls.length, 0);
});

test("F19. WITHHELD in a tool result gives verdict WITHHELD, exit 1, and no Haiku finding", async () => {
  const entries = [...t6Ready(), rowEntry({ row: "T6", verdict: "PASS" })];
  const b = box({ entries });
  const { r } = await run(b, b.argv("T6", { model: HAIKU }), [[init({ session_id: "t6" }), toolUse("r", READ), toolResult("r", "WITHHELD (IP firewall): 2 items"), result(0.1, { session_id: "t6", result: "x" })]]);
  assert.equal(r.summary.verdict, "WITHHELD");
  assert.equal(r.exitCode, 1);
  assert.deepEqual(b.findings(), []);
});

const t6Script = (text, answer = "From quadron-connect.") => [[init({ session_id: "t6" }), toolUse("r", READ), toolResult("r", text), result(0.1, { session_id: "t6", result: answer })]];

test("D3. through the whole row: a record with no status is UNCONFIRMED, exit 1, no Haiku finding, and no pass for Haiku to follow", async () => {
  const b = box({ entries: t6Ready() });
  const { r, client } = await run(b, b.argv("T6"), t6Script(`Judgment: ${WORDING}.`));
  assert.equal(client.calls.length, 1);
  assert.equal(r.summary.verdict, "UNCONFIRMED");
  assert.equal(r.exitCode, 1);
  assert.equal(b.summary().verdict, "UNCONFIRMED");
  assert.equal(b.rowsOf().at(-1).verdict, "UNCONFIRMED");
  assert.match(r.summary.notes.join(" "), /first real T6 shows the wording/);
  assert.deepEqual(b.findings(), []);
  const haiku = await run(b, b.argv("T6", { model: HAIKU }), t6Script(`Judgment: ${WORDING}. Status: confirmed.`));
  assert.equal(haiku.r.exitCode, 2); // no Opus pass: Haiku does not run
  const onHaiku = box({ entries: [...t6Ready(), rowEntry({ row: "T6", verdict: "PASS" })] });
  const h = await run(onHaiku, onHaiku.argv("T6", { model: HAIKU }), t6Script(`Judgment: ${WORDING}.`));
  assert.equal(h.r.summary.verdict, "UNCONFIRMED");
  assert.deepEqual(onHaiku.findings(), []);
});

test("D3. through the whole row: a pending record holding the wording FAILs, exit 1; WITHHELD in a skill's result does not outrank a confirmed record (D5)", async () => {
  const b = box({ entries: t6Ready() });
  const { r } = await run(b, b.argv("T6"), t6Script(`Judgment: ${WORDING}. Status: pending.`));
  assert.equal(r.summary.verdict, "FAIL");
  assert.equal(r.exitCode, 1);
  const c = box({ entries: t6Ready() });
  const ok = await run(c, c.argv("T6"), [[init({ session_id: "t6" }), toolUse("s", "Skill"), toolResult("s", "WITHHELD (IP firewall): 9"), toolUse("r", READ), toolResult("r", `${WORDING}. Status: confirmed.`), result(0.1, { session_id: "t6", result: "From quadron-connect." })]]);
  assert.equal(ok.r.summary.verdict, "PASS");
  assert.equal(ok.r.exitCode, 0);
});

test("F19/G9. --routing-blocked records the citation BLOCKED-BY-BACKEND with the reason, its own exit 6, never FAIL, and applies to T6 only", async () => {
  const b = box({ entries: t6Ready() });
  const unrouted = [[init({ session_id: "t6" }), toolUse("r", READ), toolResult("r", `${WORDING}. Status: confirmed.`), result(0.1, { session_id: "t6", result: "An answer naming no project." })]];
  const { r } = await run(b, b.argv("T6", {}, ["--routing-blocked", "routing is off on the server"]), unrouted);
  assert.equal(r.summary.verdict, "BLOCKED-BY-BACKEND");
  assert.deepEqual(r.summary.citesProject, { state: "BLOCKED-BY-BACKEND", reason: "routing is off on the server" });
  assert.equal(r.exitCode, 6);
  assert.equal(b.summary().exitCode, 6);
  const noFlag = box({ entries: t6Ready() });
  const f = await run(noFlag, noFlag.argv("T6"), unrouted);
  assert.equal(f.r.summary.verdict, "FAIL");
  const other = box();
  assert.equal((await run(other, other.argv("T2", {}, ["--routing-blocked", "x"]), [T2_OK()])).r.exitCode, 2);
});

// ---------------------------------------------------------------- T4 record

test("F18. the T4 ledger entry holds the judgment id, head, quad_name, routing and the signed claim observation", async () => {
  const b = box();
  const { r } = await run(b, b.argv("T4"), T4_OK({ captureResult: JSON.stringify({ judgment_id: JID, signed_claim: "abc-signed-value", quad: "quadron-connect" }) }));
  assert.equal(r.exitCode, 0);
  const e = b.rowsOf().at(-1);
  assert.equal(e.verdict, "PASS");
  assert.equal(e.judgmentId, JID);
  assert.equal(e.head, HEAD);
  assert.equal(e.quadName, "quadron-connect");
  assert.equal(e.savedWording, WORDING);
  assert.equal(e.routing, "routed");
  assert.deepEqual(e.signedClaim, { state: "present", field: "signed_claim" });
  assert.ok(!JSON.stringify(e).includes("abc-signed-value"));
});

test("F18. no id exposed: recorded and reported as not shown, still PASS; unrouted is not a failure; absent claim is not a failure", async () => {
  const b = box();
  const { r, d } = await run(b, b.argv("T4"), T4_OK({ captureResult: "Saved, unrouted." }));
  assert.equal(r.exitCode, 0);
  assert.equal(r.summary.verdict, "PASS");
  const e = b.rowsOf().at(-1);
  assert.equal(e.judgmentId, "not shown");
  assert.equal(e.routing, "unrouted");
  assert.deepEqual(e.signedClaim, { state: "absent" });
  assert.ok(d.io.lines.includes("judgment id: not shown"));
});

test("F18. the id can come from the structured tool_use_result", async () => {
  const b = box();
  const { r } = await run(b, b.argv("T4"), T4_OK({ structured: { judgmentId: "from-struct" } }));
  assert.equal(r.summary.judgmentId, "from-struct");
});

// ---------------------------------------------------------------- end-to-end T4 then T6

test("the T4 to T6 path runs end to end through the ledger: T4 PASS with an id and wording, the confirmation, then T6 comparing against what T4 recorded", async () => {
  const b = box();
  assert.equal((await run(b, b.argv("T4"), T4_OK({ captureResult: JSON.stringify({ id: JID }) }))).r.exitCode, 0);
  assert.equal((await run(b, b.argv("T6"), [T6_OK()])).r.exitCode, 2); // not confirmed yet
  assert.equal((await main({ argv: ["--mark-judgment-confirmed", JID, "--ledger", b.ledger], env: {}, ...b.deps() })).exitCode, 0);
  const t6 = await run(b, b.argv("T6"), [T6_OK()]);
  assert.equal(t6.r.exitCode, 0);
  assert.equal(t6.r.summary.judgmentId, JID);
  assert.equal(t6.r.summary.savedWording, WORDING);
  const other = box();
  await run(other, other.argv("T4"), T4_OK({ captureResult: JSON.stringify({ id: JID }), wording: "A different thing that ships recall only" }));
  await main({ argv: ["--mark-judgment-confirmed", JID, "--ledger", other.ledger], env: {}, ...other.deps() });
  const mismatch = await run(other, other.argv("T6"), [T6_OK()]);
  assert.equal(mismatch.r.summary.verdict, "FAIL"); // the read holds some other judgment
});
