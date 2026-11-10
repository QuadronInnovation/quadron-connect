// The hook rows T3b, T1-hook and T2-hook: their verdicts on collected turns, the rows run through main
// with the fake client, their options and the one write rule, and their prompts and reminder checked
// against the plugin's own hook scripts.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodefs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../lib/main.mjs";
import { buildOptions } from "../lib/options.mjs";
import { assertWriteRules } from "../lib/guards.mjs";
import {
  ROWS, ROW_NAMES, HOOK_ROW_NAMES, CONNECTED_SENTENCE, PLUGIN_REMINDER, T1_HOOK_WORDS, WRITE_RULE_TOOL, hookWriteRule, rulePath, showsWrites, turnTools,
} from "../lib/rows.mjs";
import { HOOK_NOT_OBSERVED_NOTE, INCONCLUSIVE, NO_HOOK_OUTPUT_NOTE, VERDICTS, collect, hookEventsOf, hookSummary } from "../lib/verdicts.mjs";
import { BANNER } from "../../../plugins/claude-code/hooks/scripts/session-banner.mjs";
import { CAPTURE_TEXT, RECALL_TEXT, classifyPrompt, run as promptRun } from "../../../plugins/claude-code/hooks/scripts/prompt-trigger.mjs";
import { decide as memoryDecide } from "../../../plugins/claude-code/hooks/scripts/memory-trigger.mjs";
import { box, fakeClient, liveEnv, init, result, toolUse, toolResult, assistantText, denial, CAPTURE, READ } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const [T3B, T1H, T2H] = HOOK_ROW_NAMES;
const DRY_ENV = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };

const run = (b, argv, scripts, over = {}, env = liveEnv()) => {
  const client = Array.isArray(scripts) ? fakeClient(scripts) : scripts;
  const d = b.deps(over);
  return main({ argv, env: { ...b.campaign, ...env }, client, ...d }).then((r) => ({ r, client, d }));
};
const lineOf = (out, row) => out.d.io.lines.find((l) => l.startsWith(`${row}: `));

// Hook messages, shaped as the public docs give them; the output field names are a guess on purpose.
const hook = (subtype, hook_event, extra = {}) => ({ type: "system", subtype, hook_id: `id-${hook_event}`, hook_name: `${hook_event}:x`, hook_event, uuid: "u", session_id: "s", ...extra });
const said = (event, text) => [hook("hook_started", event), hook("hook_response", event, { output: text, stdout: text })];
const sessionStart = (text = `${BANNER}\n`) => said("SessionStart", text);
const promptHook = () => said("UserPromptSubmit", JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: CAPTURE_TEXT } }));
const postToolUse = () => said("PostToolUse", "Quadron: you just updated their instructions file.");
// One turn as live.mjs collects it on a hook row: `before` is what the pump keeps out of `messages`.
const turn = (msgs, before = []) => collect(msgs, [...before, ...msgs]);
const ok = (text = "ok", o = {}) => result(0.1, { result: text, ...o });

const T2_OFFER = "Want me to keep that in Quadron: you bill annually only, with monthly ruled out?";
const T1_OFFER = "Want me to keep it in Quadron: every release note names the exact command that was run?";
const DECISION = "My standard: every release note names the exact command that was run.";
const CWD = path.resolve("/w/cwd");
const TARGET = path.join(CWD, "CLAUDE.md");
const WORDED = { decided: "Every release note names the exact command that was run.", capture_type: "decision" };

// T1-hook's turns, on the verdict.
const t1One = ({ hooks = true, file = TARGET, extra = [], text = T1_OFFER } = {}) => turn([
  init({ session_id: "h1" }), toolUse("w", "Write", { file_path: file, content: DECISION }), toolResult("w", "File created successfully"),
  ...(hooks ? postToolUse() : []), ...extra, assistantText(text), ok(text, { session_id: "h1" }),
]);
const t1Two = ({ input = WORDED, extra = [] } = {}) => turn([init({ session_id: "h1" }), ...extra, toolUse("c", CAPTURE, input), toolResult("c", "Saved for your review"), ok("Kept.", { session_id: "h1" })]);
const t1 = (a, b, ctx = {}) => VERDICTS[T1H]([a, b], { cwd: CWD, filesWrittenAll: ["CLAUDE.md"], ...ctx });

