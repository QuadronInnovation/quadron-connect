// T1-auto-memory-hook: the hook row with auto memory on whose turn 1 asks for no write, so any memory file is
// Claude Code's own save. Its row shape and prompts, its directory rule and env, its verdict on collected turns,
// the row run through main with the fake client, and the topic file's path checked against the plugin's own
// memory trigger.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodefs from "node:fs";
import path from "node:path";
import { main } from "../lib/main.mjs";
import { AUTO_MEMORY_ON, AUTO_MEMORY_VAR, PROJECT_DIR_VAR, assertAutoMemory, buildChildEnv } from "../lib/guards.mjs";
import {
  ROWS, HOOK_ROW_NAMES, AUTO_MEMORY_ROW_NAMES, AUTO_MEMORY_HOOK_PROJECT_DIR, MEMORY_RULE_PATTERN, T1_AUTO_MEMORY_HOOK_OFFER_PHRASE,
  T1_AUTO_MEMORY_HOOK_WORDS, T1_HOOK_STEER, T1_MEMORY_HOOK_STEER, WRITE_PATH_PLACEHOLDER,
  autoMemoryWriteDir, hookWriteRule, ownMemoryChangePrefix, rulePath, showsWrites, turnPrompt, turnTools, writesMemory,
} from "../lib/rows.mjs";
import {
  INCONCLUSIVE, INDEX_ONLY_NOTE, MEMORY_NOT_SAVED_NOTE, MEMORY_NO_TOOL_NOTE, MEMORY_STEER_NOT_SEEN_NOTE, MEMORY_WRITE_DENIED_NOTE,
  OWN_SAVE_NO_HOOK_NOTE, VERDICTS, collect,
} from "../lib/verdicts.mjs";
import { classifyPrompt } from "../../../plugins/claude-code/hooks/scripts/prompt-trigger.mjs";
import { decide as memoryDecide } from "../../../plugins/claude-code/hooks/scripts/memory-trigger.mjs";
import { box, fakeClient, liveEnv, init, result, toolUse, toolResult, assistantText, CAPTURE } from "./helpers.mjs";

const [, T1H, , T1M, T1AM] = HOOK_ROW_NAMES;
const DEF = ROWS[T1AM];
const NAME = AUTO_MEMORY_HOOK_PROJECT_DIR;
const DRY_ENV = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };
// What a save by auto memory might hold, the offer turn 1 should make, and turn 2's capture input.
const SAVED = "The person's standard: every schema change ships with a tested down-migration.";
const OFFER = "Want me to keep it in Quadron: every schema change ships with a tested down-migration?";
const WORDED = { decided: "Every schema change ships with a tested down-migration.", capture_type: "standard" };
const TOPIC = "schema-change-standard.md";
const CWD = path.resolve("/w/cwd");
const CFG = path.resolve("/w/cfg");
const DIR = path.join(CFG, "projects", NAME, "memory");
const TARGET = path.join(DIR, TOPIC);
const INDEX = path.join(DIR, "MEMORY.md");
const PREFIX = ownMemoryChangePrefix(DEF);
// The row's command: the shared argv plus the row's own settings file.
const argvOf = (b, extra = []) => b.argv(T1AM, {}, ["--auto-memory-settings", b.autoMemorySettings, ...extra]);

