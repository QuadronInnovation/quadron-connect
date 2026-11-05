// Direct verdict tests, on the records collect() builds from messages shaped per the types.
import test from "node:test";
import assert from "node:assert/strict";
import { OFFER_HEURISTIC_NOTE, STATUS_WINDOW_CHARS, T6_STATUS_NOTE, collect, isOffer, judgmentIdFrom, reportsFailedWrite, routingOf, savedWordingFrom, signedClaimField, skillLabel, turnGate, verdictIssue2, verdictT2, verdictT4, verdictT5, verdictT6 } from "../lib/verdicts.mjs";
import { Redactor } from "../lib/redact.mjs";
import { CAPTURE, OFFER, READ, SKILL, assistantText, init, result, toolResult, toolUse } from "./helpers.mjs";

const rec = (...msgs) => collect(msgs);
const denied = (s, name = CAPTURE) => { s.denied_captures = [{ name, input: {} }]; return s; };
const ok = (text) => result(0.1, { result: text });
// What a real turn holds: the assistant's text, and a result repeating it.
const said = (text) => [assistantText(text), ok(text)];

// ---- T2
test("F17. T2 PASS: success result, non-empty answer, skill tool call seen", () => {
  assert.equal(verdictT2([rec(init({ mcp_servers: [] }), SKILL(), ok("Not reachable."))]).verdict, "PASS");
});
test("F17. T2 FAIL: an error result, an empty answer, no skill call, no result, a Quadron tool, a configured server", () => {
  const cases = [
    [rec(init({ mcp_servers: [] }), SKILL(), result(0.1, { subtype: "error_during_execution", result: "x" })), /error_during_execution/],
    [rec(init({ mcp_servers: [] }), SKILL(), result(0.1, { subtype: "error_max_turns" })), /error_max_turns/],
    [rec(init({ mcp_servers: [] }), SKILL(), ok("   ")), /empty answer/],
    [rec(init({ mcp_servers: [] }), ok("An answer.")), /skill tool/],
    [rec(init({ mcp_servers: [] }), SKILL()), /no result/],
    [rec(init({ mcp_servers: [] }), SKILL(), toolUse("q", READ), ok("x")), /Quadron tool/],
    [denied(rec(init({ mcp_servers: [] }), SKILL(), ok("x"))), /Quadron tool/],
    [rec(init(), SKILL(), ok("x")), /server was configured/],
  ];
  for (const [s, re] of cases) {
    const v = verdictT2([s]);
    assert.equal(v.verdict, "FAIL", String(re));
    assert.match(v.notes.join(" "), re);
  }
});
const skillRow = (...uses) => rec(init({ mcp_servers: [] }), ...uses, ok("An answer."));
test("T2 skill name. input.skill passes, and so does input.name when skill holds no name; the verdict returns no inputs", () => {
  for (const input of [{ skill: "quadron:quadron", args: "x" }, { skill: "quadron:quadron" }, { name: "quadron:quadron" }, { name: "quadron:quadron", args: "x" }, { skill: "quadron:quadron", name: "other:skill" }, { skill: 1, name: "quadron:quadron" }]) {
    const v = verdictT2([skillRow(toolUse("s", "Skill", input))]);
    assert.equal(v.verdict, "PASS", JSON.stringify(input));
    assert.equal("skillInputs" in v, false);
  }
});
test("T2 skill name. the value anywhere but the one field read fails: in name beside another skill, in args, or only nested", () => {
  for (const input of [{ skill: "other:skill", name: "quadron:quadron" }, { skill: "other:skill", args: "quadron:quadron" }, { a: { b: ["quadron:quadron"] } }, { args: { skill: "quadron:quadron" } }, { input: { name: "quadron:quadron" } }, { args: "quadron:quadron" }]) {
    const v = verdictT2([skillRow(toolUse("s", "Skill", input))]);
    assert.equal(v.verdict, "FAIL", JSON.stringify(input));
    assert.match(v.notes.join(" "), /1 of 1 Skill calls do not name quadron:quadron in input\.skill, or else input\.name/);
  }
  assert.equal(skillLabel({ skill: "other:skill", name: "quadron:quadron" }, new Redactor()), "other:skill");
  assert.equal(skillLabel({ skill: "quadron:quadron", name: "other:skill" }, new Redactor()), "quadron:quadron");
});
test("T2 skill name. the labels: the skill value, then the name value, none, a non-string skill, and a long or control-character value reduced", () => {
  const label = (input) => skillLabel(input, new Redactor());
  assert.equal(label({ skill: "other:skill", args: "x" }), "other:skill");
  assert.equal(label({ skill: "other:skill", args: "quadron:quadron" }), "other:skill");
  assert.equal(label({ name: "quadron:quadron" }), "quadron:quadron");
  assert.equal(label({ name: "other:skill" }), "other:skill");
  for (const none of [{}, { n: 1 }, { args: "other" }, { args: "quadron:quadron" }, { a: { b: ["quadron:quadron"] } }, { args: { skill: "quadron:quadron" } }, "quadron:quadron", null, undefined]) assert.equal(label(none), "no skill name", JSON.stringify(none));
  for (const bad of [1, true, null, ["other"], { a: "other" }, ""]) assert.equal(label({ skill: bad }), "no skill name", JSON.stringify(bad));
  assert.equal(label({ skill: 1, name: "quadron:quadron" }), "quadron:quadron");
  assert.equal(label({ skill: "y".repeat(500) }), "y".repeat(40));
  assert.equal(label({ skill: "a\nb\tc\u001b[0m d" }), "a_b_c__0m_d");
  assert.equal(label({ skill: "[x], y" }), "_x___y");
});
test("T2 skill name. another name, no string values or a non-object input fail", () => {
  for (const input of [{ skill: "other:skill", args: "x" }, { skill: "quadron" }, { skill: "quadron:quadron " }, {}, { n: 1, ok: true }, "quadron:quadron", undefined]) {
    const v = verdictT2([skillRow(toolUse("s", "Skill", input))]);
    assert.equal(v.verdict, "FAIL", JSON.stringify(input));
    assert.match(v.notes.join(" "), /1 of 1 Skill calls do not name quadron:quadron in input\.skill, or else input\.name/);
  }
});
test("T2 skill name. every Skill call is held to it: a denied or errored one with another name fails beside a good call", () => {
  const good = () => [toolUse("g", "Skill", { skill: "quadron:quadron" }), toolResult("g", "ok")];
  const errored = verdictT2([skillRow(toolUse("e", "Skill", { skill: "other" }), toolResult("e", "boom", true), ...good())]);
  const refused = skillRow(toolUse("d", "Skill", { skill: "other" }), ...good());
  refused.denied_ids.add("d");
  for (const v of [errored, verdictT2([refused])]) {
    assert.equal(v.verdict, "FAIL");
    assert.match(v.notes.join(" "), /1 of 2 Skill calls/);
  }
});

// ---- T4
const turn2 = (extra = [], { name = CAPTURE, quad = "quadron-connect", text = "Saved for your review", isError = false } = {}) =>
  rec(init(), toolUse("u1", name, { quad_name: quad }), toolResult("u1", text, isError), ...extra, ok("Saved."));
const turn1 = () => rec(init(), ...said(OFFER));

