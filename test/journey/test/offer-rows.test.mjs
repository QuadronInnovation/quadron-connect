// The one-turn offer rows and the project-name rule, directly on the verdicts and through the whole row.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodefs from "node:fs";
import path from "node:path";
import { main, USAGE } from "../lib/main.mjs";
import { LIFTABLE, assertSessionOptions, loadOverride } from "../lib/guards.mjs";
import { checkSession } from "../lib/gates.mjs";
import { ROWS, ROW_NAMES, turnTools } from "../lib/rows.mjs";
import { checkAttempts, opusPassedAtHead, t6Prerequisite } from "../lib/spend.mjs";
import { OFFER_HEURISTIC_NOTE, VERDICTS, collect, isOffer, readOffer, turnGate, verdictIssue2, verdictT4 } from "../lib/verdicts.mjs";
import {
  box, fakeClient, liveEnv, init, initC, result, toolUse, toolResult, assistantText, denial, permissionDenied, rowEntry,
  HAIKU, HEAD, JID, OPUS, WORDING, CAPTURE, OFFER, OFFER_N, OFFER_ROW, READ, SKILL, T4_OK, ISSUE2_OK,
} from "./helpers.mjs";

const run = (b, argv, scripts, over = {}, env = liveEnv()) => {
  const client = Array.isArray(scripts) ? fakeClient(scripts) : scripts;
  const d = b.deps(over);
  return main({ argv, env: { ...b.campaign, ...env }, client, ...d }).then((r) => ({ r, client, d }));
};
const rec = (...msgs) => collect(msgs);
const ok = (text = "ok") => result(0.1, { result: text });
const said = (text) => rec(init(), assistantText(text), ok(text));
const verdict = (row, s) => VERDICTS[row]([s]);
const lineOf = (out, row) => out.d.io.lines.find((l) => l.startsWith(`${row}: `));
const noPluginDir = (argv) => argv.filter((a, i) => a !== "--plugin-dir" && argv[i - 1] !== "--plugin-dir");
const assistantCut = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }], stop_reason: "max_tokens" } });
const OFFER_ROWS = { "T4O-S": OFFER, "T4O-N": OFFER_N };
const DRY_ENV = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };

// ---------------------------------------------------------------- the project-name rule

const MULTI_LINE = "Project: quadron-connect\nDecision: the plugin ships recall only\n\nWant me to save this?";

const T4_NOT_NAMED = /turn 1's offer does not name the project \("quadron-connect"\) in its sentence or the one before or after it/;

test("project name. T4's gate: the name in the offer's sentence, the one before or the one after opens it; two away or nowhere closes it", () => {
  for (const text of [
    OFFER,
    "For quadron-connect, it ships recall only. Want me to keep that?",
    "This is for quadron-connect. Want me to keep recall only?",
    "It ships recall only. Want me to keep that? It would go in quadron-connect.",
    "Want me to keep recall only in QUADRON-CONNECT?",
  ]) assert.equal(turnGate("T4", said(text)), null, text);
  for (const text of [
    "This is about quadron-connect. Understood. Want me to keep recall only?",
    "Want me to keep recall only? Understood. It would go in quadron-connect.",
    "Want me to keep it: the plugin ships recall only?",
    MULTI_LINE,
  ]) assert.match(turnGate("T4", said(text)), T4_NOT_NAMED, text);
  const none = "Want me to keep it: the plugin ships recall only?";
  assert.match(turnGate("T4", rec(init(), assistantText(none), ok("Filed under quadron-connect."))), T4_NOT_NAMED); // the result is not the assistant text
});

test("project name. the multi-line shape fails T4's gate, so turn 2 never starts, and fails T4O-S", async () => {
  const [first] = T4_OK();
  const b = box();
  const t4 = await run(b, b.argv("T4"), [[first[0], assistantText(MULTI_LINE), result(0.1, { session_id: "s9", result: MULTI_LINE })], []]);
  assert.equal(t4.client.calls.length, 1);
  assert.equal(t4.r.exitCode, 1);
  assert.equal(t4.r.summary.verdict, "FAIL");
  assert.match(t4.r.summary.notes.join(" "), T4_NOT_NAMED);
  const s = box();
  const narrow = await run(s, s.argv("T4O-S"), [OFFER_ROW("T4O-S", { text: MULTI_LINE })]);
  assert.equal(narrow.r.exitCode, 1);
  assert.equal(narrow.r.summary.verdict, "FAIL");
  assert.match(narrow.r.summary.notes.join(" "), /the offer does not name the project/);
  assert.equal(narrow.r.summary.offerSentence, "Want me to save this?");
});

test("project name. through T4: a name two sentences away stops turn 1, and an adjacent one goes on to a pass", async () => {
  const [first, second] = T4_OK();
  const far = "This is about quadron-connect. Understood. Want me to keep recall only?";
  const b = box();
  const stopped = await run(b, b.argv("T4"), [[first[0], assistantText(far), result(0.1, { session_id: "s9", result: far })], second]);
  assert.equal(stopped.client.calls.length, 1);
  assert.equal(stopped.r.exitCode, 1);
  assert.match(stopped.r.summary.notes.join(" "), T4_NOT_NAMED);
  const near = "This is for quadron-connect. Want me to keep recall only?";
  const n = box();
  const went = await run(n, n.argv("T4"), [[first[0], assistantText(near), result(0.1, { session_id: "s9", result: near })], second]);
  assert.equal(went.client.calls.length, 2);
  assert.equal(went.r.exitCode, 0);
  assert.equal(went.r.summary.verdict, "PASS");
});