const run = (b, argv, scripts, over = {}, env = liveEnv()) => {
  const client = fakeClient(scripts);
  const d = b.deps(over);
  return main({ argv, env: { ...b.campaign, ...env }, client, ...d }).then((r) => ({ r, client, d }));
};
const hook = (subtype, hook_event, extra = {}) => ({ type: "system", subtype, hook_id: `id-${hook_event}`, hook_name: `${hook_event}:x`, hook_event, uuid: "u", session_id: "s", ...extra });
const said = (event, text) => [hook("hook_started", event), hook("hook_response", event, { output: text, stdout: text })];
// A save's input as the tool takes it: Write carries the whole text, Edit the new string.
const inputOf = (tool, file) => (tool === "Edit" ? { file_path: file, old_string: "", new_string: SAVED } : { file_path: file, content: SAVED });
// What the memory trigger prints for a save to `file`, from the plugin script itself, as the hook sees it:
// CLAUDE_CONFIG_DIR in its environment and the session's transcript under the same config directory.
const trigger = (file, tool = "Write", cfg = CFG) => memoryDecide(
  { hook_event_name: "PostToolUse", tool_name: tool, transcript_path: path.join(cfg, "projects", NAME, "s.jsonl"), tool_input: inputOf(tool, file) },
  { CLAUDE_CONFIG_DIR: cfg },
);
const postToolUse = (file = TARGET, tool = "Write", cfg = CFG) => said("PostToolUse", trigger(file, tool, cfg).stdout);
const turn = (msgs) => collect(msgs, msgs);
const ok = (text = "ok", o = {}) => result(0.1, { result: text, ...o });

// One save: the call and its result, which says denied when `denied`.
const save = ({ tool = "Write", file = TARGET, id = "w", denied = false } = {}) => [
  toolUse(id, tool, inputOf(tool, file)),
  toolResult(id, denied ? `Permission to use ${tool} has been denied.` : "File created successfully", denied),
];
const one = ({ saves = [save()], hooks = postToolUse(), extra = [], text = OFFER } = {}) => turn([
  init({ session_id: "m1" }), ...saves.flat(), ...hooks, ...extra, assistantText(text), ok(text, { session_id: "m1" }),
]);
const two = ({ input = WORDED, extra = [] } = {}) => turn([init({ session_id: "m1" }), ...extra, toolUse("c", CAPTURE, input), toolResult("c", "Saved for your review"), ok("Kept.", { session_id: "m1" })]);
// By default the memory directory's change on disk is the topic file the save wrote.
const verdict = (a, b, ctx = {}) => VERDICTS[T1AM]([a, b], { cwd: CWD, configDir: CFG, filesWrittenAll: [], memoryChanges: [`${PREFIX}${TOPIC}`], ...ctx });

// ---------------------------------------------------------------- the row itself

test("T1-auto-memory-hook: a hook row with auto memory on, the memory directory's one rule, no file of its own, T1-memory-hook's turn shape", () => {
  assert.equal(T1AM, "T1-auto-memory-hook");
  assert.equal(HOOK_ROW_NAMES[HOOK_ROW_NAMES.length - 1], T1AM);
  assert.ok(AUTO_MEMORY_ROW_NAMES.includes(T1AM));
  assert.equal(DEF.connector, true);
  assert.equal(DEF.cwd, "empty");
  assert.equal(DEF.hookEvents, true);
  assert.equal(DEF.autoMemory, true);
  assert.equal(DEF.autoMemoryWrites, true);
  for (const k of ["hookWriteTarget", "hookWriteDir", "observeWrites", "noPlugin"]) assert.equal(DEF[k], undefined, k);
  assert.equal(DEF.projectDirName, NAME);
  assert.equal(DEF.offerPhrase, T1_AUTO_MEMORY_HOOK_OFFER_PHRASE);
  assert.deepEqual(DEF.turns.map((t) => Boolean(t.allowWrite)), [true, false]);
  assert.deepEqual(DEF.turns.map((t) => t.maxTurns), ROWS[T1M].turns.map((t) => t.maxTurns)); // the same caps
  assert.deepEqual(DEF.turns.map((t) => t.tools), ROWS[T1M].turns.map((t) => t.tools));
  assert.deepEqual(turnTools(DEF, DEF.turns[0]), ["Skill", "ToolSearch", "Write", "Edit"]);
  assert.equal(showsWrites(DEF), true);
  assert.equal(writesMemory(DEF), false); // no file of its own: that is the hookWriteDir row
  assert.ok(!DEF.turns.some((t) => t.probe)); // no seed, so no probe
});