test("F18. T4 PASS: the offer, then exactly one capture with quad_name recorded", () => {
  const v = verdictT4([turn1(), turn2()]);
  assert.equal(v.verdict, "PASS");
  assert.equal(v.quadName, "quadron-connect");
  assert.equal(v.captureTool, CAPTURE);
  assert.match(v.notes.join(" "), /pending review/);
});
test("F18. T4 FAIL: no phrase, capture on turn 1, none on turn 2, two on turn 2, an error result, the other capture tool, a wrong or missing quad_name, turn 2 not success", () => {
  const two = rec(init(), toolUse("a", CAPTURE, { quad_name: "quadron-connect" }), toolResult("a", "ok"), toolUse("b", CAPTURE, { quad_name: "quadron-connect" }), toolResult("b", "ok"), ok("x"));
  const cases = [
    [[rec(init(), ok("Keep it in quadron-connect?")), turn2()], /recall only/],
    [[rec(init(), toolUse("z", CAPTURE, {}), ok(OFFER)), turn2()], /captured before confirmation/],
    [[denied(rec(init(), ok(OFFER))), turn2()], /captured before confirmation/],
    [[rec(init(), result(0.1, { subtype: "error_during_execution", result: OFFER })), turn2()], /no success result/],
    [[turn1(), rec(init(), ok("no capture"))], /calls: 0/],
    [[turn1(), two], /calls: 2/],
    [[turn1(), turn2([], { isError: true, text: "failed" })], /accepted: 0/],
    [[turn1(), turn2([], { name: "mcp__quadron__quad_commit" })], /another capture tool/],
    [[turn1(), turn2([], { quad: "other" })], /quad_name/],
    [[turn1(), rec(init(), toolUse("u", CAPTURE, {}), toolResult("u", "ok"), ok("x"))], /quad_name/],
    [[turn1(), rec(init(), toolUse("u1", CAPTURE, { quad_name: "quadron-connect" }), toolResult("u1", "ok"), result(0.1, { subtype: "error_max_turns" }))], /error_max_turns/],
  ];
  for (const [s, re] of cases) {
    const v = verdictT4(s);
    assert.equal(v.verdict, "FAIL", String(re));
    assert.match(v.notes.join(" "), re);
  }
});
test("F18. T4 observations never change the verdict", () => {
  for (const text of ["Saved, unrouted.", JSON.stringify({ judgment_id: "j", signed_claim: "abc" }), "plain"]) {
    assert.equal(verdictT4([turn1(), turn2([], { text })]).verdict, "PASS", text);
  }
});
test("F18. signed claim field: present with its field name, or absent, from text or structured data; the value is not returned", () => {
  assert.deepEqual(signedClaimField({ text: JSON.stringify({ a: { signature: "s3cret" } }) }), { state: "present", field: "signature" });
  assert.deepEqual(signedClaimField({ text: "x", structured: { signed_claim: "s3cret" } }), { state: "present", field: "signed_claim" });
  assert.deepEqual(signedClaimField({ text: "signed_claim: s3cret" }), { state: "present", field: "signed_claim" });
  assert.deepEqual(signedClaimField({ text: "Saved for your review" }), { state: "absent" });
  assert.deepEqual(signedClaimField(null), { state: "absent" });
});
test("F18. judgment id: from a named key, a root id, a structured result or text; otherwise not shown", () => {
  assert.equal(judgmentIdFrom({ text: JSON.stringify({ result: { judgment_id: "j1" } }) }), "j1");
  assert.equal(judgmentIdFrom({ text: JSON.stringify({ id: 42 }) }), "42");
  assert.equal(judgmentIdFrom({ text: "x", structured: { judgmentId: "j2" } }), "j2");
  assert.equal(judgmentIdFrom({ text: "Saved. judgment id: j3." }), "j3");
  assert.equal(judgmentIdFrom({ text: "Saved for your review" }), "not shown");
  assert.equal(judgmentIdFrom(null), "not shown");
});
test("F18. routing: routed, unrouted or not shown", () => {
  assert.equal(routingOf({ text: "in quadron-connect" }), "routed");
  assert.equal(routingOf({ text: "landed unrouted in quadron-connect" }), "unrouted");
  assert.equal(routingOf({ text: "Saved" }), "not shown");
});

// ---- T5
const t5a = () => rec(init(), ok("A two sentence summary."));
const t5b = () => rec(init(), ok("I will not save that."));
test("F6. T5 PASS-MECHANICAL needs review; wording that may offer capture is flagged", () => {
  const v = verdictT5([t5a(), t5b()]);
  assert.equal(v.verdict, "PASS-MECHANICAL");
  assert.equal(v.review, true);
  assert.deepEqual(v.notes, []);
  assert.match(verdictT5([rec(init(), ok("Shall I save this?")), t5b()]).notes[0], /may offer capture/);
});
test("F6. T5 FAIL: a capture attempt on either turn, an error result, a missing turn", () => {
  for (const [s, re] of [
    [[rec(init(), toolUse("c", CAPTURE, {}), ok("x")), t5b()], /turn 1 called a capture/],
    [[t5a(), rec(init(), toolUse("c", CAPTURE, {}), ok("x"))], /turn 2 called a capture/],
    [[t5a(), denied(t5b())], /turn 2 called a capture/],
    [[rec(init(), result(0.1, { subtype: "error_during_execution" })), t5b()], /turn 1 result/],
    [[t5a(), rec(init(), result(0.1, { subtype: "error_max_turns" }))], /turn 2 result/],
    [[t5a()], /turn 2 did not run/],
  ]) {
    const v = verdictT5(s);
    assert.equal(v.verdict, "FAIL", String(re));
    assert.match(v.notes.join(" "), re);
  }
});