test("project name. an offer with no name anywhere fails T4 and T4O-S", async () => {
  const text = "The plugin ships recall only.\n\nWant me to save this?";
  const b = box();
  const t4 = await run(b, b.argv("T4"), [[init({ session_id: "s" }), assistantText(text), result(0.1, { session_id: "s", result: text })], []]);
  assert.equal(t4.client.calls.length, 1);
  assert.equal(t4.r.exitCode, 1);
  assert.match(t4.r.summary.notes.join(" "), T4_NOT_NAMED);
  const s = box();
  const o = await run(s, s.argv("T4O-S"), [OFFER_ROW("T4O-S", { text })]);
  assert.equal(o.r.exitCode, 1);
  assert.match(o.r.summary.notes.join(" "), /the offer does not name the project/);
});

test("project name. the name alone is no offer, and the no-offer reason comes first", () => {
  assert.match(turnGate("T4", said("Want me to keep it in quadron-connect?")), /no offer with the stated decision \("recall only"\)/);
  assert.equal(readOffer("Noted for quadron-connect: recall only.", "recall only").offered, false);
});

test("project name. a later offer that names the project counts, and is the one recorded", () => {
  const named = "Want me to save recall only to quadron-connect?";
  const r = readOffer(`Want me to keep recall only? First, a word. Then another. ${named}`, "recall only");
  assert.deepEqual(r, { offered: true, named: true, sentence: named });
  const unnamed = readOffer("Want me to keep recall only?", "recall only");
  assert.deepEqual(unnamed, { offered: true, named: false, sentence: "Want me to keep recall only?" });
  assert.deepEqual(readOffer("Nothing here.", "recall only"), { offered: false, named: false, sentence: null });
});

test("project name. isOffer itself is unchanged: it does not ask for the name, and ISSUE2's verdict still does not", () => {
  assert.equal(isOffer("Want me to keep it: the plugin ships recall only?", "recall only"), true);
  assert.equal(verdictIssue2([said("Keep this: the runner keeps raw streams?")]).verdict, "PASS");
});

test("project name. verdictT4 fails an offer without the name, with an otherwise good turn 2", () => {
  const two = rec(init(), toolUse("u1", CAPTURE, { quad_name: "quadron-connect" }), toolResult("u1", "Saved for your review"), ok("Saved."));
  assert.equal(verdictT4([said(OFFER), two]).verdict, "PASS");
  const v = verdictT4([said("Want me to keep it: the plugin ships recall only?"), two]);
  assert.equal(v.verdict, "FAIL");
  assert.match(v.notes.join(" "), /does not name the project/);
});

test("project name. through T4: an offer without the name fails the row, and turn 2 never starts", async () => {
  const b = box();
  const text = "Want me to keep it: the plugin ships recall only?";
  const { r, client } = await run(b, b.argv("T4"), [[init({ session_id: "s" }), assistantText(text), result(0.1, { session_id: "s", result: text })], []]);
  assert.equal(client.calls.length, 1);
  assert.equal(r.exitCode, 1);
  assert.equal(r.summary.verdict, "FAIL");
  assert.match(r.summary.notes.join(" "), T4_NOT_NAMED);
});

test("the T4 row is as it was: both prompts, both caps; T4O-S asks exactly what T4's first turn asks", () => {
  assert.equal(ROWS.T4.turns[0].prompt, "Decision: the Claude Code plugin ships recall only; capture happens through the capture tool with my approval, never from a hook. Project: quadron-connect.");
  assert.equal(ROWS.T4.turns[1].prompt, "Yes, save it to the quadron-connect project as stated.");
  assert.deepEqual(ROWS.T4.turns.map((t) => t.maxTurns), [5, 5]);
  assert.equal(ROWS["T4O-S"].turns[0].prompt, ROWS.T4.turns[0].prompt);
  assert.equal(ROWS["T4O-C"].turns[0].prompt, ROWS.T4.turns[0].prompt);
  assert.equal(ROWS["T4O-N"].turns[0].prompt, "Decision: we're going with annual pricing only, and monthly is ruled out. Project: quadron-connect.");
  for (const name of ["T4O-H", "T3B"]) assert.ok(!ROW_NAMES.includes(name), name);
});

// ---------------------------------------------------------------- T4O-S and T4O-N, on the verdict

for (const [row, offer] of Object.entries(OFFER_ROWS)) {
  test(`${row} PASS: a success result, no capture, the offer with its project, and one quad_context at most; the records do not gate`, () => {
    for (const s of [
      said(offer),
      rec(init(), SKILL(), assistantText(offer), ok(offer)),
      rec(init(), toolUse("r", READ), toolResult("r", "context"), assistantText(offer), ok(offer)),
    ]) {
      const v = verdict(row, s);
      assert.equal(v.verdict, "PASS", v.notes.join(" "));
      assert.equal(v.offerSentence, offer);
      assert.ok(v.notes.includes(OFFER_HEURISTIC_NOTE));
    }
    assert.ok(verdict(row, said(offer)).notes.includes("Skill called: no"));
    assert.ok(verdict(row, rec(init(), SKILL(), assistantText(offer), ok(offer))).notes.includes("Skill called: yes"));
  });

  test(`${row} FAIL names which: the result, a capture in any form, no offer, no project, a second quad_context`, () => {
    const named = "Want me to keep it";
    const phrase = ROWS[row].offerPhrase;
    const cases = [
      [rec(init(), assistantText(offer), result(0.1, { subtype: "error_during_execution" })), /result was error_during_execution/],
      [rec(init(), assistantText(offer), result(0.1, { subtype: "error_max_turns" })), /result was error_max_turns/],
      [rec(init(), assistantText(offer)), /result was none/],
      [rec(init(), toolUse("c", CAPTURE, {}), assistantText(offer), ok(offer)), /capture tool was called/],
      [rec(init(), assistantText(offer), result(0.1, { result: offer, permission_denials: [denial("c", CAPTURE)] })), /capture tool was called/],
      [rec(init(), permissionDenied("c", CAPTURE), assistantText(offer), ok(offer)), /capture tool was called/],
      [said("Understood."), new RegExp(`no offer with the stated phrase \\("${phrase}"\\)`)],
      [rec(init(), ok(offer)), /no offer with the stated phrase/], // a result alone is not the turn's assistant text
      [said(`Noted for quadron-connect: ${phrase}.`), /no offer with the stated phrase/], // an echo
      [said(`${named}: ${phrase}?`), /the offer does not name the project \("quadron-connect"\)/],
      [rec(init(), toolUse("r", READ), toolResult("r", "a"), toolUse("s", READ), toolResult("s", "b"), assistantText(offer), ok(offer)), /quad_context called 2 times/],
    ];
    for (const [s, re] of cases) {
      const v = verdict(row, s);
      assert.equal(v.verdict, "FAIL", String(re));
      assert.match(v.notes.join(" "), re);
    }
    assert.equal("offerSentence" in verdict(row, said("Understood.")), false);
  });
}