test("T1-auto-memory-hook: the prompts trip neither prompt trigger, turn 1 names no file, path, tool, Quadron or project, turn 2 holds the person's words", () => {
  const sent = DEF.turns.map((t) => turnPrompt(DEF, t, CWD, CFG));
  for (const p of sent) assert.deepEqual(classifyPrompt(p), { recall: false, capture: false }, p);
  // Sent as written: neither prompt has a path placeholder.
  for (const [i, t] of DEF.turns.entries()) {
    assert.ok(!t.prompt.includes(WRITE_PATH_PLACEHOLDER));
    assert.equal(sent[i], t.prompt);
  }
  const first = DEF.turns[0].prompt;
  for (const cue of [/\bfile\b/i, /\bpath\b/i, /[\\/]/, /\.md\b/i, /\bwrite\b/i, /quadron/i, /\bquad/i, /project/i]) assert.doesNotMatch(first, cue);
  assert.match(first, /^Remember for next time: /);
  assert.ok(first.includes(T1_AUTO_MEMORY_HOOK_OFFER_PHRASE));
  assert.ok(sent[1].toLowerCase().includes(T1_AUTO_MEMORY_HOOK_WORDS));
});

test("T1-auto-memory-hook: a topic file in the memory directory is one the plugin's memory trigger answers with the memory steer, MEMORY.md is not", () => {
  assert.equal(autoMemoryWriteDir(DEF, CFG), DIR);
  for (const tool of ["Write", "Edit"]) {
    const r = trigger(TARGET, tool);
    assert.equal(r.exitCode, 0);
    const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.ok(context.startsWith(T1_MEMORY_HOOK_STEER), context);
  }
  // The index file is skipped by design, which is why a save to it alone is INCONCLUSIVE.
  assert.equal(trigger(INDEX).stdout, "");
  // Another config directory's memory is not this session's: silent.
  assert.equal(trigger(TARGET, "Write", path.resolve("/w/other")).stdout, "");
});

// ---------------------------------------------------------------- the write rule, the env and the guards

test("T1-auto-memory-hook's write rule: turn 1 alone, one Edit rule for the memory directory's .md files; no config directory or a pattern character refuses", () => {
  assert.equal(MEMORY_RULE_PATTERN, "*.md");
  assert.equal(hookWriteRule(DEF, DEF.turns[0], "/tmp/x", null, "/tmp/cfg"), `Edit(//tmp/cfg/projects/${NAME}/memory/*.md)`);
  assert.equal(hookWriteRule(DEF, DEF.turns[1], "/tmp/x", null, "/tmp/cfg"), null);
  assert.throws(() => hookWriteRule(DEF, DEF.turns[0], "/tmp/x"), /needs the config directory/);
  assert.throws(() => hookWriteRule(DEF, DEF.turns[0], "/tmp/x", null, "/tmp/c*g"), /reads as a pattern/);
  // The real path: the memory directory's own, or the row refuses.
  const dir = path.resolve("/srv/cfg/projects", NAME, "memory");
  const pathFs = (map) => ({ realpathSync: (p) => { if (p in map) return map[p]; throw new Error("ENOENT"); } });
  assert.equal(hookWriteRule(DEF, DEF.turns[0], "/srv/cwd", pathFs({ [dir]: dir }), path.resolve("/srv/cfg")), `Edit(${rulePath(dir)}/*.md)`);
  assert.throws(() => hookWriteRule(DEF, DEF.turns[0], "/srv/cwd", pathFs({ [dir]: "/data/memory" }), path.resolve("/srv/cfg")), /memory directory resolves elsewhere \(a symlink or a short name\).*the row was not run/);
});