// ---- T6
const SAVED = "The plugin ships recall only; capture needs my approval";
const read = (text = `Judgment: ${SAVED}. Status: confirmed.`, tool = READ) => [toolUse("r", tool), toolResult("r", text)];
const saved = { savedWording: SAVED };
test("F19. T6 PASS: a read tool's result holding the saved wording and an answer citing the project, with the id recorded", () => {
  for (const tool of ["quad_context", "quad_search", "quad_recall", "quad_read"]) {
    const v = verdictT6([rec(init(), ...read(undefined, `mcp__quadron__${tool}`), ok("From quadron-connect."))], { judgmentId: "j", ...saved });
    assert.equal(v.verdict, "PASS", tool);
    assert.equal(v.judgmentId, "j");
  }
});
test("F19. T6 FAIL: a capture attempt, no read tool, no citation, an error result, no result", () => {
  for (const [s, re] of [
    [rec(init(), ...read(), toolUse("c", CAPTURE, {}), ok("quadron-connect")), /capture tool/],
    [denied(rec(init(), ...read(), ok("quadron-connect"))), /capture tool/],
    [rec(init(), ok("quadron-connect")), /no read tool/],
    [rec(init(), ...read(), ok("no project named")), /does not cite/],
    [rec(init(), ...read(), result(0.1, { subtype: "error_during_execution", result: "quadron-connect" })), /error_during_execution/],
    [rec(init(), ...read()), /no result/],
  ]) {
    const v = verdictT6([s], saved);
    assert.equal(v.verdict, "FAIL", String(re));
    assert.match(v.notes.join(" "), re);
  }
});
test("H3/G1. T6 cannot pass without reading the judgment: quad_context alone, a citation alone, the wording only in the answer, another tool's result or an errored read all FAIL", () => {
  const wrong = /holds T4's saved wording/;
  for (const s of [
    rec(init(), ...read("FIT: no_match"), ok("From quadron-connect.")), // the read ran; the judgment did not come back
    rec(init(), ...read("recall only"), ok("From quadron-connect.")), // a fragment is not the saved wording
    rec(init(), ...read("FIT: no_match"), ok(`From quadron-connect: ${SAVED}`)), // the answer alone
    rec(init(), toolUse("r", READ), toolResult("r", SAVED, true), ok("From quadron-connect.")), // an errored read
    rec(init(), toolUse("r", READ), toolResult("r", "x"), toolUse("s", "Skill"), toolResult("s", SAVED), ok("From quadron-connect.")), // not a read tool
  ]) {
    const v = verdictT6([s], saved);
    assert.equal(v.verdict, "FAIL");
    assert.match(v.notes.join(" "), wrong);
  }
  for (const missing of [{}, { savedWording: null }, { savedWording: "" }, { savedWording: "not shown" }]) {
    const v = verdictT6([rec(init(), ...read(), ok("From quadron-connect."))], missing); // the ledger record alone can never pass it
    assert.equal(v.verdict, "FAIL");
    assert.match(v.notes.join(" "), /no saved wording/);
  }
});
const t6With = (text, opts = saved, answerText = "From quadron-connect.") => verdictT6([rec(init(), ...read(text), ok(answerText))], opts);
const t6Struct = (structured, text = "see data") => verdictT6([rec(init(), toolUse("r", READ), toolResult("r", text, false, structured), ok("quadron-connect"))], saved);

test("H3/D8. T6's wording may differ from T4's in spacing, case and punctuation, in text or structured data; the whole wording must appear", () => {
  const spaced = "Judgment:  The plugin ships recall only;\n capture needs my approval. Status: confirmed.";
  assert.equal(t6With(spaced).verdict, "PASS");
  assert.equal(t6With(undefined, { savedWording: `${SAVED}.` }).verdict, "PASS");
  assert.equal(t6Struct({ items: [{ text: SAVED, status: "confirmed" }] }).verdict, "PASS");
  assert.equal(t6With(`${SAVED.toUpperCase()}. Status: confirmed.`).verdict, "PASS");
  assert.equal(t6With("the plugin ships recall only, capture needs my approval!! status: confirmed").verdict, "PASS");
});