test("T4O: the offer phrase is the row's own, and so is the list of verbs its prompt rules out", () => {
  assert.match(verdict("T4O-N", said(OFFER)).notes.join(" "), /annual pricing/);
  assert.match(verdict("T4O-S", said(OFFER_N)).notes.join(" "), /recall only/);
  // T4's prompt says "capture", so that word offers nothing there. The neutral prompt does not.
  assert.equal(verdict("T4O-S", said("Shall I capture it in quadron-connect: recall only?")).verdict, "FAIL");
  assert.equal(verdict("T4O-N", said("Shall I capture it in quadron-connect: annual pricing?")).verdict, "PASS");
});

// ---------------------------------------------------------------- T4O-S and T4O-N, through the row

for (const [row, offer] of Object.entries(OFFER_ROWS)) {
  test(`${row} through the row: one call with the plugin and the skill, no capture allowed, PASS exit 0, and a generic ledger entry`, async () => {
    const b = box();
    const out = await run(b, b.argv(row), [OFFER_ROW(row, { extra: [SKILL()] }), []]);
    assert.equal(out.r.exitCode, 0);
    assert.equal(out.r.summary.verdict, "PASS");
    assert.equal(out.client.calls.length, 1);
    const { options } = out.client.calls[0];
    assert.deepEqual(options.plugins, [{ type: "local", path: b.plugin }]);
    assert.deepEqual(options.skills, ["quadron:quadron"]);
    assert.equal(options.maxTurns, 5);
    assert.ok(!options.allowedTools.includes(CAPTURE));
    assert.ok(!options.disallowedTools.includes(CAPTURE));
    assert.equal("hooks" in options, false);
    assert.equal(out.client.prompts[0].text, ROWS[row].turns[0].prompt);
    assert.equal(lineOf(out, row), `${row}: PASS; call spend 0.1000 USD; Skill names [quadron:quadron]`);
    assert.deepEqual(out.r.summary.skillNames, ["quadron:quadron"]);
    assert.equal(b.summary().offerSentence, offer);
    assert.ok(b.summary().notes.includes("Skill called: yes"));
    assert.deepEqual(Object.keys(b.rowsOf()[0]).sort(), ["at", "head", "kind", "model", "row", "verdict"]);
    assert.equal(b.rowsOf()[0].row, row);
    assert.ok(!out.d.io.lines.join("\n").includes(offer)); // model text stays in the evidence
    assert.ok(!nodefs.readFileSync(b.ledger, "utf8").includes(offer));
  });

  test(`${row} through the row: a capture denied by dontAsk fails it, exit 1, and is reported`, async () => {
    const b = box();
    const out = await run(b, b.argv(row), [OFFER_ROW(row, { extra: [toolUse("c", CAPTURE, { decided: "x" })] })]);
    assert.deepEqual(out.client.denials.map((d) => d.tool_name), [CAPTURE]);
    assert.equal(out.r.summary.toolCalls.find((u) => u.name === CAPTURE).isError, true);
    assert.equal(out.r.exitCode, 1);
    assert.equal(out.r.summary.verdict, "FAIL");
    assert.match(out.r.summary.notes.join(" "), /capture tool was called/);
    assert.deepEqual(out.r.summary.captureAttempts.map((c) => c.name), [CAPTURE]);
    assert.equal(lineOf(out, row), `${row}: FAIL; call spend 0.1000 USD; Skill names []`);
  });

  test(`${row} through the row: an offer without the project name fails it, exit 1`, async () => {
    const b = box();
    const phrase = ROWS[row].offerPhrase;
    const out = await run(b, b.argv(row), [OFFER_ROW(row, { text: `Want me to keep it: ${phrase}?` })]);
    assert.equal(out.r.exitCode, 1);
    assert.equal(out.r.summary.verdict, "FAIL");
    assert.match(out.r.summary.notes.join(" "), /does not name the project/);
    assert.equal(out.r.summary.offerSentence, `Want me to keep it: ${phrase}?`);
  });

  test(`${row} through the row: an init without the plugin stops before the prompt, and --plugin-dir is still required`, async () => {
    const b = box();
    const out = await run(b, b.argv(row), [[init({ session_id: "o", plugins: [] }), ok(OFFER)]]);
    assert.equal(out.r.exitCode, 3);
    assert.deepEqual(out.client.prompts, []);
    assert.match(out.r.summary.notes.join(" "), /plugin not loaded/);
    assert.equal(b.calls()[0].spend, 0);
    const n = box();
    const refused = await run(n, noPluginDir(n.argv(row)), [OFFER_ROW(row)]);
    assert.equal(refused.r.exitCode, 2);
    assert.match(refused.d.io.errors.join(" "), /--plugin-dir is required/);
    assert.equal(refused.client.calls.length, 0);
  });
}

