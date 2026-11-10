// T1-memory-hook: the hook row whose one Write goes to a memory file under the config directory. Its
// verdict on collected turns, the row run through main with the fake client, its write rule, env and
// prompt, and its file path checked against the plugin's own memory trigger.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodefs from "node:fs";
import path from "node:path";
import { main } from "../lib/main.mjs";
import { AUTO_MEMORY_VAR, PROJECT_DIR_VAR, assertAutoMemory, buildChildEnv } from "../lib/guards.mjs";
import {
  ROWS, HOOK_ROW_NAMES, MEMORY_HOOK_PROJECT_DIR, T1_HOOK_STEER, T1_MEMORY_HOOK_STEER, T1_MEMORY_HOOK_WORDS, WRITE_PATH_PLACEHOLDER,
  hookWriteDir, hookWritePath, hookWriteRule, rulePath, turnPrompt, turnTools, writesMemory,
} from "../lib/rows.mjs";
import { INCONCLUSIVE, MEMORY_STEER_NOT_SEEN_NOTE, NO_POST_TOOL_USE_NOTE, VERDICTS, collect } from "../lib/verdicts.mjs";
import { classifyPrompt } from "../../../plugins/claude-code/hooks/scripts/prompt-trigger.mjs";
import { decide as memoryDecide } from "../../../plugins/claude-code/hooks/scripts/memory-trigger.mjs";
import { box, fakeClient, liveEnv, init, result, toolUse, toolResult, assistantText, CAPTURE } from "./helpers.mjs";

const [, T1H, , T1M] = HOOK_ROW_NAMES;
const DEF = ROWS[T1M];
const FILE = DEF.hookWriteTarget;
const DRY_ENV = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };
const DECISION = "My standard: every hotfix gets a rollback note before it ships.";
const OFFER = "Want me to keep it in Quadron: every hotfix gets a rollback note before it ships?";
const WORDED = { decided: "Every hotfix gets a rollback note before it ships.", capture_type: "standard" };
const CWD = path.resolve("/w/cwd");
const CFG = path.resolve("/w/cfg");
const TARGET = path.join(CFG, "projects", MEMORY_HOOK_PROJECT_DIR, "memory", FILE);

const run = (b, argv, scripts, over = {}, env = liveEnv()) => {
  const client = fakeClient(scripts);
  const d = b.deps(over);
  return main({ argv, env: { ...b.campaign, ...env }, client, ...d }).then((r) => ({ r, client, d }));
};
const hook = (subtype, hook_event, extra = {}) => ({ type: "system", subtype, hook_id: `id-${hook_event}`, hook_name: `${hook_event}:x`, hook_event, uuid: "u", session_id: "s", ...extra });
const said = (event, text) => [hook("hook_started", event), hook("hook_response", event, { output: text, stdout: text })];
// What the memory trigger prints for a Write to `file`, from the plugin script itself, as the hook sees it:
// CLAUDE_CONFIG_DIR in its environment and the session's transcript under the same config directory.
const trigger = (file, cfg = CFG) => memoryDecide(
  { hook_event_name: "PostToolUse", tool_name: "Write", transcript_path: path.join(cfg, "projects", MEMORY_HOOK_PROJECT_DIR, "s.jsonl"), tool_input: { file_path: file, content: DECISION } },
  { CLAUDE_CONFIG_DIR: cfg },
);
const postToolUse = (file = TARGET, cfg = CFG) => said("PostToolUse", trigger(file, cfg).stdout);
const turn = (msgs) => collect(msgs, msgs);
const ok = (text = "ok", o = {}) => result(0.1, { result: text, ...o });

const one = ({ hooks = postToolUse(), file = TARGET, extra = [], text = OFFER } = {}) => turn([
  init({ session_id: "m1" }), toolUse("w", "Write", { file_path: file, content: DECISION }), toolResult("w", "File created successfully"),
  ...hooks, ...extra, assistantText(text), ok(text, { session_id: "m1" }),
]);
const two = ({ input = WORDED, extra = [] } = {}) => turn([init({ session_id: "m1" }), ...extra, toolUse("c", CAPTURE, input), toolResult("c", "Saved for your review"), ok("Kept.", { session_id: "m1" })]);
const verdict = (a, b, ctx = {}) => VERDICTS[T1M]([a, b], { cwd: CWD, configDir: CFG, filesWrittenAll: [], hookDirFiles: [FILE], ...ctx });