test("D8. no match on a fragment or another wording, in text or structure: only the whole saved wording counts", () => {
  for (const wrong of ["recall only. Status: confirmed.", "The plugin ships recall only. Status: confirmed.", "The plugin ships recall only; capture needs approval. Status: confirmed.", "The plugin ships recall; capture needs my approval. Status: confirmed."]) {
    const v = t6With(wrong);
    assert.equal(v.verdict, "FAIL", wrong);
    assert.match(v.notes.join(" "), /holds T4's saved wording/);
  }
  assert.equal(t6Struct({ items: [{ text: "recall only", status: "confirmed" }] }).verdict, "FAIL");
  assert.equal(t6With(undefined, { savedWording: "...;" }).verdict, "FAIL"); // nothing left to compare
});

test("D3. T6 FAILs on a negative status on the wording's record, in text and in structure", () => {
  for (const status of ["pending", "Pending review", "unconfirmed", "not confirmed", "not yet confirmed", "rejected", "not your contribution", "Saved for your review"]) {
    const v = t6With(`Judgment: ${SAVED}. Status: ${status}.`);
    assert.equal(v.verdict, "FAIL", status);
    assert.match(v.notes.join(" "), /reads as not confirmed/, status);
    assert.equal(t6Struct({ items: [{ text: SAVED, status }] }).verdict, "FAIL", status);
  }
  assert.equal(t6Struct({ items: [{ text: SAVED, confirmed: false }] }).verdict, "FAIL");
  assert.equal(t6Struct({ items: [{ text: SAVED, is_confirmed: false }] }).verdict, "FAIL");
  assert.equal(t6With(`Status: pending. Status: confirmed. ${SAVED}`).verdict, "FAIL"); // negative wins
});

test("D3. T6 can PASS on a positive marker on that record: confirmed, kept as your own, status kept", () => {
  for (const marker of ["Status: confirmed", "CONFIRMED", "Kept as your own", "status: kept"]) assert.equal(t6With(`${SAVED}. ${marker}.`).verdict, "PASS", marker);
  assert.equal(t6Struct({ items: [{ text: SAVED, status: "kept" }] }).verdict, "PASS");
  assert.equal(t6Struct({ items: [{ text: SAVED, confirmed: true, pending: false }] }).verdict, "PASS");
  assert.equal(t6Struct({ judgment: { text: SAVED }, status: "confirmed" }).verdict, "PASS"); // no list: the whole result is the item
  const v = t6With(`${SAVED}. Status: confirmed.`);
  assert.ok(v.notes.includes(T6_STATUS_NOTE));
  assert.match(T6_STATUS_NOTE, /heuristic/);
});

test("D3. no status either way is UNCONFIRMED, with its note: not a pass and not a failure", () => {
  for (const v of [t6With(`Judgment: ${SAVED}.`), t6Struct({ items: [{ text: SAVED, id: "j" }] }), t6Struct({ items: [{ text: SAVED, needs_confirmation: true }] })]) {
    assert.equal(v.verdict, "UNCONFIRMED");
    assert.match(v.notes.join(" "), /first real T6 shows the wording/);
  }
  assert.equal(t6With(`Judgment: ${SAVED}.`, { routingBlocked: "off", ...saved }, "no project").verdict, "UNCONFIRMED"); // status first
  assert.equal(t6With(`Judgment: ${SAVED}.`, saved, "no project").verdict, "FAIL"); // a real failure outranks it
});

test("D3. the same record: another item's status does not count; plain text is read within the window, and the wording's own words are no status", () => {
  assert.equal(t6Struct({ items: [{ text: SAVED }, { text: "other", status: "confirmed" }] }).verdict, "UNCONFIRMED");
  assert.equal(t6Struct({ items: [{ text: SAVED, status: "confirmed" }, { text: "other", status: "pending" }] }).verdict, "PASS");
  assert.equal(t6Struct({ items: [{ text: SAVED, status: "pending" }, { text: "other", status: "confirmed" }] }).verdict, "FAIL");
  assert.equal(t6Struct(undefined, JSON.stringify({ items: [{ text: SAVED, status: "confirmed" }, { text: "x", status: "pending" }] })).verdict, "PASS"); // JSON in the text block
  assert.equal(t6Struct(undefined, JSON.stringify([{ type: "text", text: JSON.stringify({ text: SAVED, status: "pending" }) }])).verdict, "FAIL"); // JSON inside JSON
  assert.equal(t6With(`${SAVED}. ${"x".repeat(STATUS_WINDOW_CHARS + 20)} Status: confirmed.`).verdict, "UNCONFIRMED");
  assert.equal(t6With(`Status: pending. ${"x".repeat(STATUS_WINDOW_CHARS + 20)} ${SAVED}.`).verdict, "UNCONFIRMED");
  assert.equal(t6With(`${"y".repeat(STATUS_WINDOW_CHARS - 40)} Status: confirmed. ${SAVED}.`).verdict, "PASS");
  const own = "Rejected the hook; this stays pending until confirmed";
  assert.equal(t6With(`${own}.`, { savedWording: own }).verdict, "UNCONFIRMED");
  assert.equal(t6Struct({ items: [{ text: `A long body. ${SAVED}. Status: pending. ${"z".repeat(300)} Status: confirmed.` }] }).verdict, "FAIL"); // one string, read by window
});

test("T6 negations. plain text cases read as negative, so FAIL: once, until, never, isn't, confirmed: no, confirmed: 0", () => {
  for (const text of ["Will be kept once confirmed", "Saved until confirmed", "It was never confirmed", "This isn't confirmed", "confirmed: no", "confirmed: 0"]) {
    const v = t6With(`${SAVED}. ${text}.`);
    assert.equal(v.verdict, "FAIL", text);
    assert.match(v.notes.join(" "), /reads as not confirmed/, text);
    assert.equal(t6With(`${text}. ${SAVED}.`).verdict, "FAIL", `${text}, before the wording`);
  }
});

test("T6 negations. the other qualifiers and values, a few words back, in any case, and a curly apostrophe", () => {
  for (const text of ["not confirmed", "unless confirmed", "before it was confirmed", "awaiting confirmed status", "pending confirmed", "isn’t confirmed", "hasn't yet been confirmed", "NEVER Confirmed",
    "not kept as your own", "never kept as your own", "status: not kept", "confirmed: false", "confirmed: null", "confirmed = no", "kept as your own: no", "status: kept: false"]) {
    assert.equal(t6With(`${SAVED}. ${text}.`).verdict, "FAIL", text);
  }
});

test("T6 negations. in JSON, as structure or inside a text block: confirmed 0, no, false, null, confirmed_at null", () => {
  for (const value of [0, "no", false, null]) {
    assert.equal(t6Struct({ items: [{ text: SAVED, confirmed: value }] }).verdict, "FAIL", String(value));
    assert.equal(t6Struct(undefined, JSON.stringify({ items: [{ text: SAVED, confirmed: value }] })).verdict, "FAIL", String(value));
    assert.equal(t6Struct({ text: SAVED, is_confirmed: value }).verdict, "FAIL", String(value));
  }
  assert.equal(t6Struct({ items: [{ text: SAVED, confirmed_at: null }] }).verdict, "FAIL");
  assert.equal(t6With(`{"text":"${SAVED}","confirmed":0`).verdict, "FAIL"); // not parseable: read as plain text
});

test("T6 negations. what stays positive: a value in another clause, another field's null or zero, and a marker with no qualifier in its clause", () => {
  for (const text of ["Status: confirmed. No further action.", "Confirmed. 0 items withheld.", "Status: confirmed, no edits.", "Not related. Status: confirmed.", "Confirmed by the user."]) {
    assert.equal(t6With(`${SAVED}. ${text}`).verdict, "PASS", text);
  }
  assert.equal(t6Struct({ items: [{ text: SAVED, confirmed: true, rejected_at: null, pending: 0, unconfirmed: null, rejected: false }] }).verdict, "PASS");
  assert.equal(t6Struct({ items: [{ text: SAVED, confirmed: 1 }] }).verdict, "PASS");
  assert.equal(t6Struct({ items: [{ text: SAVED, rejected_at: null }] }).verdict, "UNCONFIRMED");
  assert.match(T6_STATUS_NOTE, /read the evidence/);
});

test("T6 structure. a status field on the record holding the wording decides: each key, confirmed values pass, negatives FAIL, others read UNCONFIRMED", () => {
  for (const f of [{ status: "confirmed" }, { state: "confirmed" }, { confirmed: true }, { confirmed: 1 }, { is_confirmed: true }, { isConfirmed: true }, { review_status: "Confirmed" }, { status: "kept" }, { state: "kept" }, { status: "kept as your own" }]) {
    assert.equal(t6Struct({ items: [{ text: SAVED, ...f }] }).verdict, "PASS", JSON.stringify(f));
  }
  for (const f of [{ status: "pending" }, { state: "rejected" }, { confirmed: false }, { confirmed: 0 }, { confirmed: null }, { isConfirmed: false }, { status: "not confirmed" }, { status: "never confirmed" }, { status: "confirmed", confirmed: false }, { confirmed: true, pending: true }]) {
    assert.equal(t6Struct({ items: [{ text: SAVED, ...f }] }).verdict, "FAIL", JSON.stringify(f));
  }
  for (const f of [{ status: "active" }, { state: "success" }, { status: null }, { status: "" }, { confirmation: "required" }]) {
    assert.equal(t6Struct({ items: [{ text: SAVED, ...f }] }).verdict, "UNCONFIRMED", JSON.stringify(f));
  }
});

test("T6 structure. the field outranks text: its record's own string, another field's words, and a text block's window all give way, both ways round", () => {
  assert.equal(t6Struct({ items: [{ text: `${SAVED}. Status: pending.`, status: "confirmed" }] }).verdict, "PASS");
  assert.equal(t6Struct({ items: [{ text: `${SAVED}. Status: confirmed.`, status: "pending" }] }).verdict, "FAIL");
  assert.equal(t6Struct({ items: [{ text: `${SAVED}. Status: confirmed.`, status: "active" }] }).verdict, "UNCONFIRMED");
  assert.equal(t6Struct({ items: [{ text: SAVED, status: "confirmed", note: "was pending before" }] }).verdict, "PASS");
  assert.equal(t6Struct({ items: [{ text: SAVED, status: "active", note: "this is confirmed" }] }).verdict, "UNCONFIRMED");
  assert.equal(t6Struct({ items: [{ text: SAVED, status: "confirmed" }] }, `${SAVED}. Status: pending.`).verdict, "PASS");
  assert.equal(t6Struct({ items: [{ text: SAVED, status: "pending" }] }, `${SAVED}. Status: confirmed.`).verdict, "FAIL");
});

test("T6 structure. only that object counts: a sibling's or another item's status does not, and neither does a list's envelope; known false results", () => {
  assert.equal(t6Struct({ a: { text: SAVED }, b: { status: "confirmed" } }).verdict, "UNCONFIRMED"); // no list, status on a sibling
  assert.equal(t6Struct({ a: { text: SAVED, status: "confirmed" }, b: { status: "rejected" } }).verdict, "PASS"); // own confirmed, sibling rejected, no list
  assert.equal(t6Struct({ a: { text: SAVED, status: "pending" }, b: { status: "confirmed" } }).verdict, "FAIL");
  assert.equal(t6Struct({ status: "pending", items: [{ text: SAVED, status: "confirmed" }] }).verdict, "PASS"); // the record's own field, not its parent's
  assert.equal(t6Struct({ status: "confirmed", items: [{ text: SAVED }] }).verdict, "UNCONFIRMED"); // the envelope's, across a list
  assert.equal(t6Struct({ status: "confirmed", items: [SAVED] }).verdict, "UNCONFIRMED");
  assert.equal(t6Struct({ judgment: { body: { text: SAVED } }, status: "pending" }).verdict, "FAIL"); // the nearest object above with one
  assert.equal(t6Struct({ items: [{ text: "other", status: "confirmed" }, { text: SAVED, status: "pending" }] }).verdict, "FAIL");
  assert.equal(t6Struct({ items: [{ text: SAVED, status: "confirmed" }, { text: SAVED, status: "pending" }] }).verdict, "FAIL"); // two records hold it: negative wins
});

test("T6 structure. the wording still identifies the record, and with no status field or no structure the window applies", () => {
  const v = t6Struct({ items: [{ text: "recall only", status: "confirmed" }] });
  assert.equal(v.verdict, "FAIL");
  assert.match(v.notes.join(" "), /holds T4's saved wording/);
  assert.equal(t6Struct({ items: [{ text: `${SAVED}. Status: confirmed.` }] }).verdict, "PASS"); // structure, but no status field
  assert.equal(t6Struct({ items: [`${SAVED}. Status: pending.`] }).verdict, "FAIL");
  assert.equal(t6With(`${SAVED}. Status: confirmed.`).verdict, "PASS"); // no structure at all
});

test("T6 wording. hyphens and all dashes read as spaces, in the read or in T4's saved wording; a fragment still fails", () => {
  for (const dash of ["-", "‐", "‑", "‒", "–", "—", "―", "−"]) {
    assert.equal(t6With(`The plugin ships recall${dash}only; capture needs my approval. Status: confirmed.`).verdict, "PASS", `read ${dash}`);
    assert.equal(t6With(`The plugin ships recall only${dash}capture needs my approval. Status: confirmed.`).verdict, "PASS", `unspaced ${dash}`);
    assert.equal(t6With(`The plugin ships recall only ${dash} capture needs my approval. Status: confirmed.`).verdict, "PASS", `spaced ${dash}`);
    assert.equal(t6With(undefined, { savedWording: `The plugin ships recall${dash}only; capture needs my approval` }).verdict, "PASS", `saved ${dash}`);
  }
  assert.equal(t6With("The plugin ships recall-only. Status: confirmed.").verdict, "FAIL");
  assert.equal(t6With(`${SAVED}. Status: pending.`.replace("recall only", "recall-only")).verdict, "FAIL"); // the window still finds the status
});

test("D3. the ledger record alone never passes, and a positive marker in another tool's result does not count", () => {
  assert.equal(verdictT6([rec(init(), toolUse("r", READ), toolResult("r", "FIT: no_match"), toolUse("s", "Skill"), toolResult("s", `${SAVED}. Status: confirmed.`), ok("From quadron-connect."))], { judgmentId: "j", ...saved }).verdict, "FAIL");
  assert.equal(verdictT6([rec(init(), toolUse("r", READ), toolResult("r", SAVED), toolUse("s", "Skill"), toolResult("s", "confirmed"), ok("quadron-connect"))], saved).verdict, "UNCONFIRMED");
});

test("D5. WITHHELD counts only in a read tool's result, and a read holding the wording is judged on its record with the count noted", () => {
  const skill = (text) => [toolUse("s", "Skill"), toolResult("s", text)];
  assert.equal(verdictT6([rec(init(), ...skill("WITHHELD (IP firewall): 3"), ...read(), ok("quadron-connect"))], saved).verdict, "PASS");
  assert.equal(verdictT6([rec(init(), ...skill("WITHHELD means a thing"), ...read("FIT: no_match"), ok("quadron-connect"))], saved).verdict, "FAIL");
  assert.equal(verdictT6([rec(init(), toolUse("o", "Read"), toolResult("o", "WITHHELD"), ...read("FIT: no_match"), ok("quadron-connect"))], saved).verdict, "FAIL");
  assert.equal(t6With("WITHHELD (IP firewall): nothing").verdict, "FAIL"); // no wording and nothing withheld
  const pass = t6With(`${SAVED}. Status: confirmed. WITHHELD (IP firewall): 2 items`);
  assert.equal(pass.verdict, "PASS");
  assert.match(pass.notes.join(" "), /withheld items: 2/);
  assert.match(t6With(`${SAVED}. Status: confirmed. IP firewall: (3 withheld)`).notes.join(" "), /withheld items: 3/);
  assert.match(t6With(`${SAVED}. Status: confirmed. WITHHELD`).notes.join(" "), /withheld items: not shown/);
  assert.equal(t6With(`${SAVED}. Status: pending. WITHHELD (IP firewall): 2 items`).verdict, "FAIL");
  assert.equal(t6With(`${SAVED}. WITHHELD (IP firewall): 2 items`).verdict, "UNCONFIRMED");
  const twoReads = [toolUse("a", "mcp__quadron__quad_search"), toolResult("a", "WITHHELD (IP firewall): 1"), toolUse("b", "mcp__quadron__quad_read"), toolResult("b", `${SAVED}. Status: confirmed.`), ok("quadron-connect")];
  const across = verdictT6([rec(init(), ...twoReads)], saved);
  assert.equal(across.verdict, "PASS");
  assert.match(across.notes.join(" "), /withheld items: 1/);
});
test("H3. the saved wording comes from the capture call's input and must hold the stated decision's phrase", () => {
  assert.equal(savedWordingFrom({ quad_name: "quadron-connect", capture_type: "decision", origin: "self", ruled_out: "recall only from a hook", decided: " ships recall only " }), "ships recall only");
  assert.equal(savedWordingFrom({ quad_name: "x", other_field: "it ships recall only" }), "it ships recall only");
  assert.equal(savedWordingFrom({ quad_name: "recall only" }), "not shown");
  assert.equal(savedWordingFrom({ decided: "something else" }), "not shown");
  assert.equal(savedWordingFrom(undefined), "not shown");
  const t4 = verdictT4([turn1(), rec(init(), toolUse("u1", CAPTURE, { quad_name: "quadron-connect", decided: SAVED }), toolResult("u1", "ok"), ok("Saved."))]);
  assert.equal(t4.savedWording, SAVED);
  assert.equal(verdictT4([turn1(), turn2()]).savedWording, "not shown");
});
test("F19. T6 WITHHELD outranks the citation; a capture attempt outranks WITHHELD; 'withheld nothing' is not WITHHELD", () => {
  assert.equal(verdictT6([rec(init(), ...read("WITHHELD (IP firewall): 1 item"), ok("quadron-connect"))], saved).verdict, "WITHHELD");
  assert.equal(verdictT6([rec(init(), ...read("IP firewall: (2 withheld)"), ok("quadron-connect"))], saved).verdict, "WITHHELD");
  assert.equal(verdictT6([rec(init(), ...read(`${SAVED}. Status: confirmed. WITHHELD (IP firewall): nothing`), ok("quadron-connect"))], saved).verdict, "PASS");
  assert.equal(verdictT6([rec(init(), ...read("WITHHELD (IP firewall): nothing"), ok("quadron-connect"))], saved).verdict, "FAIL");
  assert.equal(verdictT6([rec(init(), ...read("WITHHELD (IP firewall): 1"), toolUse("c", CAPTURE, {}), ok("x"))], saved).verdict, "FAIL");
});
test("F19. T6 --routing-blocked: a missing citation is BLOCKED-BY-BACKEND with the reason; other failures still FAIL; a citation is still PASS", () => {
  const opt = { routingBlocked: "off on the server", ...saved };
  const v = verdictT6([rec(init(), ...read(), ok("no project"))], opt);
  assert.equal(v.verdict, "BLOCKED-BY-BACKEND");
  assert.deepEqual(v.citesProject, { state: "BLOCKED-BY-BACKEND", reason: "off on the server" });
  const noRead = verdictT6([rec(init(), ok("no project"))], opt);
  assert.equal(noRead.verdict, "FAIL");
  assert.deepEqual(noRead.citesProject.state, "BLOCKED-BY-BACKEND");
  assert.ok(!noRead.notes.some((n) => /does not cite/.test(n)));
  assert.equal(verdictT6([rec(init(), ...read(), ok("quadron-connect"))], opt).verdict, "PASS");
  assert.equal(verdictT6([rec(init(), ...read("FIT: no_match"), ok("no project"))], opt).verdict, "FAIL"); // blocked never excuses the wording
});

// ---- ISSUE2
test("F20. ISSUE2 PASS: offer text with the note's phrase, in the assistant text, and no capture", () => {
  assert.equal(verdictIssue2([rec(init(), ...said("Keep that the runner keeps raw streams?"))]).verdict, "PASS");
  assert.equal(verdictIssue2([rec(init(), assistantText("It keeps RAW STREAMS, keep it?"), ok("ok"))]).verdict, "PASS");
});
test("F20. ISSUE2 FAIL: no phrase, naming only the project, a capture attempt, the turn cap, an error result", () => {
  for (const [s, re] of [
    [rec(init(), ok("Want this in quadron-connect?")), /note's phrase/],
    [rec(init(), toolUse("c", CAPTURE, {}), ok("keeps raw streams")), /capture tool/],
    [denied(rec(init(), ok("keeps raw streams"))), /capture tool/],
    [rec(init(), result(0.1, { subtype: "error_max_turns", result: "keeps raw streams" })), /turn cap/],
    [rec(init(), result(0.1, { subtype: "error_during_execution", result: "keeps raw streams" })), /error_during_execution/],
  ]) {
    const v = verdictIssue2([s]);
    assert.equal(v.verdict, "FAIL", String(re));
    assert.match(v.notes.join(" "), re);
  }
});

// ---- quad_context
test("F27. quad_context at most once per session: more is a recorded note and FAIL on T4, T5, T6 and ISSUE2", () => {
  const twice = () => [toolUse("a", READ), toolResult("a", "x"), toolUse("b", READ), toolResult("b", "x")];
  const cases = {
    ISSUE2: verdictIssue2([rec(init(), ...twice(), ok("keeps raw streams"))]),
    T6: verdictT6([rec(init(), ...twice(), ok("quadron-connect"))]),
    T5: verdictT5([rec(init(), ...twice(), ok("x")), t5b()]),
    T5across: verdictT5([rec(init(), toolUse("a", READ), toolResult("a", "x"), ok("x")), rec(init(), toolUse("b", READ), toolResult("b", "x"), ok("y"))]),
    T4: verdictT4([rec(init(), ...twice(), ok(OFFER)), turn2()]),
    T4across: verdictT4([rec(init(), toolUse("a", READ), toolResult("a", "x"), ok(OFFER)), turn2([toolUse("b", READ), toolResult("b", "x")])]),
  };
  for (const [k, v] of Object.entries(cases)) {
    assert.equal(v.verdict, "FAIL", k);
    assert.match(v.notes.join(" "), /quad_context called 2 times/, k);
  }
  assert.equal(verdictIssue2([rec(init(), toolUse("a", READ), toolResult("a", "x"), ...said("Keep this: it keeps raw streams?"))]).verdict, "PASS");
  assert.equal(verdictT2([rec(init({ mcp_servers: [] }), SKILL(), toolUse("a", READ), ok("x"))]).verdict, "FAIL"); // T2 is zero
});

test("F6. turnGate lets T5 through on any success, and T4 only with the phrase and no capture", () => {
  assert.equal(turnGate("T5", rec(init(), ok("x"))), null);
  assert.equal(turnGate("T4", rec(init(), ...said(OFFER))), null);
  assert.match(turnGate("T4", rec(init(), ...said("quadron-connect"))), /recall only/);
  assert.match(turnGate("T5", rec(init())), /no success result/);
});

test("D4. T4: an echo plus any question fails; a question with a keeping verb the prompt does not use passes, whichever sentence holds the phrase", () => {
  const passes = (text) => turnGate("T4", rec(init(), ...said(text))) === null;
  assert.equal(passes("Decision noted: the Claude Code plugin ships recall only in quadron-connect; capture happens through the tool. Anything else?"), false);
  assert.equal(passes("Want me to keep it in your quadron-connect record as: \"The plugin ships recall only; capture needs my approval\"?"), true);
  assert.equal(passes("Want me to keep it in quadron-connect as: \"The plugin ships recall only. Capture needs my approval.\"?"), true); // a quote stays one sentence
  assert.equal(passes("The plugin ships recall only.\n\nShould I save that to quadron-connect?"), true); // the next sentence
  assert.equal(passes("Shall I record this in quadron-connect? It ships recall only."), true);
  for (const fail of [
    "Want me to capture that the plugin ships recall only in quadron-connect?", // the prompt's own word no longer counts
    "The plugin ships recall only. Then more. Want to keep going in quadron-connect?", // two sentences away
    "I can keep this in quadron-connect: the plugin ships recall only.", // no question
    "Does the plugin ship recall only in quadron-connect?", // no keeping verb
    "It keeps recall only in quadron-connect as a rule?", // "keeps" is not "keep"
  ]) assert.match(turnGate("T4", rec(init(), ...said(fail))), /made no offer/, fail);
});

test("D4. ISSUE2 shares the check: its prompt's own \"Note\" does not count", () => {
  assert.equal(verdictIssue2([rec(init(), ...said("Shall I note that the runner keeps raw streams?"))]).verdict, "FAIL");
  assert.equal(verdictIssue2([rec(init(), ...said("Shall I save that the runner keeps raw streams?"))]).verdict, "PASS");
  assert.equal(verdictIssue2([rec(init(), ...said("The runner keeps raw streams. Anything else?"))]).verdict, "FAIL");
});

test("offer text. the check reads the turn's assistant text alone: a result repeating it gives a question no second copy of the phrase to sit next to", () => {
  const far = "The plugin ships recall only. Understood. That is sensible. Want me to keep it?";
  assert.match(turnGate("T4", rec(init(), ...said(far))), /made no offer/); // joined, the question sat next to the repeat
  assert.equal(verdictT4([rec(init(), ...said(far)), turn2()]).verdict, "FAIL");
  const issue = "The runner keeps raw streams. Understood. That is sensible. Want me to save it?";
  const v = verdictIssue2([rec(init(), ...said(issue))]);
  assert.equal(v.verdict, "FAIL");
  assert.match(v.notes.join(" "), /note's phrase/);
  assert.match(turnGate("T4", rec(init(), ok(OFFER))), /made no offer/); // a result alone is no offer
  assert.equal(verdictIssue2([rec(init(), ok("Shall I save that the runner keeps raw streams?"))]).verdict, "FAIL");
  assert.equal(turnGate("T4", rec(init(), assistantText(OFFER), ok("A different closing line."))), null);
});

test("G8. an offer is more than an echo of the phrase: it needs a question with a keeping verb; stated as a heuristic in the notes", () => {
  for (const echo of ["The runner keeps raw streams.", "Raw streams: noted.", "Do you use raw streams?", "I can read raw streams.", "I can save this: raw streams for every row."]) {
    assert.equal(isOffer(echo, "raw streams"), false, echo);
    const v = verdictIssue2([rec(init(), ok(echo))]);
    assert.equal(v.verdict, "FAIL", echo);
  }
  assert.equal(isOffer("Want me to keep that the runner keeps raw streams?", "raw streams"), true);
  assert.match(turnGate("T4", rec(init(), ...said("Noted: the plugin ships recall only."))), /made no offer/);
  assert.equal(turnGate("T4", rec(init(), ...said(OFFER))), null);
  const pass = verdictIssue2([rec(init(), ...said("Keep this: raw streams?"))]);
  assert.equal(pass.verdict, "PASS");
  assert.ok(pass.notes.includes(OFFER_HEURISTIC_NOTE));
  assert.ok(verdictT4([turn1(), turn2()]).notes.includes(OFFER_HEURISTIC_NOTE));
});

test("H1. collect measures the largest prompt from usage, and sees a response cut off at the limit", () => {
  const assistant = (usage, stop_reason = null) => ({ type: "assistant", message: { content: [], usage, stop_reason } });
  const s = rec(assistant({ input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 }), assistant({ input_tokens: 5 }),
    result(0.1, { usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } }));
  assert.equal(s.prompt_tokens, 60);
  assert.equal(rec(result(0.1, { usage: { input_tokens: 100, cache_read_input_tokens: 50 } })).prompt_tokens, 150);
  assert.equal(rec(result(0.1)).prompt_tokens, 0);
  assert.equal(s.cut_off, false);
  assert.equal(rec(assistant(undefined, "max_tokens")).cut_off, true);
  assert.equal(rec(result(0.1, { stop_reason: "max_tokens" })).cut_off, true);
});

test("G7. a judgment id outside the shared pattern is treated as not shown", () => {
  assert.equal(judgmentIdFrom({ text: JSON.stringify({ judgment_id: "has space" }) }), "not shown");
  assert.equal(judgmentIdFrom({ text: JSON.stringify({ judgment_id: "a".repeat(65) }) }), "not shown");
  assert.equal(judgmentIdFrom({ text: JSON.stringify({ judgment_id: "a".repeat(64) }) }), "a".repeat(64));
  assert.equal(judgmentIdFrom({ text: JSON.stringify({ id: "0f8c1e2a-1b2c-4d5e-8f90-1234567890ab" }) }), "0f8c1e2a-1b2c-4d5e-8f90-1234567890ab");
});

test("collect keeps a tool result whole, far past any preview length", () => {
  const long = "x".repeat(5000);
  assert.equal(rec(toolUse("a", READ), toolResult("a", long)).tool_results[0].text.length, 5000);
});

// ---- a capture reply that reports a failed write
const QUAD_COMMIT = "mcp__quadron__quad_commit";
const CAPTURE_TOOLS = [CAPTURE, QUAD_COMMIT];
const PHRASE = "may or may not be in the record";
const initFor = (name) => init({ tools: ["Skill", name] });
const offerFor = (name) => rec(initFor(name), ...said(OFFER));
const replyFor = (name, text, { isError = false, structured } = {}) =>
  rec(initFor(name), toolUse("u1", name, { quad_name: "quadron-connect", decided: SAVED }), toolResult("u1", text, isError, structured), ok("Saved."));
const t4For = (name, text, opts) => verdictT4([offerFor(name), replyFor(name, text, opts)]);
const FAILED_REPLIES = [
  ["a JSON text", JSON.stringify({ ok: false, error: "not written" }), undefined],
  ["a spaced JSON text", '{ "ok": false, "error": "not written" }', undefined],
  ["a structured result", "see data", { ok: false }],
  ["a structured result as JSON text", "see data", JSON.stringify({ ok: false })],
];

test("T4 fails on a reply reporting a failed write with is_error false, for both capture tools, in structured and text forms", () => {
  for (const name of CAPTURE_TOOLS) {
    for (const [form, text, structured] of FAILED_REPLIES) {
      const v = t4For(name, text, { structured });
      assert.equal(v.verdict, "FAIL", `${name} ${form}`);
      assert.match(v.notes.join(" "), /accepted: 0/, `${name} ${form}`);
      assert.match(v.notes.join(" "), /reports a failed write \(ok:false/, `${name} ${form}`);
      assert.equal(v.captureTool, name);
    }
  }
});
const UNCONFIRMED_REPLY = "Could not confirm that was kept — it may or may not be in the record. Do not capture it again automatically; ask the person to check Memory first, because a second attempt would append rather than replace.";
const assertFailedWrite = (v, why) => {
  assert.equal(v.verdict, "FAIL", why);
  assert.match(v.notes.join(" "), /accepted: 0/, why);
  assert.match(v.notes.join(" "), /reports a failed write/, why);
  assert.equal(v.savedWording, "not shown", why);
};
test("T4 fails on the server's could-not-confirm reply with is_error true, for both capture tools", () => {
  for (const name of CAPTURE_TOOLS) assertFailedWrite(t4For(name, UNCONFIRMED_REPLY, { isError: true }), name);
});
test("T4 fails on the server's could-not-confirm reply with is_error false, for both capture tools", () => {
  for (const name of CAPTURE_TOOLS) assertFailedWrite(t4For(name, UNCONFIRMED_REPLY), name);
});
test("T4 passes on a success reply that only mentions ok false below the top level or in prose, for both capture tools", () => {
  const texts = (...blocks) => blocks.map((text) => ({ type: "text", text }));
  const successes = [
    ["pretty-printed JSON and a second block", texts(JSON.stringify({ ok: true, checks: [{ ok: false }] }, null, 2), "Done.")],
    ["a prose line", "Saved for your review.\nok: false positives were dropped"],
    ["indented nested ok in non-JSON text", 'Saved for your review.\nChecks:\n  "ok": false\nDone.'],
  ];
  for (const name of CAPTURE_TOOLS) {
    for (const [form, content] of successes) {
      const v = t4For(name, content);
      assert.equal(v.verdict, "PASS", `${name} ${form}`);
      assert.equal(v.savedWording, SAVED, `${name} ${form}`);
    }
  }
});
test("T4 fails on a reply holding the phrase that the write may not have landed, in any case and whatever its ok says, for both capture tools", () => {
  for (const name of CAPTURE_TOOLS) {
    for (const text of [`The capture ${PHRASE}.`, `THE CAPTURE ${PHRASE.toUpperCase()}.`, JSON.stringify({ ok: true, note: `It ${PHRASE}` }), JSON.stringify({ ok: false, message: `It ${PHRASE}` })]) {
      const v = t4For(name, text);
      assert.equal(v.verdict, "FAIL", `${name} ${text}`);
      assert.match(v.notes.join(" "), /accepted: 0/, `${name} ${text}`);
      assert.match(v.notes.join(" "), /reports a failed write/, `${name} ${text}`);
    }
  }
});
test("T4 still fails on an error reply, for both capture tools, with or without ok:false", () => {
  for (const name of CAPTURE_TOOLS) {
    for (const text of ["failed", JSON.stringify({ ok: false })]) {
      const v = t4For(name, text, { isError: true });
      assert.equal(v.verdict, "FAIL", `${name} ${text}`);
      assert.match(v.notes.join(" "), /accepted: 0/, `${name} ${text}`);
    }
  }
});
test("T4 still passes on a normal success and on an ok:true reply, for both capture tools", () => {
  for (const name of CAPTURE_TOOLS) {
    for (const [text, structured] of [["Saved for your review", undefined], ["ok", undefined], [JSON.stringify({ ok: true }), undefined], ["see data", { ok: true }], ["ok:true", undefined]]) {
      const v = t4For(name, text, { structured });
      assert.equal(v.verdict, "PASS", `${name} ${text}`);
      assert.equal(v.savedWording, SAVED, `${name} ${text}`);
    }
  }
});
test("T4 names no saved value from a failed write, an error reply or a denied call, for both capture tools", () => {
  const reply = { judgment_id: "j1", signed_claim: "abc", quad: "quadron-connect" };
  const none = (v, why) => {
    assert.equal(v.verdict, "FAIL", why);
    assert.equal(v.judgmentId, "not shown", why);
    assert.equal(v.savedWording, "not shown", why);
    assert.equal(v.routing, "not shown", why);
    assert.deepEqual(v.signedClaim, { state: "absent" }, why);
    assert.match(v.notes.join(" "), /judgment id: not shown/, why);
    assert.doesNotMatch(v.notes.join(" "), /pending review/, why);
  };
  for (const name of CAPTURE_TOOLS) {
    none(t4For(name, JSON.stringify({ ok: false, ...reply })), `${name} text`);
    none(t4For(name, "Saved for your review", { structured: { ok: false, ...reply } }), `${name} structured`);
    none(t4For(name, `judgment id: j1. Saved for your review, but it ${PHRASE}. quadron-connect`), `${name} phrase`);
    none(t4For(name, JSON.stringify(reply), { isError: true }), `${name} error`);
    const refused = replyFor(name, JSON.stringify(reply));
    refused.denied_ids.add("u1");
    none(verdictT4([offerFor(name), refused]), `${name} denied`);
    const kept = t4For(name, JSON.stringify({ ok: true, ...reply }));
    assert.equal(kept.verdict, "PASS", name);
    assert.equal(kept.judgmentId, "j1", name);
    assert.equal(kept.savedWording, SAVED, name);
    assert.equal(kept.routing, "routed", name);
    assert.deepEqual(kept.signedClaim, { state: "present", field: "signed_claim" }, name);
  }
});
test("a capture attempt alone still fails its row when the reply reports a failed write", () => {
  const FAILED = JSON.stringify({ ok: false, message: `It ${PHRASE}` });
  for (const name of CAPTURE_TOOLS) {
    const tried = (...more) => rec(init(), ...more, toolUse("c", name, {}), toolResult("c", FAILED), ok(OFFER));
    const t2 = verdictT2([rec(init({ mcp_servers: [] }), SKILL(), toolUse("c", name, {}), toolResult("c", FAILED), ok("x"))]);
    assert.equal(t2.verdict, "FAIL", name);
    assert.match(t2.notes.join(" "), /Quadron tool/, name);
    assert.match(turnGate("T4", rec(init(), toolUse("c", name, {}), toolResult("c", FAILED), ...said(OFFER))), /captured before confirmation/, name);
    const early = verdictT4([rec(init(), toolUse("c", name, {}), toolResult("c", FAILED), ...said(OFFER)), turn2()]);
    assert.equal(early.verdict, "FAIL", name);
    assert.match(early.notes.join(" "), /captured before confirmation/, name);
    for (const [v, which] of [[verdictT5([tried(), t5b()]), "turn 1"], [verdictT5([t5a(), tried()]), "turn 2"]]) {
      assert.equal(v.verdict, "FAIL", `${name} ${which}`);
      assert.match(v.notes.join(" "), new RegExp(`${which} called a capture tool`), name);
    }
    const t6 = verdictT6([tried(...read())], saved);
    assert.equal(t6.verdict, "FAIL", name);
    assert.match(t6.notes.join(" "), /a capture tool was called/, name);
    const issue = verdictIssue2([rec(init(), toolUse("c", name, {}), toolResult("c", FAILED), ...said("Keep this: raw streams?"))]);
    assert.equal(issue.verdict, "FAIL", name);
    assert.match(issue.notes.join(" "), /a capture tool was called/, name);
  }
  const other = verdictT4([turn1(), rec(init(), toolUse("u1", CAPTURE, { quad_name: "quadron-connect" }), toolResult("u1", "Saved"), toolUse("u2", QUAD_COMMIT, {}), toolResult("u2", FAILED), ok("Saved."))]);
  assert.equal(other.verdict, "FAIL");
  assert.match(other.notes.join(" "), /another capture tool/);
});
test("a failed write is read at the reply's top level, and prose that only mentions ok is not one", () => {
  const notFailed = [
    { text: "ok" }, { text: "Saved, ok." }, { text: "It looks ok, false alarm." }, { text: "okay: false" }, { text: "not_ok: false" },
    { text: "The check says ok: false in the middle of a sentence." }, { text: "ok: falsehood" }, { text: "" }, {},
    { text: JSON.stringify({ ok: true }) }, { text: JSON.stringify({ ok: "false" }) }, { text: JSON.stringify({ ok: 0 }) }, { text: JSON.stringify({ ok: null }) },
    { text: JSON.stringify({ ok: true, checks: [{ ok: false }] }) }, { text: JSON.stringify({ result: { ok: false } }) }, { text: JSON.stringify([{ ok: false }]) },
    { text: `${JSON.stringify({ ok: true, checks: [{ ok: false }] })}\nDone.` },
    { text: "ok:false" }, { text: "ok: false" }, { text: "OK = False" }, { text: '"ok": false' }, { text: "'ok': false" }, { text: '{"ok": false, not json' }, { text: "Not written.\nok: false" },
    { text: '"ok": false, not written' }, { text: `${JSON.stringify({ error: "not written", ok: false })}\nTry again later.` },
    { text: "x", structured: { ok: true } }, { text: "x", structured: { result: { ok: false } } }, { text: "x", structured: [{ ok: false }] }, { text: "x", structured: "ok:false" },
  ];
  for (const r of notFailed) assert.equal(reportsFailedWrite(r), false, JSON.stringify(r));
  const failed = [
    { text: `  ${JSON.stringify({ ok: false })}  ` },
    { text: "x", structured: { ok: false } }, { text: JSON.stringify({ ok: true }), structured: { ok: false } }, { text: JSON.stringify({ ok: false }), structured: { ok: true } },
    { text: `It ${PHRASE}.` }, { text: `IT ${PHRASE.toUpperCase()}.` },
  ];
  for (const r of failed) assert.equal(reportsFailedWrite(r), true, JSON.stringify(r));
  assert.equal(reportsFailedWrite(null), false);
  assert.equal(reportsFailedWrite(undefined), false);
  const blocks = rec(toolUse("u", CAPTURE, {}), toolResult("u", [{ type: "text", text: JSON.stringify({ ok: false }) }, { type: "text", text: "Try again later." }])).tool_results[0];
  assert.equal(reportsFailedWrite(blocks), false);
});