test("Skill names: printed on a stop with no verdict, on T2 and the plugin offer rows only, and masked", async () => {
  const b = box();
  const stop = await run(b, b.argv("T4O-S"), [OFFER_ROW("T4O-S", { extra: [toolUse("k", "Skill", { skill: "other:skill" })], resultExtra: { subtype: "error_max_budget_usd" } })]);
  assert.equal(stop.r.exitCode, 3);
  assert.equal(stop.r.summary.partial, true);
  assert.ok(lineOf(stop, "T4O-S").endsWith("; Skill names [other:skill]"), lineOf(stop, "T4O-S"));
  const masked = box();
  const m = await run(masked, masked.argv("T4O-N"), [OFFER_ROW("T4O-N", { extra: [toolUse("k", "Skill", { skill: "sk-abcdefghijkl" })] })]);
  assert.ok(lineOf(m, "T4O-N").endsWith("; Skill names [<redacted>]"), lineOf(m, "T4O-N"));
  assert.deepEqual(ROW_NAMES.filter((r) => ROWS[r].skillNames), ["T2", "T4O-S", "T4O-N"]);
  for (const [row, scripts] of [["T4", T4_OK()], ["ISSUE2", [ISSUE2_OK()]], ["T4O-C", [OFFER_ROW("T4O-C")]]]) {
    const o = box();
    const out = await run(o, o.argv(row), scripts);
    assert.ok(!lineOf(out, row).includes("Skill names"), row);
    assert.equal("skillNames" in out.r.summary, false, row);
  }
});

for (const row of ["T4O-S", "T4O-N"]) {
  test(`${row} attempts: a second Opus run goes after a pass, a third refuses with no spend, and Haiku follows with its one attempt and the usual finding`, async () => {
    const b = box();
    for (let n = 0; n < 2; n++) {
      const out = await run(b, b.argv(row), [OFFER_ROW(row, { sid: `o${n}` })]);
      assert.equal(out.r.exitCode, 0, `run ${n}`);
      assert.equal(out.r.summary.verdict, "PASS", `run ${n}`);
      assert.equal(out.client.prompts.length, 1, `run ${n}`);
    }
    assert.deepEqual(b.rowsOf().map((e) => [e.row, e.verdict]), [[row, "PASS"], [row, "PASS"]]);
    const spentBefore = b.charged();
    const third = await run(b, b.argv(row), [OFFER_ROW(row)]);
    assert.equal(third.r.exitCode, 2);
    assert.match(third.d.io.errors.join(" "), new RegExp(`${row} has used 2 of 2 attempt`));
    assert.equal(third.client.calls.length, 0);
    assert.equal(b.charged(), spentBefore);
    const haiku = await run(b, b.argv(row, { model: HAIKU }), [OFFER_ROW(row, { text: "Understood." })]);
    assert.equal(haiku.r.exitCode, 1);
    assert.deepEqual(b.findings().map((f) => [f.kind, f.row]), [["haiku_failure_after_opus_pass", row]]);
    const haikuAgain = await run(b, b.argv(row, { model: HAIKU }), [OFFER_ROW(row)]);
    assert.equal(haikuAgain.r.exitCode, 2);
  });

  test(`${row} attempts: a FAIL after a PASS leaves the pass standing, so Haiku may still run, and a third Opus run refuses on the count`, async () => {
    const b = box();
    assert.equal((await run(b, b.argv(row), [OFFER_ROW(row)])).r.exitCode, 0);
    const second = await run(b, b.argv(row), [OFFER_ROW(row, { text: "Understood.", sid: "o2" })]);
    assert.equal(second.r.exitCode, 1);
    assert.equal(second.r.summary.verdict, "FAIL");
    assert.deepEqual(b.rowsOf().map((e) => e.verdict), ["PASS", "FAIL"]);
    assert.equal(opusPassedAtHead({ entries: b.entries() }, row, HEAD), true);
    assert.equal((await run(b, b.argv(row), [OFFER_ROW(row)])).r.exitCode, 2);
    const haiku = await run(b, b.argv(row, { model: HAIKU }), [OFFER_ROW(row)]);
    assert.equal(haiku.r.exitCode, 0);
    assert.equal(haiku.r.summary.verdict, "PASS");
  });
}

test("repeatAfterPass: a second attempt on a new ledger still refuses, since the record holds the first", async () => {
  const b = box();
  assert.equal((await run(b, b.argv("T4O-S"), [OFFER_ROW("T4O-S")])).r.exitCode, 0);
  const other = b.p("other-ledger.json");
  nodefs.writeFileSync(other, JSON.stringify({ entries: [] }));
  const argv = b.argv("T4O-S").map((a) => (a === b.ledger ? other : a));
  const out = await run(b, argv, [OFFER_ROW("T4O-S")]);
  assert.equal(out.r.exitCode, 2);
  assert.match(out.d.io.errors.join(" "), /holds 1 attempt\(s\) at this head that the ledger/);
  assert.equal(out.client.calls.length, 0);
});