// ---------------------------------------------------------------- the rows themselves

test("hook rows: the three ids, all connector rows in an empty directory with the plugin, hook events on, and nothing else marked", () => {
  assert.deepEqual(HOOK_ROW_NAMES, ["T3b", "T1-hook", "T2-hook"]);
  assert.deepEqual(ROW_NAMES.filter((r) => ROWS[r].hookEvents), HOOK_ROW_NAMES);
  for (const r of HOOK_ROW_NAMES) {
    assert.ok(ROW_NAMES.includes(r), r);
    assert.equal(ROWS[r].connector, true, r);
    assert.equal(ROWS[r].cwd, "empty", r);
    assert.ok(!ROWS[r].noPlugin && !ROWS[r].noSession && !ROWS[r].autoMemory && !ROWS[r].observeWrites, r);
  }
  assert.deepEqual(ROW_NAMES.filter((r) => ROWS[r].hookWriteTarget), [T1H]);
  assert.equal(ROWS[T1H].hookWriteTarget, "CLAUDE.md");
  assert.deepEqual(ROWS[T1H].turns.map((t) => Boolean(t.allowWrite)), [true, false]);
  assert.deepEqual(ROWS[T3B].turns.map((t) => t.tools), [["Skill", "ToolSearch"]]);
  assert.deepEqual(ROWS[T2H].turns[0].tools, ROWS.T4.turns[0].tools);
  assert.deepEqual(ROWS[T1H].turns[1].tools, ROWS.T4.turns[1].tools);
  for (const r of [T3B, T2H]) assert.ok(!ROWS[r].turns[0].tools.some((t) => /capture|commit/.test(t)), r);
});

// ---------------------------------------------------------------- cross-checks against the plugin's scripts

test("T3b's reminder is the plugin's own BANNER, and the connected sentence is the CLI hook's, which the plugin's banner never holds", () => {
  assert.equal(PLUGIN_REMINDER, BANNER);
  assert.ok(nodefs.readFileSync(path.join(REPO, "cli", "hooks", "session-start.js"), "utf8").includes(CONNECTED_SENTENCE));
  assert.ok(!BANNER.includes(CONNECTED_SENTENCE));
});

test("T2-hook's prompt hits the plugin's capture phrases only, and the trigger's run export gives the capture text and not the recall text", () => {
  const prompt = ROWS[T2H].turns[0].prompt;
  assert.deepEqual(classifyPrompt(prompt), { recall: false, capture: true });
  const r = promptRun(JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }));
  assert.equal(r.exitCode, 0);
  const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.equal(context, CAPTURE_TEXT);
  assert.ok(!context.includes(RECALL_TEXT));
  assert.match(prompt, new RegExp(ROWS[T2H].offerPhrase));
  assert.doesNotMatch(prompt, /\b(save|keep|record|remember)\b/i); // a decision, with no ask to save
});

test("T1-hook: neither prompt trips the prompt trigger's capture or recall, so turn 1's offer is down to PostToolUse; the memory trigger fires on the row's Write", () => {
  for (const t of ROWS[T1H].turns) assert.deepEqual(classifyPrompt(t.prompt), { recall: false, capture: false }, t.prompt);
  assert.ok(ROWS[T1H].turns[0].prompt.includes(DECISION));
  assert.ok(ROWS[T1H].turns[0].prompt.includes(ROWS[T1H].hookWriteTarget));
  assert.ok(ROWS[T1H].turns[1].prompt.toLowerCase().includes(T1_HOOK_WORDS));
  const r = memoryDecide({ hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: TARGET, content: DECISION } });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /you just updated their instructions file/);
  // The plugin's PostToolUse filter for this file name, not the auto-memory path filter.
  const hooks = JSON.parse(nodefs.readFileSync(path.join(REPO, "plugins", "claude-code", "hooks", "hooks.json"), "utf8"));
  const filters = hooks.hooks.PostToolUse.flatMap((m) => m.hooks.map((h) => h.if));
  assert.ok(filters.includes(`Edit(**/${ROWS[T1H].hookWriteTarget})`), filters.join(", "));
});