// ---------------------------------------------------------------- the row itself

test("T1-memory-hook: a hook row with one write to a .md file in the memory directory, auto memory off, T1-hook's turn shape", () => {
  assert.equal(T1M, "T1-memory-hook");
  assert.equal(DEF.connector, true);
  assert.equal(DEF.cwd, "empty");
  assert.equal(DEF.hookEvents, true);
  assert.ok(!DEF.autoMemory && !DEF.observeWrites && !DEF.noPlugin);
  assert.equal(DEF.hookWriteDir, "memory");
  assert.equal(writesMemory(DEF), true);
  assert.equal(writesMemory(ROWS[T1H]), false);
  assert.equal(DEF.projectDirName, MEMORY_HOOK_PROJECT_DIR);
  assert.match(FILE, /^[\w-]+\.md$/);
  assert.notEqual(FILE, "MEMORY.md"); // the trigger skips the index file
  assert.deepEqual(DEF.turns.map((t) => Boolean(t.allowWrite)), [true, false]);
  assert.deepEqual(DEF.turns.map((t) => t.maxTurns), ROWS[T1H].turns.map((t) => t.maxTurns)); // the same caps
  assert.deepEqual(DEF.turns.map((t) => t.tools), ROWS[T1H].turns.map((t) => t.tools));
  assert.deepEqual(turnTools(DEF, DEF.turns[0]), ["Skill", "ToolSearch", "Write", "Edit"]);
});

test("T1-memory-hook: the prompts trip neither prompt trigger, turn 1 carries the decision and the path placeholder, turn 2 the person's words", () => {
  const sent = DEF.turns.map((t) => turnPrompt(DEF, t, CWD, CFG));
  for (const p of sent) assert.deepEqual(classifyPrompt(p), { recall: false, capture: false }, p);
  assert.ok(DEF.turns[0].prompt.includes(WRITE_PATH_PLACEHOLDER));
  assert.ok(!sent[0].includes(WRITE_PATH_PLACEHOLDER));
  assert.ok(sent[0].includes(TARGET));
  assert.ok(sent[0].includes(DECISION));
  assert.equal(sent[1], DEF.turns[1].prompt);
  assert.ok(sent[1].toLowerCase().includes(T1_MEMORY_HOOK_WORDS));
  // A row with no placeholder is sent as written.
  assert.equal(turnPrompt(ROWS[T1H], ROWS[T1H].turns[0], CWD, CFG), ROWS[T1H].turns[0].prompt);
});

test("T1-memory-hook: the file's path is one the plugin's memory trigger answers with the memory steer, and only under the session's config directory", () => {
  assert.equal(hookWriteDir(DEF, CWD, CFG), path.dirname(TARGET));
  assert.equal(hookWritePath(DEF, CWD, CFG), TARGET);
  assert.equal(T1_MEMORY_HOOK_STEER, "Quadron: you just saved a memory:");
  assert.notEqual(T1_MEMORY_HOOK_STEER, T1_HOOK_STEER);
  const r = trigger(TARGET);
  assert.equal(r.exitCode, 0);
  const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(context.startsWith(T1_MEMORY_HOOK_STEER), context);
  assert.ok(context.includes(DECISION));
  // The Windows form of the same path, as the Write tool reports it there.
  const win = "C:\\w\\cfg\\projects\\t1-memory-hook\\memory\\hotfix-standard.md";
  const w = memoryDecide({ hook_event_name: "PostToolUse", tool_name: "Write", transcript_path: "C:\\w\\cfg\\projects\\t1-memory-hook\\s.jsonl", tool_input: { file_path: win, content: DECISION } }, { CLAUDE_CONFIG_DIR: "C:\\w\\cfg" });
  assert.ok(JSON.parse(w.stdout).hookSpecificOutput.additionalContext.startsWith(T1_MEMORY_HOOK_STEER));
  // With no CLAUDE_CONFIG_DIR in the hook's environment the transcript path still places it.
  const bare = memoryDecide({ hook_event_name: "PostToolUse", tool_name: "Write", transcript_path: path.join(CFG, "projects", "x", "s.jsonl"), tool_input: { file_path: TARGET, content: DECISION } }, {});
  assert.ok(bare.stdout.includes(T1_MEMORY_HOOK_STEER));
  // Another config directory's memory is not this session's: silent.
  assert.equal(trigger(TARGET, path.resolve("/w/other")).stdout, "");
});