test("repeatAfterPass: only T4O-S and T4O-N set it, and every other row keeps the refusal, by exit 2 with no call and no spend", async () => {
  assert.deepEqual(ROW_NAMES.filter((r) => ROWS[r].repeatAfterPass), ["T4O-S", "T4O-N"]);
  const b = box();
  assert.equal((await run(b, b.argv("T4"), T4_OK())).r.exitCode, 0);
  const spentBefore = b.charged();
  const callsBefore = b.calls().length;
  const again = await run(b, b.argv("T4"), T4_OK());
  assert.equal(again.r.exitCode, 2);
  assert.match(again.d.io.errors.join(" "), /T4 already passed on Opus at this head/);
  assert.equal(again.client.calls.length, 0);
  assert.equal(b.charged(), spentBefore);
  assert.equal(b.calls().length, callsBefore);
  for (const row of ["T2", "T5", "T6", "ISSUE2"]) {
    const state = { calls: [] };
    const ledger = { entries: [rowEntry({ row, verdict: "PASS" })] };
    assert.throws(() => checkAttempts(ledger, state, { row, model: OPUS, head: HEAD }), new RegExp(`${row} already passed on Opus`), row);
  }
  assert.doesNotThrow(() => checkAttempts({ entries: [rowEntry({ row: "T4O-C", verdict: "PASS" })] }, { calls: [] }, { row: "T4O-S", model: OPUS, head: HEAD }));
  assert.throws(() => checkAttempts({ entries: [rowEntry({ row: "T4O-C", verdict: "PASS" })] }, { calls: [] }, { row: "T4O-C", model: OPUS, head: HEAD }), /already passed/); // not set there; DIAGNOSTIC never makes this entry
});

test("repeatAfterPass: no flag or override can set it, on a row that lacks it", async () => {
  const b = box();
  assert.equal((await run(b, b.argv("T4"), T4_OK())).r.exitCode, 0);
  for (const flag of ["--repeat-after-pass", "--repeatAfterPass"]) {
    const out = await run(b, [...b.argv("T4"), flag], T4_OK());
    assert.equal(out.r.exitCode, 2, flag);
    assert.match(out.d.io.errors.join(" "), /unknown flag/, flag);
    assert.equal(out.client.calls.length, 0, flag);
  }
  assert.ok(!LIFTABLE.includes("repeatAfterPass"));
  const raw = JSON.stringify({ reason: "x", expires: "2026-11-05T01:00:00Z", lifts: ["repeatAfterPass"] });
  assert.throws(() => loadOverride(raw, Date.parse("2026-11-05T00:00:00Z")), /names checks that do not exist/);
  const file = b.p("override.json");
  nodefs.writeFileSync(file, raw);
  const out = await run(b, b.argv("T4", undefined, ["--override", file]), T4_OK());
  assert.equal(out.r.exitCode, 2);
  assert.equal(out.client.calls.length, 0);
});

test("the name rule through T4O-S: the offer's own sentence, the one before and the one after pass; two sentences away fails, on either side", async () => {
  for (const [where, text, verdict] of [
    ["own", "Want me to keep recall only in quadron-connect?", "PASS"],
    ["before", "This is for quadron-connect. Want me to keep recall only?", "PASS"],
    ["after", "Want me to keep recall only? It would go in quadron-connect.", "PASS"],
    ["two before", "This is for quadron-connect. Understood. Want me to keep recall only?", "FAIL"],
    ["two after", "Want me to keep recall only? Understood. It would go in quadron-connect.", "FAIL"],
  ]) {
    const b = box();
    const out = await run(b, b.argv("T4O-S"), [OFFER_ROW("T4O-S", { text })]);
    assert.equal(out.r.summary.verdict, verdict, where);
    assert.equal(out.r.exitCode, verdict === "PASS" ? 0 : 1, where);
    if (verdict === "FAIL") assert.match(out.r.summary.notes.join(" "), /the offer does not name the project/, where);
  }
});

test("T6 is untouched: a T4O pass holds nothing T6 can stand on", async () => {
  const entries = [rowEntry({ row: "T4O-S", verdict: "PASS", judgmentId: JID, savedWording: WORDING }), { kind: "confirmation", judgmentId: JID, head: HEAD, at: "x" }];
  assert.equal(t6Prerequisite({ entries }, HEAD).ok, false);
  const b = box({ entries });
  const { r, client } = await run(b, b.argv("T6"), [[]]);
  assert.equal(r.exitCode, 2);
  assert.equal(client.calls.length, 0);
});

// ---------------------------------------------------------------- T4O-C