// ---------------------------------------------------------------- hook events, read defensively

test("hookEventsOf: every hook subtype, the event from hook_event or the hook name, text from any field once, and its place after tool calls", () => {
  const events = hookEventsOf([
    hook("hook_started", "SessionStart"),
    hook("hook_response", "SessionStart", { output: "same", stdout: "same", outcome: "success", exit_code: 0 }),
    { type: "system", subtype: "hook_progress", hook_name: "PostToolUse:Write", data: { chunk: "partial" } },
    toolUse("w", "Write", {}),
    hook("hook_response", "PostToolUse", { output: "", note: "from an unknown field", stdout: "from an unknown field, longer" }),
    { type: "system", subtype: "init" },
  ]);
  assert.deepEqual(events.map((e) => [e.hook_event, e.subtype, e.text, e.toolUsesBefore]), [
    ["SessionStart", "hook_started", "", 0],
    ["SessionStart", "hook_response", "same", 0],
    ["PostToolUse", "hook_progress", "partial", 0],
    ["PostToolUse", "hook_response", "from an unknown field, longer", 1],
  ]);
  assert.deepEqual(Object.keys(hookSummary(events)[0]).sort(), ["hook_event", "hook_name", "subtype", "text"]);
  assert.deepEqual(collect([init(), ok()]).hook_events, []);
});

// ---------------------------------------------------------------- T3b on the verdict

test("T3b PASS: the reminder once, from SessionStart, ahead of init; no connected sentence and no capture", () => {
  const v = VERDICTS[T3B]([turn([init(), ok("ready")], sessionStart())]);
  assert.equal(v.verdict, "PASS", v.notes.join(" "));
  assert.ok(v.notes.includes("reminder in a hook_response: 1"));
});

test("T3b FAIL: the reminder twice, in two messages or in one; the connected sentence anywhere; no reminder where hook output was seen", () => {
  for (const [before, re] of [
    [[...sessionStart(), ...sessionStart()], /reminder appeared 2 times/],
    [sessionStart(`${BANNER}\n${BANNER}\n`), /reminder appeared 2 times/],
    [sessionStart(`${CONNECTED_SENTENCE}\n${BANNER}\n`), /connected sentence/],
    [[...sessionStart(), ...said("SessionStart", CONNECTED_SENTENCE)], /connected sentence/],
    [[hook("hook_progress", "SessionStart", { output: CONNECTED_SENTENCE }), ...sessionStart()], /connected sentence/],
    [sessionStart("something else"), /hook output was seen, but not the reminder/],
    [said("UserPromptSubmit", BANNER), /the reminder came from UserPromptSubmit, not SessionStart/],
  ]) {
    const v = VERDICTS[T3B]([turn([init(), ok("ready")], before)]);
    assert.equal(v.verdict, "FAIL", String(re));
    assert.match(v.notes.join(" "), re);
  }
});

test("T3b INCONCLUSIVE with no hook output at all; a capture with no yes is FAIL even then, never INCONCLUSIVE", () => {
  for (const before of [[], [hook("hook_started", "SessionStart"), hook("hook_response", "SessionStart", { outcome: "success" })]]) {
    const v = VERDICTS[T3B]([turn([init(), ok("ready")], before)]);
    assert.equal(v.verdict, INCONCLUSIVE);
    assert.equal(v.notes[0], NO_HOOK_OUTPUT_NOTE);
  }
  for (const a of [
    turn([init(), toolUse("c", CAPTURE, { decided: "x" }), ok("ready")]),
    turn([init(), ok("ready", { permission_denials: [denial("c", CAPTURE)] })]),
    turn([init(), toolUse("c", CAPTURE, { decided: "x" }), ok("ready")], sessionStart()),
  ]) {
    const v = VERDICTS[T3B]([a]);
    assert.equal(v.verdict, "FAIL");
    assert.match(v.notes.join(" "), /a capture tool was called/);
  }
});

// ---------------------------------------------------------------- T2-hook on the verdict

test("T2-hook PASS: the UserPromptSubmit event, an offer at the stated phrase, no capture", () => {
  const v = VERDICTS[T2H]([turn([init(), ...promptHook(), assistantText(T2_OFFER), ok(T2_OFFER)])]);
  assert.equal(v.verdict, "PASS", v.notes.join(" "));
  assert.ok(v.notes.includes("UserPromptSubmit hook event: seen"));
});