// ---------------------------------------------------------------- the write rule, the env and the guards

test("T1-memory-hook's write rule: turn 1 alone, one Edit rule naming the file in the memory directory; no config directory refuses", () => {
  assert.equal(hookWriteRule(DEF, DEF.turns[0], "/tmp/x", null, "/tmp/cfg"), `Edit(//tmp/cfg/projects/${MEMORY_HOOK_PROJECT_DIR}/memory/${FILE})`);
  assert.equal(hookWriteRule(DEF, DEF.turns[1], "/tmp/x", null, "/tmp/cfg"), null);
  assert.equal(rulePath(`C:\\cfg\\projects\\${MEMORY_HOOK_PROJECT_DIR}\\memory\\${FILE}`), `//c/cfg/projects/${MEMORY_HOOK_PROJECT_DIR}/memory/${FILE}`);
  assert.throws(() => hookWriteRule(DEF, DEF.turns[0], "/tmp/x"), /needs the config directory/);
  assert.throws(() => hookWriteRule(DEF, DEF.turns[0], "/tmp/x", null, "/tmp/c*g"), /reads as a pattern/);
  for (const bad of [{ hookWriteDir: "home" }, { projectDirName: undefined }, { projectDirName: "a/b" }, { autoMemory: true }, { hookWriteTarget: "note.txt" }]) {
    assert.throws(() => hookWriteRule({ ...DEF, ...bad }, DEF.turns[0], "/tmp/x", null, "/tmp/cfg"), /hookWriteDir must be "memory"/, JSON.stringify(bad));
  }
  // The real path: the memory directory's own, or the row refuses.
  const dir = path.resolve("/srv/cfg/projects", MEMORY_HOOK_PROJECT_DIR, "memory");
  const pathFs = (map) => ({ realpathSync: (p) => { if (p in map) return map[p]; throw new Error("ENOENT"); } });
  assert.equal(hookWriteRule(DEF, DEF.turns[0], "/srv/cwd", pathFs({ [dir]: dir }), path.resolve("/srv/cfg")), `Edit(${rulePath(path.join(dir, FILE))})`);
  assert.throws(() => hookWriteRule(DEF, DEF.turns[0], "/srv/cwd", pathFs({ [dir]: "/data/memory" }), path.resolve("/srv/cfg")), /memory directory resolves elsewhere \(a symlink or a short name\).*the row was not run/);
});