test("autoMemoryWriteDir: the session's own memory directory on this row, null on any other, and a refusal for each combination the flag does not allow", () => {
  assert.equal(autoMemoryWriteDir(DEF, "/tmp/cfg"), path.join("/tmp/cfg", "projects", NAME, "memory"));
  assert.equal(autoMemoryWriteDir(ROWS[T1M], "/tmp/cfg"), null);
  assert.equal(autoMemoryWriteDir(ROWS[T1H], "/tmp/cfg"), null);
  for (const bad of [{ autoMemory: false }, { hookEvents: false }, { cwd: "plugin" }, { projectDirName: "a/b" }, { projectDirName: undefined }, { hookWriteTarget: "note.md" }, { hookWriteDir: "memory" }, { observeWrites: true }]) {
    assert.throws(() => autoMemoryWriteDir({ ...DEF, ...bad }, "/tmp/cfg"), /autoMemoryWrites needs/, JSON.stringify(bad));
    assert.throws(() => hookWriteRule({ ...DEF, ...bad }, DEF.turns[0], "/tmp/x", null, "/tmp/cfg"), /autoMemoryWrites needs/, JSON.stringify(bad));
  }
  assert.throws(() => autoMemoryWriteDir(DEF, undefined), /needs the config directory/);
  // A change inside that directory, as live.mjs labels it.
  assert.equal(ownMemoryChangePrefix(DEF), `config-dir/projects/${NAME}/memory/`);
  assert.equal(ownMemoryChangePrefix(ROWS[T1M]), null);
});