test("T2-hook FAIL: a capture, allowed or denied, is captured before confirmation, with or without the hook event; and no offer fails", () => {
  for (const hooks of [promptHook(), []]) {
    for (const a of [
      turn([init(), ...hooks, toolUse("c", CAPTURE, { decided: "annually" }), toolResult("c", "Saved"), assistantText(T2_OFFER), ok(T2_OFFER)]),
      turn([init(), ...hooks, assistantText(T2_OFFER), ok(T2_OFFER, { permission_denials: [denial("c", CAPTURE)] })]),
    ]) {
      const v = VERDICTS[T2H]([a]);
      assert.equal(v.verdict, "FAIL");
      assert.match(v.notes.join(" "), /captured before confirmation/);
    }
  }
  const none = VERDICTS[T2H]([turn([init(), ...promptHook(), assistantText("Understood."), ok("Understood.")])]);
  assert.equal(none.verdict, "FAIL");
  assert.match(none.notes.join(" "), /no offer with the stated phrase \("annually"\)/);
});

test("T2-hook INCONCLUSIVE: offer and no capture, but no UserPromptSubmit event; never a pass by order alone", () => {
  for (const hooks of [[], sessionStart()]) {
    const v = VERDICTS[T2H]([turn([init(), assistantText(T2_OFFER), ok(T2_OFFER)], hooks)]);
    assert.equal(v.verdict, INCONCLUSIVE);
    assert.equal(v.notes[0], HOOK_NOT_OBSERVED_NOTE);
    assert.equal(HOOK_NOT_OBSERVED_NOTE, "hook event not observed; tool-call order only");
  }
});

// ---------------------------------------------------------------- T1-hook on the verdict

test("T1-hook PASS: the Write to CLAUDE.md ran, PostToolUse after it, one offer, no capture; turn 2 one accepted capture with the person's words", () => {
  const v = t1(t1One(), t1Two());
  assert.equal(v.verdict, "PASS", v.notes.join(" "));
  assert.ok(v.notes.includes("PostToolUse hook event after the Write: seen"));
  // The words are matched without regard to case, in any string field of the input.
  assert.equal(t1(t1One(), t1Two({ input: { quad_name: "x", body: { text: "EXACT COMMAND THAT WAS RUN, always" } } })).verdict, "PASS");
});

test("T1-hook FAIL: a capture in turn 1, allowed or denied, whatever turn 2 does; and a capture with no yes is never INCONCLUSIVE", () => {
  for (const extra of [[toolUse("c0", CAPTURE, WORDED), toolResult("c0", "Saved")], [toolUse("c0", CAPTURE, WORDED)]]) {
    for (const hooks of [true, false]) {
      const v = t1(t1One({ extra, hooks }), t1Two());
      assert.equal(v.verdict, "FAIL");
      assert.match(v.notes.join(" "), /captured before confirmation/);
    }
  }
  const denied = turn([init({ session_id: "h1" }), toolUse("w", "Write", { file_path: TARGET }), toolResult("w", "ok"), assistantText(T1_OFFER),
    ok(T1_OFFER, { session_id: "h1", permission_denials: [denial("c0", CAPTURE)] })]);
  assert.equal(t1(denied, t1Two()).verdict, "FAIL");
});