test("the child env: a memory-directory row carries its project directory name with auto memory off; the guards hold both", () => {
  const env = buildChildEnv({}, { configDir: "/c", homeDir: "/h", maxOutputTokens: 1, memoryDir: true, projectDirName: MEMORY_HOOK_PROJECT_DIR });
  assert.equal(env[PROJECT_DIR_VAR], MEMORY_HOOK_PROJECT_DIR);
  assert.equal(env[AUTO_MEMORY_VAR], "1");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/c");
  assert.throws(() => buildChildEnv({}, { configDir: "/c", homeDir: "/h", maxOutputTokens: 1, memoryDir: true }), /memory-directory row needs a project directory name/);
  assert.throws(() => buildChildEnv({}, { homeDir: "/h", maxOutputTokens: 1, memoryDir: true, projectDirName: "x" }), /memory-directory row needs/);
  assert.throws(() => buildChildEnv({}, { configDir: "/c", homeDir: "/h", maxOutputTokens: 1, memoryDir: true, autoMemory: true, projectDirName: "x" }), /with auto memory off/);
  assert.throws(() => buildChildEnv({}, { configDir: "/c", homeDir: "/h", maxOutputTokens: 1, memoryDir: true, projectDirName: "a/b" }), /1-64 letters/);
  assert.doesNotThrow(() => assertAutoMemory({ env }, false, MEMORY_HOOK_PROJECT_DIR));
  assert.throws(() => assertAutoMemory({ env }, false, "another"), /must be the row's project directory name/);
  assert.throws(() => assertAutoMemory({ env }, false, undefined), /is for an autoMemory row only/);
  assert.throws(() => assertAutoMemory({ env: { ...env, [AUTO_MEMORY_VAR]: "0" } }, false, MEMORY_HOOK_PROJECT_DIR), /must be 1 on this row/);
});

// ---------------------------------------------------------------- on the verdict

test("T1-memory-hook PASS: the Write to the memory file ran, a PostToolUse hook_started and the memory steer in its hook_response after it, one offer, no capture; turn 2 one accepted capture with the person's words", () => {
  const v = verdict(one(), two());
  assert.equal(v.verdict, "PASS", v.notes.join(" "));
  assert.ok(v.notes.includes("PostToolUse after the Write: hook_started seen, memory steer in a hook_response seen"));
  assert.equal(verdict(one(), two({ input: { body: { text: "ROLLBACK NOTE BEFORE IT SHIPS, always" } } })).verdict, "PASS");
});

test("T1-memory-hook FAIL: no PostToolUse event after the Write, whatever else holds; one before the Write does not count", () => {
  const before = turn([init({ session_id: "m1" }), ...postToolUse(), toolUse("w", "Write", { file_path: TARGET, content: DECISION }), toolResult("w", "ok"), assistantText(OFFER), ok(OFFER, { session_id: "m1" })]);
  for (const a of [one({ hooks: [] }), one({ hooks: said("UserPromptSubmit", "x") }), before]) {
    const v = verdict(a, two());
    assert.equal(v.verdict, "FAIL");
    assert.ok(v.notes.includes(NO_POST_TOOL_USE_NOTE), v.notes.join(" "));
  }
});

test("T1-memory-hook INCONCLUSIVE: a PostToolUse event after the Write without both the start and the memory steer in a hook_response", () => {
  for (const hooks of [
    [hook("hook_started", "PostToolUse")],
    [hook("hook_started", "PostToolUse"), hook("hook_response", "PostToolUse", { outcome: "success" })],
    [hook("hook_started", "PostToolUse"), hook("hook_progress", "PostToolUse", { output: `${T1_MEMORY_HOOK_STEER} "x"` })],
    [hook("hook_response", "PostToolUse", { output: `${T1_MEMORY_HOOK_STEER} "x"` })], // answered, never seen to start
    said("PostToolUse", `${T1_HOOK_STEER} "x"`), // the instructions-file steer is the wrong one for a memory file
    [hook("hook_started", "PostToolUse"), hook("hook_response", "UserPromptSubmit", { output: `${T1_MEMORY_HOOK_STEER} "x"` })],
  ]) {
    const v = verdict(one({ hooks }), two());
    assert.equal(v.verdict, INCONCLUSIVE, JSON.stringify(hooks));
    assert.equal(v.notes[0], MEMORY_STEER_NOT_SEEN_NOTE);
  }
});

test("T1-memory-hook FAIL: a capture with no yes, a write anywhere else, a stray file, no Write, no offer, and turn 2's capture count or words", () => {
  const cases = [
    [verdict(one({ extra: [toolUse("c0", CAPTURE, WORDED), toolResult("c0", "Saved")] }), two()), /captured before confirmation/],
    [verdict(one({ extra: [toolUse("c0", CAPTURE, WORDED)], hooks: [] }), two()), /captured before confirmation/],
    [verdict(one({ file: path.join(CWD, FILE) }), two()), new RegExp(`turn 1 wrote somewhere other than ${FILE.replace(".", "\\.")}: Write`)],
    [verdict(one({ file: path.join(path.dirname(TARGET), "MEMORY.md") }), two()), /turn 1 wrote somewhere other than/],
    [verdict(one({ file: path.join(CFG, "projects", "another", "memory", FILE) }), two()), /turn 1 wrote somewhere other than/],
    [verdict(one({ extra: [toolUse("e", "Edit", { file_path: path.join(CWD, "CLAUDE.md") })] }), two()), /turn 1 wrote somewhere other than .*: Edit/],
    [verdict(one(), two(), { filesWrittenAll: ["stray.txt"] }), /files written in the working directory: stray\.txt/],
    [verdict(one(), two(), { hookDirFiles: [FILE, "MEMORY.md"] }), /files written in the memory directory besides .*: MEMORY\.md/],
    [verdict(one(), two({ extra: [toolUse("w2", "Write", { file_path: TARGET })] })), /turn 2 wrote: Write/],
    [verdict(turn([init(), assistantText(OFFER), ok(OFFER)]), two()), /Write to .* did not run/],
    [verdict(one({ text: "Done." }), two()), /no offer with the note's phrase \("rollback note"\)/],
    [verdict(one(), two({ input: { decided: "Hotfixes matter." } })), /does not hold the person's words/],
    [verdict(one(), turn([init(), ok("Kept.")])), /calls: 0, accepted: 0/],
    [verdict(one(), undefined), /turn 2 did not run/],
    [verdict(one(), two(), { configDir: undefined }), /turn 1 wrote somewhere other than/], // with no config directory, no write is placed at the file
  ];
  for (const [v, re] of cases) {
    assert.equal(v.verdict, "FAIL", String(re));
    assert.match(v.notes.join(" "), re);
  }
});

// ---------------------------------------------------------------- through the row

// Turn 1 as the fake runs it: the Write lands in the session's memory directory, under its config directory.
const first = ({ hooks = true, extra = [], write = true, where = null } = {}) => (args) => {
  const cfg = args.options.env.CLAUDE_CONFIG_DIR;
  const file = where ? path.join(args.options.cwd, where) : path.join(cfg, "projects", MEMORY_HOOK_PROJECT_DIR, "memory", FILE);
  if (write) nodefs.writeFileSync(file, DECISION);
  return [init({ session_id: "m1" }), toolUse("w", "Write", { file_path: file, content: DECISION }), toolResult("w", "File created successfully"),
    ...(hooks ? postToolUse(file, cfg) : []), ...extra, assistantText(OFFER), result(0.1, { session_id: "m1", result: OFFER })];
};
const second = (input = WORDED) => [init({ session_id: "m1" }), toolUse("c", CAPTURE, input), toolResult("c", "Saved for your review"), result(0.25, { session_id: "m1", result: "Kept." })];

test("T1-memory-hook through the row: the memory directory is made, turn 1's one rule names the file there, the prompt names its path, the env names the project directory, turn 2 resumes: PASS", async () => {
  const b = box();
  const out = await run(b, b.argv(T1M), [first(), second()]);
  assert.equal(out.r.exitCode, 0, out.r.summary.notes.join(" "));
  assert.equal(out.r.summary.verdict, "PASS");
  assert.equal(out.client.calls.length, 2);
  const [a, c] = out.client.calls.map((x) => x.options);
  const dir = path.join(b.cfg, "projects", MEMORY_HOOK_PROJECT_DIR, "memory");
  const file = path.join(nodefs.realpathSync(dir), FILE);
  const writeRules = (o) => o.allowedTools.filter((t) => /^(Write|Edit|MultiEdit|NotebookEdit)\(/.test(t));
  assert.deepEqual(writeRules(a), [`Edit(${rulePath(file)})`]);
  assert.deepEqual(writeRules(c), []);
  assert.ok(!a.allowedTools.includes(CAPTURE) && c.allowedTools.includes(CAPTURE));
  for (const o of [a, c]) {
    assert.equal(o.includeHookEvents, true);
    assert.equal(o.env[PROJECT_DIR_VAR], MEMORY_HOOK_PROJECT_DIR);
    assert.equal(o.env[AUTO_MEMORY_VAR], "1");
    assert.equal(o.env.CLAUDE_CONFIG_DIR, b.cfg);
    assert.ok(o.tools.includes("Write") && o.tools.includes("Edit"));
  }
  assert.equal(c.resume, "m1");
  assert.equal(out.client.prompts[0].text, turnPrompt(DEF, DEF.turns[0], a.cwd, b.cfg));
  assert.ok(out.client.prompts[0].text.includes(path.join(dir, FILE)));
  assert.equal(out.client.prompts[1].text, DEF.turns[1].prompt);
  assert.deepEqual(nodefs.readdirSync(dir), [FILE]);
  assert.deepEqual(nodefs.readdirSync(a.cwd), []);
  assert.equal(out.r.summary.memoryProbe, undefined); // no seed and no probe: auto memory is off
  assert.ok(b.summary().hookEvents[0].events.some((e) => e.hook_event === "PostToolUse" && e.subtype === "hook_response"));
  assert.equal(b.calls().length, 2);
});

test("T1-memory-hook through the row: no PostToolUse event is FAIL, exit 1, after both turns; a start with no steer is INCONCLUSIVE", async () => {
  const b = box();
  const quiet = await run(b, b.argv(T1M), [first({ hooks: false }), second()]);
  assert.equal(quiet.client.calls.length, 2);
  assert.equal(quiet.r.exitCode, 1);
  assert.equal(quiet.r.summary.verdict, "FAIL");
  assert.ok(quiet.r.summary.notes.includes(NO_POST_TOOL_USE_NOTE));
  const c = box();
  const started = await run(c, c.argv(T1M), [first({ hooks: false, extra: [hook("hook_started", "PostToolUse")] }), second()]);
  assert.equal(started.r.exitCode, 1);
  assert.equal(started.r.summary.verdict, INCONCLUSIVE);
  assert.ok(started.r.summary.notes.includes(MEMORY_STEER_NOT_SEEN_NOTE));
});

test("T1-memory-hook through the row: a write in the working directory, a capture in turn 1 or a stray memory file fails it, and the first two spend no turn 2", async () => {
  for (const [script, re] of [
    [first({ where: FILE, write: false }), /turn 1 wrote somewhere other than/],
    [first({ extra: [toolUse("c0", CAPTURE, WORDED)] }), /captured before confirmation/],
  ]) {
    const b = box();
    const out = await run(b, b.argv(T1M), [script, second()]);
    assert.equal(out.client.calls.length, 1, String(re));
    assert.equal(out.r.exitCode, 1, String(re));
    assert.equal(out.r.summary.verdict, "FAIL", String(re));
    assert.match(out.r.summary.notes.join(" "), re);
  }
  const b = box();
  const stray = (args) => { nodefs.writeFileSync(path.join(args.options.env.CLAUDE_CONFIG_DIR, "projects", MEMORY_HOOK_PROJECT_DIR, "memory", "MEMORY.md"), "x"); return second(); };
  const out = await run(b, b.argv(T1M), [first(), stray]);
  assert.equal(out.r.exitCode, 1);
  assert.equal(out.r.summary.verdict, "FAIL");
  assert.match(out.r.summary.notes.join(" "), /files written in the memory directory besides .*: MEMORY\.md/);
});

test("T1-memory-hook through the row: a memory directory whose real path is elsewhere refuses before any call, exit 2, with nothing reserved", async () => {
  const b = box();
  const tail = `${path.sep}memory`;
  const fs = { ...nodefs, realpathSync: (p) => { const r = nodefs.realpathSync(p); return r.endsWith(tail) ? path.join(path.dirname(r), "elsewhere") : r; } };
  const out = await run(b, b.argv(T1M), [first(), second()], { fs });
  assert.equal(out.r.exitCode, 2);
  assert.equal(out.r.refused, true);
  assert.ok(out.d.io.errors.some((e) => /^refused: the row's memory directory resolves elsewhere \(a symlink or a short name\).*the row was not run$/.test(e)), out.d.io.errors.join("\n"));
  assert.equal(out.client.calls.length, 0);
  assert.deepEqual(b.recordLines().filter((l) => l.type === "reserve"), []);
  assert.equal(b.charged(), 0);
});

// ---------------------------------------------------------------- dry run

test("--dry-run: T1-memory-hook on its own line, with the memory directory, the one write and the stricter hook reading", async () => {
  const b = box();
  const d = b.deps();
  assert.equal((await main({ argv: ["--dry-run", "--row", T1M], env: DRY_ENV, ...d })).exitCode, 0);
  const line = `would run T1-memory-hook: 2 turn(s), caps 6/5, one command and one session; offer phrase "rollback note"; Write and Edit shown, and one rule allows a write to ${FILE} ` +
    `in the memory directory (projects/${MEMORY_HOOK_PROJECT_DIR}/memory under --config-dir, auto memory off) on turn 1 only; every other write is denied and fails the row` +
    "; hook events recorded (includeHookEvents) and read by the verdict; no PostToolUse event after the Write is FAIL, and one without the memory steer is INCONCLUSIVE";
  assert.ok(d.io.lines.includes(line), d.io.lines.join("\n"));
});