test("T4O-C verdict: DIAGNOSTIC on every shape, with notes saying offered first or not and capture attempted or not", () => {
  const cases = [
    [rec(initC(), assistantText(OFFER), ok(OFFER)), "offered first: yes", "capture attempted: no"],
    [rec(initC(), ok("Understood.")), /^offered first: no \(no offer with the stated phrase/, "capture attempted: no"],
    [rec(initC(), assistantText("Want me to keep it: recall only?"), ok("x")), /^offered first: no \(the offer does not name the project/, "capture attempted: no"],
    [rec(initC(), toolUse("c", CAPTURE, {}), ok("Saved.")), /^offered first: no \(a capture tool was called\)/, "capture attempted: yes"],
    [rec(initC(), assistantText(OFFER), result(0.1, { result: OFFER, permission_denials: [denial("c", CAPTURE)] })), /^offered first: no \(a capture tool was called\)/, "capture attempted: yes"],
    [rec(initC(), assistantText(OFFER), result(0.1, { subtype: "error_max_turns" })), "offered first: yes", "capture attempted: no"],
    [rec(initC()), /^offered first: no/, "capture attempted: no"],
  ];
  for (const [s, offered, captured] of cases) {
    const v = verdict("T4O-C", s);
    assert.equal(v.verdict, "DIAGNOSTIC");
    if (typeof offered === "string") assert.equal(v.notes[0], offered); else assert.match(v.notes[0], offered);
    assert.equal(v.notes[1], captured);
    assert.ok(v.notes.includes(OFFER_HEURISTIC_NOTE));
  }
  assert.ok(verdict("T4O-C", rec(initC(), result(0.1, { subtype: "error_max_turns" }))).notes.includes("result was error_max_turns"));
  assert.equal(verdict("T4O-C", said(OFFER)).offerSentence, OFFER);
  assert.equal("offerSentence" in verdict("T4O-C", said("Understood.")), false);
});

for (const [shape, script, notes] of [
  ["offered first", () => OFFER_ROW("T4O-C"), ["offered first: yes", "capture attempted: no"]],
  ["captured first, denied", () => OFFER_ROW("T4O-C", { text: "It is saved.", extra: [toolUse("c", CAPTURE, { decided: "x" })] }), ["offered first: no (a capture tool was called)", "capture attempted: yes"]],
]) {
  test(`T4O-C through the row, ${shape}: DIAGNOSTIC, exit 0, no finding, and the word reaches the printed line and the ledger`, async () => {
    const b = box();
    const out = await run(b, b.argv("T4O-C"), [script()]);
    assert.equal(out.r.exitCode, 0);
    assert.equal(out.r.summary.exitCode, 0);
    assert.equal(out.r.summary.verdict, "DIAGNOSTIC");
    assert.deepEqual(out.r.summary.notes.slice(0, 2), notes);
    assert.equal(lineOf(out, "T4O-C"), "T4O-C: DIAGNOSTIC; call spend 0.1000 USD");
    assert.deepEqual(b.findings(), []);
    assert.deepEqual(out.r.summary.findings, []);
    assert.equal(nodefs.existsSync(path.join(b.out, "findings.jsonl")), false);
    assert.deepEqual(b.rowsOf().map((e) => [e.row, e.verdict]), [["T4O-C", "DIAGNOSTIC"]]);
    assert.deepEqual(Object.keys(b.rowsOf()[0]).sort(), ["at", "head", "kind", "model", "row", "verdict"]);
    assert.equal(b.calls()[0].verdict, "DIAGNOSTIC");
    assert.equal(b.summary().verdict, "DIAGNOSTIC");
  });
}

test("T4O-C options: no plugins and no skills, with or without --plugin-dir; ToolSearch alone as the built-in set; every session guard still holds", async () => {
  const withDir = box();
  const noDir = box();
  for (const [b, argv] of [[withDir, withDir.argv("T4O-C")], [noDir, noPluginDir(noDir.argv("T4O-C"))]]) {
    const { r, client } = await run(b, argv, [OFFER_ROW("T4O-C")]);
    assert.equal(r.exitCode, 0);
    const { options } = client.calls[0];
    assert.equal("plugins" in options, false);
    assert.equal("skills" in options, false);
    assert.equal("hooks" in options, false);
    assert.deepEqual(options.tools, ["ToolSearch"]);
    assert.deepEqual(options.allowedTools, ["ToolSearch", "mcp__quadron__quad_context", "mcp__quadron__quad_search", "mcp__quadron__quad_recall"]);
    assert.equal(options.maxTurns, 5);
    assert.equal(options.permissionMode, "dontAsk");
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.strictMcpConfig, true);
    assert.ok(options.mcpServers.quadron);
    assert.doesNotThrow(() => assertSessionOptions(options));
    assert.equal(client.prompts[0].text, ROWS.T4.turns[0].prompt);
  }
});

test("--plugin-dir: T4O-C alone goes without it; an init form refuses whatever --row says", async () => {
  const b = box();
  const argv = noPluginDir(b.initArgv(["--row", "T4O-C"]));
  const { r, client, d } = await run(b, argv, [[init()]]);
  assert.equal(r.exitCode, 2);
  assert.match(d.io.errors.join(" "), /--plugin-dir is required/);
  assert.equal(client.calls.length, 0);
  for (const row of ROW_NAMES.filter((n) => n !== "T4O-C")) {
    const o = box();
    const out = await run(o, noPluginDir(o.argv(row)), [[]]);
    assert.equal(out.r.exitCode, 2, row);
    assert.match(out.d.io.errors.join(" "), /--plugin-dir is required/, row);
  }
});

test("the load check: T4O-C passes without the plugin, and every other session row fails without it, by the same function", () => {
  const ev = (plugins, tools) => ({ source: "init message", plugins, pluginErrors: 0, mcpServers: [{ name: "quadron", status: "connected" }], tools });
  const rowsWithSession = ROW_NAMES.filter((r) => !ROWS[r].noSession);
  assert.ok(rowsWithSession.includes("T4O-S") && rowsWithSession.includes("T4O-N") && rowsWithSession.includes("T4"));
  for (const row of rowsWithSession) {
    const def = { ...ROWS[row], tools: turnTools(ROWS[row], ROWS[row].turns[0]) };
    const tools = [...def.tools];
    if (ROWS[row].noPlugin) {
      for (const none of [[], undefined]) assert.equal(checkSession(ev(none, tools), def), null, row);
      assert.match(checkSession(ev([{ name: "quadron" }], tools), def).message, /plugin loaded on a row that runs without it/);
    } else {
      for (const none of [[], undefined, [{ name: "other" }]]) assert.match(checkSession(ev(none, tools), def).message, /plugin not loaded/, row);
      assert.equal(checkSession(ev([{ name: "quadron" }], tools), def), null, row);
    }
  }
  assert.deepEqual(rowsWithSession.filter((r) => ROWS[r].noPlugin), ["T4O-C"]);
});

test("T4O-C: Skill in init is recorded and no stop, early or late, with the note; without it there is no note", async () => {
  for (const initTiming of ["before", "after"]) {
    const b = box();
    const out = await run(b, b.argv("T4O-C"), [{ messages: OFFER_ROW("T4O-C").map((m, i) => (i === 0 ? initC({ session_id: "o", tools: ["ToolSearch", "Skill"] }) : m)), initTiming }], { timeoutMs: 100 });
    assert.equal(out.r.summary.verdict, "DIAGNOSTIC", initTiming);
    assert.equal(out.r.exitCode, 0, initTiming);
    assert.ok(out.r.summary.notes.includes("Skill listed in init"), initTiming);
    assert.deepEqual(out.r.summary.init.toleratedTools, ["Skill"], initTiming);
    assert.equal(out.client.calls[0].options.tools.includes("Skill"), false, initTiming);
  }
  const plain = box();
  const out = await run(plain, plain.argv("T4O-C"), [OFFER_ROW("T4O-C")]);
  assert.ok(!out.r.summary.notes.includes("Skill listed in init"));
});

test("the tool-set check stays exact: another tool on T4O-C or an offer row stops, and only noPlugin tolerates Skill", async () => {
  for (const [row, initMsg] of [
    ["T4O-C", initC({ tools: ["ToolSearch", "Skill", "Read"] })],
    ["T4O-S", init({ tools: ["Skill", "ToolSearch", "Read"] })],
    ["T4O-N", init({ tools: ["Skill", "ToolSearch", "Read"] })],
  ]) {
    const b = box();
    const out = await run(b, b.argv(row), [[initMsg, ok(OFFER)]]);
    assert.equal(out.r.exitCode, 3, row);
    assert.deepEqual(out.client.prompts, [], row);
    assert.match(out.r.summary.notes.join(" "), /outside this turn's set: Read/, row);
  }
  const ev = { source: "init message", plugins: [{ name: "quadron" }], pluginErrors: 0, mcpServers: [{ name: "quadron", status: "connected" }], tools: ["ToolSearch", "Skill"] };
  assert.match(checkSession(ev, { connector: true, tools: ["ToolSearch"] }).message, /outside this turn's set: Skill/);
  const b = box();
  const t2 = await run(b, b.argv("T2"), [[init({ mcp_servers: [], tools: ["Skill", "ToolSearch", "Read"] }), ok("x")]]);
  assert.equal(t2.r.exitCode, 3);
});

test("T4O-C load check through the row: a late init without the plugin goes on; the plugin in init, another tool, or a server that will not connect are load stops, not results", async () => {
  const late = box();
  const a = await run(late, late.argv("T4O-C"), [{ messages: OFFER_ROW("T4O-C"), initTiming: "after" }], { timeoutMs: 100 });
  assert.equal(a.r.summary.verdict, "DIAGNOSTIC");
  assert.equal(a.r.exitCode, 0);

  const plugged = box();
  const p = await run(plugged, plugged.argv("T4O-C"), [[initC({ plugins: [{ name: "quadron", path: "/x" }] }), ok(OFFER)]]);
  assert.equal(p.r.exitCode, 3);
  assert.deepEqual(p.client.prompts, []);
  assert.match(p.r.summary.notes.join(" "), /plugin loaded on a row that runs without it/);

  const skilled = box();
  const s = await run(skilled, skilled.argv("T4O-C"), [{ messages: [initC({ tools: ["ToolSearch", "Read"] }), ok(OFFER)], initTiming: "after" }], { timeoutMs: 100 });
  assert.equal(s.r.exitCode, 3);
  assert.equal(s.r.summary.verdict, "LOAD FAILURE");
  assert.match(s.r.summary.notes.join(" "), /outside this turn's set: Read/);

  const down = box();
  const f = await run(down, down.argv("T4O-C"), [{ messages: OFFER_ROW("T4O-C"), status: [{ name: "quadron", status: "failed" }] }], { timeoutMs: 500 });
  assert.equal(f.r.exitCode, 3);
  assert.equal(f.r.summary.verdict, "LOAD FAILURE");
  assert.deepEqual(f.client.prompts, []);
  for (const b of [plugged, skilled, down]) assert.deepEqual(b.findings(), []);
});

test("T4O-C stops are reported as on any row: a budget stop, an auth failure, a pending server that is never reached", async () => {
  const budget = box();
  const a = await run(budget, budget.argv("T4O-C"), [OFFER_ROW("T4O-C", { resultExtra: { subtype: "error_max_budget_usd" } })]);
  assert.equal(a.r.exitCode, 3);
  assert.equal(a.r.summary.verdict, "PARTIAL (not a result)");
  const auth = box();
  const b = await run(auth, auth.argv("T4O-C"), [OFFER_ROW("T4O-C", { extra: [toolUse("r", READ), toolResult("r", "HTTP 401 Unauthorized")] })]);
  assert.equal(b.r.exitCode, 4);
  assert.equal(b.r.summary.verdict, "auth failure");
  const pending = box();
  const c = await run(pending, pending.argv("T4O-C"), [[initC({ session_id: "o", mcp_servers: [{ name: "quadron", status: "pending" }] }), assistantText(OFFER), result(0.1, { session_id: "o", result: OFFER })]]);
  assert.equal(c.r.exitCode, 3);
  assert.equal(c.r.summary.verdict, "LOAD FAILURE");
});

test("T4O-C never reads FAIL: a guard that fails any other row is a stop here, exit 3 with no result, while T4O-S still fails", async () => {
  const web = (row) => OFFER_ROW(row, { extra: [toolUse("w", "WebFetch", { url: "x" })] });
  const cut = (row) => OFFER_ROW(row, { text: null, extra: [assistantCut(OFFER)] });
  for (const [script, re] of [[web, /web, browser or sub-agent tool invoked: WebFetch/], [cut, /cut off at the output limit/]]) {
    const c = box();
    const diag = await run(c, c.argv("T4O-C"), [script("T4O-C")]);
    assert.equal(diag.r.exitCode, 3, String(re));
    assert.equal(diag.r.summary.verdict, "PARTIAL (not a result)", String(re));
    assert.match(diag.r.summary.notes.join(" "), re);
    assert.equal(diag.r.summary.partial, true);
    assert.deepEqual(c.findings(), []);
    const s = box();
    const plugin = await run(s, s.argv("T4O-S"), [script("T4O-S")]);
    assert.equal(plugin.r.exitCode, 1, String(re));
    assert.equal(plugin.r.summary.verdict, "FAIL", String(re));
  }
  const listed = box();
  const l = await run(listed, listed.argv("T4O-C"), [[initC({ tools: ["ToolSearch", "Agent"] }), ok(OFFER)]]);
  assert.equal(l.r.exitCode, 3);
  assert.equal(l.r.summary.verdict, "PARTIAL (not a result)");
  assert.match(l.r.summary.notes.join(" "), /init lists forbidden tools: Agent/);
  assert.deepEqual(l.client.prompts, []);
});

test("T4O-C adds nothing to the findings: capture_owner_unavailable is a note there, and stays a finding on T4O-S", async () => {
  const extra = [toolUse("r", READ), toolResult("r", "capture_owner_unavailable")];
  const c = box();
  const diag = await run(c, c.argv("T4O-C"), [OFFER_ROW("T4O-C", { extra })]);
  assert.equal(diag.r.exitCode, 0);
  assert.equal(diag.r.summary.verdict, "DIAGNOSTIC");
  assert.deepEqual(c.findings(), []);
  assert.match(diag.r.summary.notes.join(" "), /capture_owner_unavailable seen/);
  const s = box();
  await run(s, s.argv("T4O-S"), [OFFER_ROW("T4O-S", { extra })]);
  assert.deepEqual(s.findings().map((f) => f.kind), ["capture_owner_unavailable"]);
});

test("T4O-C and hygiene: the verdict word stays, since it is no pass to overturn, and the failure still takes the exit to 1", async () => {
  const b = box();
  const out = await run(b, b.argv("T4O-C"), [() => { nodefs.writeFileSync(path.join(b.repo, "written-by-child"), "x"); return OFFER_ROW("T4O-C"); }]);
  assert.equal(out.r.summary.verdict, "DIAGNOSTIC");
  assert.equal(out.r.exitCode, 1);
  assert.ok(out.d.io.lines.some((l) => /hygiene failure: the clone changed/.test(l)));
});

test("T4O-C and the limits: DIAGNOSTIC is no pass, so a second Opus attempt runs, the third refuses, and Haiku always refuses", async () => {
  const b = box();
  for (let n = 0; n < 2; n++) assert.equal((await run(b, b.argv("T4O-C"), [OFFER_ROW("T4O-C", { sid: `o${n}` })])).r.exitCode, 0);
  const third = await run(b, b.argv("T4O-C"), [OFFER_ROW("T4O-C")]);
  assert.equal(third.r.exitCode, 2);
  assert.match(third.d.io.errors.join(" "), /T4O-C has used 2 of 2 attempt/);
  assert.equal(third.client.calls.length, 0);
  const haiku = await run(b, b.argv("T4O-C", { model: HAIKU }), [OFFER_ROW("T4O-C")]);
  assert.equal(haiku.r.exitCode, 2);
  assert.match(haiku.d.io.errors.join(" "), /T4O-C has no Opus pass at this head/);
  assert.equal(haiku.client.calls.length, 0);
  assert.deepEqual(b.findings(), []);
});

// ---------------------------------------------------------------- flags and dry-run

test("--dry-run: each new row by its hyphenated name, on the row's own line; the rows designed but not built refuse", async () => {
  const b = box();
  const base = (row) => `would run ${row}: 1 turn(s), caps 5, one command and one session`;
  for (const [row, tail] of [
    ["T4O-S", '; offer phrase "recall only"'],
    ["T4O-N", '; offer phrase "annual pricing"'],
    ["T4O-C", '; offer phrase "recall only"; connector only, no plugin or skill; diagnostic: never a pass, exit 0 whichever way the turn goes'],
  ]) {
    const d = b.deps();
    assert.equal((await main({ argv: ["--dry-run", "--row", row], env: DRY_ENV, ...d })).exitCode, 0, row);
    assert.ok(d.io.lines.includes(`${base(row)}${tail}`), d.io.lines.join("\n"));
  }
  const whole = b.deps();
  assert.equal((await main({ argv: ["--dry-run"], env: DRY_ENV, ...whole })).exitCode, 0);
  assert.ok(whole.io.lines.includes("would run T4: 2 turn(s), caps 5/5, one command and one session"));
  for (const row of ["T4O-H", "T3B", "T4O", "t4o-s"]) assert.equal((await main({ argv: ["--dry-run", "--row", row], env: DRY_ENV, ...b.deps() })).exitCode, 2, row);
  assert.match(USAGE, /T4O-S\|T4O-N\|T4O-C/);
});