test("T1-hook FAIL: a write anywhere else, a file other than CLAUDE.md, a write in turn 2, no Write, no offer, and turn 2's capture count or words", () => {
  const cases = [
    [t1(t1One({ file: path.join(CWD, "notes.md") }), t1Two()), /turn 1 wrote somewhere other than CLAUDE\.md: Write/],
    [t1(t1One({ extra: [toolUse("e", "Edit", { file_path: path.join(CWD, "other.md") })] }), t1Two()), /turn 1 wrote somewhere other than CLAUDE\.md: Edit/],
    [t1(t1One(), t1Two(), { filesWrittenAll: ["CLAUDE.md", "stray.txt"] }), /files written in the working directory besides CLAUDE\.md: stray\.txt/],
    [t1(t1One(), t1Two({ extra: [toolUse("w2", "Write", { file_path: TARGET })] })), /turn 2 wrote: Write/],
    [t1(turn([init(), assistantText(T1_OFFER), ok(T1_OFFER)]), t1Two()), /Write to CLAUDE\.md did not run/],
    [t1(t1One({ text: "Done." }), t1Two()), /no offer with the note's phrase \("exact command"\)/],
    [t1(t1One(), t1Two({ input: { decided: "Release notes matter." } })), /does not hold the person's words/],
    [t1(t1One(), turn([init(), ok("Kept.")])), /calls: 0, accepted: 0/],
    [t1(t1One(), undefined), /turn 2 did not run/],
    [t1(t1One(), t1Two(), { cwd: undefined }), /turn 1 wrote somewhere other than CLAUDE\.md/], // with no directory, no write is placed at the file
  ];
  for (const [v, re] of cases) {
    assert.equal(v.verdict, "FAIL", String(re));
    assert.match(v.notes.join(" "), re);
  }
});

test("T1-hook INCONCLUSIVE: everything else holds, but no PostToolUse event after the Write", () => {
  const before = turn([init({ session_id: "h1" }), ...postToolUse(), toolUse("w", "Write", { file_path: TARGET, content: DECISION }), toolResult("w", "ok"), assistantText(T1_OFFER), ok(T1_OFFER, { session_id: "h1" })]);
  for (const a of [t1One({ hooks: false }), before]) {
    const v = t1(a, t1Two());
    assert.equal(v.verdict, INCONCLUSIVE);
    assert.equal(v.notes[0], HOOK_NOT_OBSERVED_NOTE);
  }
});

// ---------------------------------------------------------------- options and the one write rule

test("options: includeHookEvents only when asked for; without it the options are byte for byte as before", () => {
  const base = { settingsPath: "s.json", pluginDir: "/p", tools: [], allowedTools: [], cwd: "/c" };
  assert.equal("includeHookEvents" in buildOptions(base), false);
  assert.equal(JSON.stringify(buildOptions({ ...base, hookEvents: false })), JSON.stringify(buildOptions(base)));
  assert.equal(buildOptions({ ...base, hookEvents: true }).includeHookEvents, true);
  const { includeHookEvents, ...rest } = buildOptions({ ...base, hookEvents: true });
  assert.equal(includeHookEvents, true);
  assert.equal(JSON.stringify(rest), JSON.stringify(buildOptions(base)));
});

test("the write rule: T1-hook's turn 1 alone, one Edit rule naming its one file; every other row and turn has none", () => {
  assert.equal(WRITE_RULE_TOOL, "Edit");
  assert.equal(rulePath("C:\\Users\\x\\cwd\\CLAUDE.md"), "//c/Users/x/cwd/CLAUDE.md");
  assert.equal(rulePath("/tmp/x/CLAUDE.md"), "//tmp/x/CLAUDE.md");
  assert.equal(hookWriteRule(ROWS[T1H], ROWS[T1H].turns[0], "/tmp/x"), "Edit(//tmp/x/CLAUDE.md)");
  assert.equal(hookWriteRule(ROWS[T1H], ROWS[T1H].turns[1], "/tmp/x"), null);
  for (const r of ROW_NAMES.filter((n) => n !== T1H)) for (const t of ROWS[r].turns) assert.equal(hookWriteRule(ROWS[r], t, "/tmp/x"), null, r);
  assert.throws(() => hookWriteRule(ROWS[T1H], ROWS[T1H].turns[0], "/tmp/a*b"), /reads as a pattern/);
  assert.throws(() => hookWriteRule({ ...ROWS[T1H], hookWriteTarget: "../CLAUDE.md" }, ROWS[T1H].turns[0], "/tmp/x"), /one plain file name/);
  assert.deepEqual(ROW_NAMES.filter((r) => showsWrites(ROWS[r])), [...ROW_NAMES.filter((r) => ROWS[r].observeWrites), T1H]);
  assert.deepEqual(turnTools(ROWS[T1H], ROWS[T1H].turns[0]), ["Skill", "ToolSearch", "Write", "Edit"]);
  // The guard: exactly the expected rule, or none.
  const o = (allowedTools) => ({ allowedTools });
  assert.doesNotThrow(() => assertWriteRules(o(["Skill"])));
  assert.doesNotThrow(() => assertWriteRules(o(["Skill", "Edit(//tmp/x/CLAUDE.md)"]), "Edit(//tmp/x/CLAUDE.md)"));
  for (const [list, expected] of [
    [["Edit(//tmp/x/CLAUDE.md)"], null],
    [["Write(//tmp/x/CLAUDE.md)"], null],
    [["Edit(//tmp/x/**)"], "Edit(//tmp/x/CLAUDE.md)"],
    [["Edit(//tmp/x/CLAUDE.md)", "Edit(//tmp/x/other.md)"], "Edit(//tmp/x/CLAUDE.md)"],
    [[], "Edit(//tmp/x/CLAUDE.md)"],
  ]) assert.throws(() => assertWriteRules(o(list), expected), /write rule/, list.join(","));
});

test("another row cannot carry a write rule: one added to its options refuses before any call, exit 2", async () => {
  const b = box();
  const add = (opts) => ({ ...opts, allowedTools: [...opts.allowedTools, "Edit(//tmp/x/CLAUDE.md)"] });
  const out = await run(b, b.argv("T4O-N"), [[init(), ok("x")]], { testOptionsHook: add });
  assert.equal(out.r.exitCode, 2);
  assert.match(out.d.io.errors.join(" "), /write rule/);
  assert.equal(out.client.calls.length, 0);
});

// ---------------------------------------------------------------- through the row

const T3B_OK = (before = sessionStart()) => ({ messages: [init({ session_id: "t3b" }), ok("ready", { session_id: "t3b" })], before });

test("T3b through the row: hook messages ahead of init are no load stop; PASS, exit 0, and the events in the evidence and the summary", async () => {
  const b = box();
  const out = await run(b, b.argv(T3B), [T3B_OK()], { timeoutMs: 200 });
  assert.equal(out.r.exitCode, 0, out.r.summary.notes.join(" "));
  assert.equal(out.r.summary.verdict, "PASS");
  assert.equal(out.client.prompts.length, 1);
  assert.equal(out.client.prompts[0].text, ROWS[T3B].turns[0].prompt);
  const { options } = out.client.calls[0];
  assert.equal(options.includeHookEvents, true);
  assert.deepEqual(options.plugins, [{ type: "local", path: b.plugin }]);
  assert.deepEqual(options.allowedTools, ["Skill", "ToolSearch"]);
  assert.ok(options.disallowedTools.includes("Write"));
  assert.deepEqual(b.summary().hookEvents, [{ turn: 1, events: [
    { hook_event: "SessionStart", hook_name: "SessionStart:x", subtype: "hook_started", text: "" },
    { hook_event: "SessionStart", hook_name: "SessionStart:x", subtype: "hook_response", text: `${BANNER}\n` },
  ] }]);
  assert.ok(b.summary().notes.includes("hook events came before init (system:hook_started, system:hook_response); read by this row's verdict (see hookEvents)"));
  const stream = nodefs.readFileSync(path.join(b.out, b.attemptDirs()[0], "stream.jsonl"), "utf8");
  assert.match(stream, /"subtype":"hook_started"/);
  assert.match(stream, /"subtype":"hook_response"/);
  assert.equal(lineOf(out, T3B), "T3b: PASS; call spend 0.1000 USD");
});

test("T3b through the row: no hook output is INCONCLUSIVE, exit 1; a double reminder is FAIL", async () => {
  const b = box();
  const none = await run(b, b.argv(T3B), [T3B_OK([])], { timeoutMs: 200 });
  assert.equal(none.r.exitCode, 1);
  assert.equal(none.r.summary.verdict, INCONCLUSIVE);
  assert.ok(none.r.summary.notes.includes(NO_HOOK_OUTPUT_NOTE));
  assert.deepEqual(b.summary().hookEvents, [{ turn: 1, events: [] }]);
  const c = box();
  const twice = await run(c, c.argv(T3B), [T3B_OK([...sessionStart(), ...sessionStart()])], { timeoutMs: 200 });
  assert.equal(twice.r.exitCode, 1);
  assert.equal(twice.r.summary.verdict, "FAIL");
});

test("T2-hook through the row: PASS with the event after the prompt; the capture is visible and not allowed, and a denied one fails the row", async () => {
  const b = box();
  const good = await run(b, b.argv(T2H), [[init({ session_id: "t2h" }), ...promptHook(), assistantText(T2_OFFER), ok(T2_OFFER, { session_id: "t2h" })]]);
  assert.equal(good.r.exitCode, 0, good.r.summary.notes.join(" "));
  assert.equal(good.r.summary.verdict, "PASS");
  const { options } = good.client.calls[0];
  assert.equal(options.includeHookEvents, true);
  assert.ok(!options.allowedTools.includes(CAPTURE));
  assert.ok(!options.allowedTools.some((t) => t.includes("(")));
  assert.equal(good.client.prompts[0].text, ROWS[T2H].turns[0].prompt);
  const c = box();
  const bad = await run(c, c.argv(T2H), [[init({ session_id: "t2h" }), ...promptHook(), toolUse("c", CAPTURE, { decided: "annually" }), assistantText(T2_OFFER), ok(T2_OFFER, { session_id: "t2h" })]]);
  assert.deepEqual(bad.client.denials.map((d) => d.tool_name), [CAPTURE]);
  assert.equal(bad.r.exitCode, 1);
  assert.equal(bad.r.summary.verdict, "FAIL");
  assert.match(bad.r.summary.notes.join(" "), /captured before confirmation/);
  const d = box();
  const quiet = await run(d, d.argv(T2H), [[init({ session_id: "t2h" }), assistantText(T2_OFFER), ok(T2_OFFER, { session_id: "t2h" })]]);
  assert.equal(quiet.r.exitCode, 1);
  assert.equal(quiet.r.summary.verdict, INCONCLUSIVE);
  assert.ok(quiet.r.summary.notes.includes(HOOK_NOT_OBSERVED_NOTE));
});

// T1-hook's first turn as the fake runs it: the Write lands in the session's own working directory.
const t1First = ({ where = "CLAUDE.md", hooks = true, extra = [], write = true } = {}) => (args) => {
  const file = path.join(args.options.cwd, where);
  if (write) nodefs.writeFileSync(file, DECISION);
  return [init({ session_id: "h1" }), toolUse("w", "Write", { file_path: file, content: DECISION }), toolResult("w", "File created successfully"),
    ...(hooks ? postToolUse() : []), ...extra, assistantText(T1_OFFER), result(0.1, { session_id: "h1", result: T1_OFFER })];
};
const t1Second = (input = WORDED) => [init({ session_id: "h1" }), toolUse("c", CAPTURE, input), toolResult("c", "Saved for your review"), result(0.25, { session_id: "h1", result: "Kept." })];

test("T1-hook through the row: turn 1's one write rule names CLAUDE.md in the row's directory, the Write runs, turn 2 resumes with the capture allowed: PASS", async () => {
  const b = box();
  const out = await run(b, b.argv(T1H), [t1First(), t1Second()]);
  assert.equal(out.r.exitCode, 0, out.r.summary.notes.join(" "));
  assert.equal(out.r.summary.verdict, "PASS");
  assert.equal(out.client.calls.length, 2);
  const [one, two] = out.client.calls.map((c) => c.options);
  const writeRules = (o) => o.allowedTools.filter((t) => /^(Write|Edit|MultiEdit|NotebookEdit)\(/.test(t));
  assert.deepEqual(writeRules(one), [`Edit(${rulePath(path.join(one.cwd, "CLAUDE.md"))})`]);
  assert.deepEqual(writeRules(two), []);
  assert.ok(!one.allowedTools.includes("Write") && !one.allowedTools.includes("Edit"));
  assert.ok(!one.allowedTools.includes(CAPTURE));
  assert.ok(two.allowedTools.includes(CAPTURE));
  for (const o of [one, two]) {
    assert.equal(o.includeHookEvents, true);
    assert.ok(o.tools.includes("Write") && o.tools.includes("Edit"));
    assert.ok(!o.disallowedTools.includes("Write") && !o.disallowedTools.includes("Edit"));
    assert.ok(o.disallowedTools.includes("Bash"));
  }
  assert.equal(two.resume, "h1");
  assert.deepEqual(out.client.denials, []);
  assert.deepEqual(out.client.prompts.map((p) => p.text), ROWS[T1H].turns.map((t) => t.prompt));
  assert.equal(b.summary().hookEvents.length, 2);
  assert.ok(b.summary().hookEvents[0].events.some((e) => e.hook_event === "PostToolUse" && e.subtype === "hook_response"));
  assert.equal(b.calls().length, 2); // a reservation per turn
});

test("T1-hook through the row: a write elsewhere is denied and fails turn 1, a capture in turn 1 fails it, and no turn 2 is spent", async () => {
  for (const [script, re] of [
    [t1First({ where: "notes.md", write: false }), /turn 1 wrote somewhere other than CLAUDE\.md/],
    [t1First({ extra: [toolUse("c0", CAPTURE, WORDED)] }), /captured before confirmation/],
  ]) {
    const b = box();
    const out = await run(b, b.argv(T1H), [script, t1Second()]);
    assert.equal(out.client.calls.length, 1, String(re));
    assert.equal(out.r.exitCode, 1, String(re));
    assert.equal(out.r.summary.verdict, "FAIL", String(re));
    assert.match(out.r.summary.notes.join(" "), re);
  }
});

test("T1-hook through the row: no PostToolUse event is INCONCLUSIVE, exit 1, after both turns; a stray file fails it", async () => {
  const b = box();
  const quiet = await run(b, b.argv(T1H), [t1First({ hooks: false }), t1Second()]);
  assert.equal(quiet.client.calls.length, 2);
  assert.equal(quiet.r.exitCode, 1);
  assert.equal(quiet.r.summary.verdict, INCONCLUSIVE);
  assert.ok(quiet.r.summary.notes.includes(HOOK_NOT_OBSERVED_NOTE));
  const c = box();
  const stray = (args) => { nodefs.writeFileSync(path.join(args.options.cwd, "stray.txt"), "x"); return t1Second(); };
  const out = await run(c, c.argv(T1H), [t1First(), stray]);
  assert.equal(out.r.exitCode, 1);
  assert.equal(out.r.summary.verdict, "FAIL");
  assert.match(out.r.summary.notes.join(" "), /besides CLAUDE\.md: stray\.txt/);
});

test("other rows: no includeHookEvents and no write rule in their options, and the old note for a hook event ahead of init", async () => {
  const b = box();
  const out = await run(b, b.argv("T4O-N"), [{ messages: [init({ session_id: "o" }), assistantText("x"), ok("x")], before: sessionStart() }], { timeoutMs: 200 });
  const { options } = out.client.calls[0];
  assert.equal("includeHookEvents" in options, false);
  assert.ok(!options.allowedTools.some((t) => t.includes("(")));
  assert.ok(!options.tools.includes("Write"));
  assert.equal("hookEvents" in out.r.summary, false);
  assert.ok(b.summary().notes.includes("hook events came before init (system:hook_started, system:hook_response); plugin hooks are not checked"));
  assert.equal(out.client.prompts.length, 1);
});

// ---------------------------------------------------------------- dry run

test("--dry-run: each hook row on its own line, with hook events and, for T1-hook, the one write; T1-hook reserves two turns", async () => {
  const b = box();
  const hooks = "; hook events recorded (includeHookEvents) and read by the verdict; a hook not observed is INCONCLUSIVE, never a pass";
  for (const [row, line] of [
    [T3B, `would run T3b: 1 turn(s), caps 3, one command and one session${hooks}`],
    [T2H, `would run T2-hook: 1 turn(s), caps 5, one command and one session; offer phrase "annually"${hooks}`],
    [T1H, "would run T1-hook: 2 turn(s), caps 6/5, one command and one session; offer phrase \"exact command\"; Write and Edit shown, and one rule allows a write to CLAUDE.md " +
      `in the row's working directory on turn 1 only; every other write is denied and fails the row${hooks}`],
  ]) {
    const d = b.deps();
    assert.equal((await main({ argv: ["--dry-run", "--row", row], env: DRY_ENV, ...d })).exitCode, 0, row);
    assert.ok(d.io.lines.includes(line), d.io.lines.join("\n"));
  }
});