test("the child env: auto memory on with the row's project directory name; the guard holds both", () => {
  const env = buildChildEnv({}, { configDir: "/c", homeDir: "/h", maxOutputTokens: 1, autoMemory: true, projectDirName: NAME });
  assert.equal(env[PROJECT_DIR_VAR], NAME);
  assert.equal(env[AUTO_MEMORY_VAR], AUTO_MEMORY_ON);
  assert.notEqual(AUTO_MEMORY_ON, "1"); // "1" is off
  assert.equal(env.CLAUDE_CONFIG_DIR, "/c");
  assert.doesNotThrow(() => assertAutoMemory({ env }, true, NAME));
  assert.throws(() => assertAutoMemory({ env }, true, "another"), /must be the row's project directory name/);
  assert.throws(() => assertAutoMemory({ env: { ...env, [AUTO_MEMORY_VAR]: "1" } }, true, NAME), /on an autoMemory row/);
});

// ---------------------------------------------------------------- on the verdict

test("T1-auto-memory-hook PASS: a Write or an Edit to a topic file ran, a PostToolUse hook_started and the memory steer in its hook_response after it, one offer, no capture; turn 2 one accepted capture with the person's words", () => {
  for (const tool of ["Write", "Edit"]) {
    const v = verdict(one({ saves: [save({ tool })], hooks: postToolUse(TARGET, tool) }), two());
    assert.equal(v.verdict, "PASS", `${tool}: ${v.notes.join(" ")}`);
    assert.ok(v.notes.includes("PostToolUse after the save: hook_started seen, memory steer in a hook_response seen"), v.notes.join(" "));
    assert.ok(v.notes.includes(`memory files written by a file tool in turn 1: ${tool} ${TOPIC}`), v.notes.join(" "));
    assert.ok(v.notes.includes(`memory directory changes on disk after turn 1: ${TOPIC}`), v.notes.join(" "));
  }
  // The person's words in any case, anywhere in the input.
  assert.equal(verdict(one(), two({ input: { body: { text: "Every schema change: TESTED DOWN-MIGRATION first" } } })).verdict, "PASS");
  // MEMORY.md saved too, ahead of the topic file: the hook is read after the topic file.
  const both = verdict(one({ saves: [save({ file: INDEX, id: "i" }), save()] }), two(), { memoryChanges: [`${PREFIX}MEMORY.md`, `${PREFIX}${TOPIC}`] });
  assert.equal(both.verdict, "PASS", both.notes.join(" "));
  // A change on disk no file tool call names is noted, and does not stop a pass.
  const extra = verdict(one(), two(), { memoryChanges: [`${PREFIX}${TOPIC}`, `${PREFIX}other.md`] });
  assert.equal(extra.verdict, "PASS", extra.notes.join(" "));
  assert.ok(extra.notes.some((n) => n.startsWith(MEMORY_NO_TOOL_NOTE) && n.endsWith("(other.md)")), extra.notes.join(" "));
});

test("T1-auto-memory-hook INCONCLUSIVE: no save by a file tool, only MEMORY.md, or a memory change with no file tool call, each with its own note", () => {
  const cases = [
    [verdict(one({ saves: [], hooks: [], text: "Noted." }), two(), { memoryChanges: [] }), MEMORY_NOT_SAVED_NOTE],
    // The offer does not change it: with no save the hook had nothing to answer.
    [verdict(one({ saves: [], hooks: [] }), two(), { memoryChanges: [] }), MEMORY_NOT_SAVED_NOTE],
    [verdict(one({ saves: [save({ file: INDEX })], hooks: postToolUse(INDEX) }), two(), { memoryChanges: [`${PREFIX}MEMORY.md`] }), INDEX_ONLY_NOTE],
    [verdict(one({ saves: [], hooks: [] }), two()), MEMORY_NO_TOOL_NOTE],
  ];
  for (const [v, note] of cases) {
    assert.equal(v.verdict, INCONCLUSIVE, v.notes.join(" "));
    assert.equal(v.notes[0], note);
  }
  // A denied save to the memory directory is not a write elsewhere: noted, and still the model's choice.
  const denied = verdict(one({ saves: [save({ denied: true })], hooks: [] }), two(), { memoryChanges: [] });
  assert.equal(denied.verdict, INCONCLUSIVE, denied.notes.join(" "));
  assert.equal(denied.notes[0], MEMORY_NOT_SAVED_NOTE);
  assert.ok(denied.notes.includes(MEMORY_WRITE_DENIED_NOTE));
  assert.ok(!verdict(one(), two()).notes.includes(MEMORY_WRITE_DENIED_NOTE));
});

test("T1-auto-memory-hook INCONCLUSIVE: a PostToolUse event after the save without both the start and the memory steer in a hook_response; no offer then is not a failure", () => {
  for (const hooks of [
    [hook("hook_started", "PostToolUse")],
    [hook("hook_started", "PostToolUse"), hook("hook_response", "PostToolUse", { outcome: "success" })],
    [hook("hook_response", "PostToolUse", { output: `${T1_MEMORY_HOOK_STEER} "x"` })], // answered, never seen to start
    said("PostToolUse", `${T1_HOOK_STEER} "x"`), // the instructions-file steer is the wrong one for a memory file
    [hook("hook_started", "PostToolUse"), hook("hook_response", "UserPromptSubmit", { output: `${T1_MEMORY_HOOK_STEER} "x"` })],
  ]) {
    for (const text of [OFFER, "Noted."]) {
      const v = verdict(one({ hooks, text }), two());
      assert.equal(v.verdict, INCONCLUSIVE, `${text} ${JSON.stringify(hooks)}`);
      assert.equal(v.notes[0], MEMORY_STEER_NOT_SEEN_NOTE);
    }
  }
});

test("T1-auto-memory-hook FAIL: a save that ran with no PostToolUse event after it is the finding; one before the save, or another event, does not count", () => {
  const before = turn([init({ session_id: "m1" }), ...postToolUse(), ...save(), assistantText(OFFER), ok(OFFER, { session_id: "m1" })]);
  for (const a of [one({ hooks: [] }), one({ hooks: said("UserPromptSubmit", "x") }), one({ hooks: [], text: "Noted." }), before]) {
    const v = verdict(a, two());
    assert.equal(v.verdict, "FAIL");
    assert.ok(v.notes.includes(OWN_SAVE_NO_HOOK_NOTE), v.notes.join(" "));
  }
});

test("T1-auto-memory-hook FAIL: a capture in turn 1, a write outside the memory directory's .md files, a memory change elsewhere, a stray file, no offer once the steer was seen, and turn 2", () => {
  const outside = (file, denied = false) => verdict(one({ saves: [save({ file, denied })], hooks: [] }), two(), { memoryChanges: [] });
  const cases = [
    [verdict(one({ extra: [toolUse("c0", CAPTURE, WORDED), toolResult("c0", "Saved")] }), two()), /captured before confirmation/],
    [verdict(one({ saves: [], hooks: [], extra: [toolUse("c0", CAPTURE, WORDED)] }), two(), { memoryChanges: [] }), /captured before confirmation/],
    [verdict(one({ extra: [toolUse("e", "Edit", { file_path: path.join(CWD, "CLAUDE.md") })] }), two()), /turn 1 wrote outside the memory directory's \.md files: Edit /],
    [verdict(one(), two(), { memoryChanges: [`${PREFIX}${TOPIC}`, "home/CLAUDE.md"] }), /changed outside the session's memory directory: home\/CLAUDE\.md/],
    [verdict(one(), two(), { filesWrittenAll: ["stray.txt"] }), /files written in the working directory: stray\.txt/],
    [verdict(one({ text: "Done." }), two()), /turn 1 made no offer with the stated phrase \("down-migration"\)/],
    [verdict(one(), two({ extra: [toolUse("w2", "Write", { file_path: TARGET, content: SAVED })] })), /turn 2 wrote: Write/],
    [verdict(one(), turn([init(), ok("Kept.")])), /calls: 0, accepted: 0/],
    [verdict(one(), turn([init({ session_id: "m1" }), toolUse("c", CAPTURE, WORDED), toolResult("c", "Saved"), toolUse("d", CAPTURE, WORDED), toolResult("d", "Saved"), ok("Kept.")])), /calls: 2, accepted: 2/],
    [verdict(one(), two({ input: { decided: "Schema changes matter." } })), /does not hold the person's words \("tested down-migration"\)/],
    [verdict(one(), two({ extra: [toolUse("q", "mcp__quadron__quad_commit", WORDED), toolResult("q", "Saved")] })), /turn 2 attempted another capture tool: mcp__quadron__quad_commit/],
    [verdict(one(), undefined), /turn 2 did not run/],
    // With no config directory nothing is placed in the memory directory, so every write is one elsewhere.
    [verdict(one(), two(), { configDir: undefined }), /turn 1 wrote outside the memory directory's \.md files/],
  ];
  // A file in the working directory, another project's memory directory, a non-.md file in the directory and a
  // .md file below it: each fails, denied or not.
  for (const file of [path.join(CWD, "notes.md"), path.join(CFG, "projects", "another", "memory", TOPIC), path.join(DIR, "notes.txt"), path.join(DIR, "sub", TOPIC)]) {
    cases.push([outside(file), /turn 1 wrote outside the memory directory's \.md files: Write /]);
    cases.push([outside(file, true), /turn 1 wrote outside the memory directory's \.md files: Write .*\(denied\)/]);
  }
  for (const [v, re] of cases) {
    assert.equal(v.verdict, "FAIL", String(re));
    assert.match(v.notes.join(" "), re);
  }
});

// ---------------------------------------------------------------- through the row

const memDir = (args) => path.join(args.options.env.CLAUDE_CONFIG_DIR, "projects", NAME, "memory");
// Turn 1 as the fake runs it: auto memory saves a topic file in the session's memory directory, for real, so the
// snapshot sees it. `where`, a name in the working directory instead; `seen` gets the directory's entries first.
const first = ({ hooks = true, write = true, where = null, extra = [], text = OFFER, seen = null } = {}) => (args) => {
  const dir = memDir(args);
  if (seen) seen.push(nodefs.existsSync(dir) ? nodefs.readdirSync(dir) : null);
  const file = where ? path.join(args.options.cwd, where) : path.join(dir, TOPIC);
  if (write) nodefs.writeFileSync(file, SAVED);
  return [init({ session_id: "m1" }), toolUse("w", "Write", { file_path: file, content: SAVED }), toolResult("w", "File created successfully"),
    ...(hooks ? postToolUse(file, "Write", args.options.env.CLAUDE_CONFIG_DIR) : []), ...extra, assistantText(text), result(0.1, { session_id: "m1", result: text })];
};
// Turn 1 with no save at all.
const noSave = () => [init({ session_id: "m1" }), assistantText("Noted."), result(0.1, { session_id: "m1", result: "Noted." })];
const second = (input = WORDED) => [init({ session_id: "m1" }), toolUse("c", CAPTURE, input), toolResult("c", "Saved for your review"), result(0.25, { session_id: "m1", result: "Kept." })];
const writeRules = (o) => o.allowedTools.filter((t) => /^(Write|Edit|MultiEdit|NotebookEdit)\(/.test(t));

test("T1-auto-memory-hook through the row: the memory directory is made empty with no seed, turn 1's one rule names its .md files, auto memory is on from the row's settings, turn 2 resumes: PASS", async () => {
  const b = box();
  const seen = [];
  const out = await run(b, argvOf(b), [first({ seen }), second()]);
  assert.equal(out.r.exitCode, 0, out.r.summary.notes.join(" "));
  assert.equal(out.r.summary.verdict, "PASS");
  assert.equal(out.client.calls.length, 2);
  const [a, c] = out.client.calls.map((x) => x.options);
  const dir = path.join(b.cfg, "projects", NAME, "memory");
  assert.deepEqual(seen, [[]]); // made, and empty, before the call: no MEMORY.md seed
  assert.deepEqual(writeRules(a), [`Edit(${rulePath(nodefs.realpathSync(dir))}/*.md)`]);
  assert.deepEqual(writeRules(c), []);
  assert.ok(!a.allowedTools.includes(CAPTURE) && c.allowedTools.includes(CAPTURE));
  for (const o of [a, c]) {
    assert.equal(o.includeHookEvents, true);
    assert.equal(o.env[PROJECT_DIR_VAR], NAME);
    assert.equal(o.env[AUTO_MEMORY_VAR], AUTO_MEMORY_ON);
    assert.equal(o.env.CLAUDE_CONFIG_DIR, b.cfg);
    assert.equal(o.settings, b.autoMemorySettings);
    assert.ok(o.tools.includes("Write") && o.tools.includes("Edit"));
  }
  assert.equal(c.resume, "m1");
  assert.equal(out.client.prompts[0].text, DEF.turns[0].prompt);
  assert.equal(out.client.prompts[1].text, DEF.turns[1].prompt);
  assert.deepEqual(nodefs.readdirSync(dir), [TOPIC]);
  assert.deepEqual(nodefs.readdirSync(a.cwd), []);
  assert.equal(out.r.summary.memoryProbe, undefined); // nothing seeded and no probe
  assert.ok(out.r.summary.notes.includes(`memory directory changes on disk after turn 1: ${TOPIC}`), out.r.summary.notes.join(" "));
  assert.ok(b.summary().hookEvents[0].events.some((e) => e.hook_event === "PostToolUse" && e.subtype === "hook_response"));
  assert.equal(b.calls().length, 2);
});

test("T1-auto-memory-hook through the row: no save is INCONCLUSIVE and turn 2 still runs; a save with no hook is FAIL with the finding; both exit 1", async () => {
  const b = box();
  const quiet = await run(b, argvOf(b), [noSave, second()]);
  assert.equal(quiet.client.calls.length, 2);
  assert.equal(quiet.r.exitCode, 1);
  assert.equal(quiet.r.summary.verdict, INCONCLUSIVE, quiet.r.summary.notes.join(" "));
  assert.ok(quiet.r.summary.notes.includes(MEMORY_NOT_SAVED_NOTE));
  const c = box();
  const silent = await run(c, argvOf(c), [first({ hooks: false }), second()]);
  assert.equal(silent.client.calls.length, 2);
  assert.equal(silent.r.exitCode, 1);
  assert.equal(silent.r.summary.verdict, "FAIL");
  assert.ok(silent.r.summary.notes.includes(OWN_SAVE_NO_HOOK_NOTE), silent.r.summary.notes.join(" "));
});

test("T1-auto-memory-hook through the row: a write in the working directory fails it and spends no turn 2", async () => {
  const b = box();
  const out = await run(b, argvOf(b), [first({ where: "notes.md", write: false, hooks: false }), second()]);
  assert.equal(out.client.calls.length, 1);
  assert.equal(out.r.exitCode, 1);
  assert.equal(out.r.summary.verdict, "FAIL");
  assert.match(out.r.summary.notes.join(" "), /turn 1 wrote outside the memory directory's \.md files: Write .*\(denied\)/);
});

test("T1-auto-memory-hook through the row: no --auto-memory-settings, or a memory directory whose real path is elsewhere, refuses before any call, exit 2", async () => {
  const a = box();
  const absent = await run(a, a.argv(T1AM), [first(), second()]);
  assert.equal(absent.r.exitCode, 2);
  assert.equal(absent.client.calls.length, 0);
  assert.match(absent.d.io.errors.join(" "), /--auto-memory-settings is required for T1-auto-memory-hook/);
  const b = box();
  const tail = `${path.sep}memory`;
  const fs = { ...nodefs, realpathSync: (p) => { const r = nodefs.realpathSync(p); return r.endsWith(tail) ? path.join(path.dirname(r), "elsewhere") : r; } };
  const out = await run(b, argvOf(b), [first(), second()], { fs });
  assert.equal(out.r.exitCode, 2);
  assert.equal(out.r.refused, true);
  assert.ok(out.d.io.errors.some((e) => /^refused: the row's memory directory resolves elsewhere \(a symlink or a short name\).*the row was not run$/.test(e)), out.d.io.errors.join("\n"));
  assert.equal(out.client.calls.length, 0);
  assert.deepEqual(b.recordLines().filter((l) => l.type === "reserve"), []);
  assert.equal(b.charged(), 0);
});

// ---------------------------------------------------------------- dry run

test("--dry-run: T1-auto-memory-hook on its own line, with the directory rule, auto memory on with nothing seeded, and its hook reading", async () => {
  const b = box();
  const d = b.deps();
  assert.equal((await main({ argv: ["--dry-run", "--row", T1AM], env: DRY_ENV, ...d })).exitCode, 0);
  const line = `would run T1-auto-memory-hook: 2 turn(s), caps 6/5, one command and one session; offer phrase "down-migration"; ` +
    `Write and Edit shown, and one rule allows a write to any .md file directly in the memory directory (projects/${NAME}/memory under --config-dir) on turn 1 only, with no write asked for; every other write is denied and fails the row` +
    `; auto memory on, from --auto-memory-settings, project dir name ${NAME}, with the memory directory and CLAUDE.md watched` +
    "; nothing seeded and no probe; a change inside that memory directory is expected, and one anywhere else fails the row" +
    "; hook events recorded (includeHookEvents) and read by the verdict; no memory file saved by a Write or Edit call, only MEMORY.md, or a memory change with no file tool call is INCONCLUSIVE, " +
    "a save with no PostToolUse event after it is FAIL, and one without the memory steer is INCONCLUSIVE";
  assert.ok(d.io.lines.includes(line), d.io.lines.join("\n"));
});
