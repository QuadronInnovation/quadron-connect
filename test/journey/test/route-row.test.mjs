// ROUTE-1, the routing row: asked to save with no Quadron or project cue, the save goes to the capture
// tool and not to a file. Synthetic streams on the verdict, then the whole row through the fake client.
// Its variants (memory on and off, other save wordings) are at the end of the file.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodefs from "node:fs";
import { main, USAGE } from "../lib/main.mjs";
import path from "node:path";
import { AUTO_MEMORY_ON, AUTO_MEMORY_VAR, PROJECT_DIR_VAR, PROJECT_DIR_NAME_RE, DISALLOWED_TOOLS, OBSERVED_WRITE_TOOLS, assertAutoMemory, assertSessionOptions, buildChildEnv, checkSettingsDenyOnly, isMemoryPath, unexpectedInitTools } from "../lib/guards.mjs";
import { buildOptions } from "../lib/options.mjs";
import { ROWS, ROW_NAMES, AUTO_MEMORY_ROW_NAMES, ROUTE_ROW_NAMES, SESSION_ROW_NAMES, ROUTE_DECISION, CAPTURE_PLACEHOLDER, SEED_PREFIX, turnTools } from "../lib/rows.mjs";
import { changedEntries, memoryChangesBetween } from "../lib/live.mjs";
import { INCONCLUSIVE, MEMORY_OFF_NOTE, MEMORY_ON_EVIDENCE_NOTE, SEED_SALIENCE_NOTE, VERDICTS, collect, memoryProbeVerdict, verdictRoute1, verdictRoute1MemoryOff } from "../lib/verdicts.mjs";
import { box, fakeClient, liveEnv, init, result, toolUse, toolResult, assistantText, goodSettings, autoMemorySettings, SKILL, CAPTURE, T2_OK } from "./helpers.mjs";

const ROW = "ROUTE-1";
// The routing rows with auto memory on (ROUTE-1's shape) and off (one turn, no probe).
const ON_ROWS = ["ROUTE-1", "ROUTE-1-SAVE-ON", "ROUTE-1-REMEMBER-ON", "ROUTE-1-RECORD", "ROUTE-1-QUADRON"];
const OFF_ROWS = ["ROUTE-1-OFF", "ROUTE-1-SAVE-OFF", "ROUTE-1-REMEMBER-OFF"];
const COMMIT = "mcp__quadron__quad_commit";
const DECIDED = "We bill annually only; monthly plans are ruled out.";
const MEMORY_FILE = "/work/cwd/MEMORY.md";
const rec = (...msgs) => collect(msgs);
const ok = (text) => result(0.1, { result: text });
const captured = (id = "c1", name = CAPTURE) => [toolUse(id, name, { decided: DECIDED }), toolResult(id, "Saved to your inbox as Unfiled.")];
const run = (b, argv, scripts, over = {}, env = liveEnv()) => {
  const client = Array.isArray(scripts) ? fakeClient(scripts) : scripts;
  const d = b.deps(over);
  return main({ argv, env: { ...b.campaign, ...env }, client, ...d }).then((r) => ({ r, client, d }));
};
const lineOf = (out) => out.d.io.lines.find((l) => l.startsWith(`${ROW}: `));
// ROUTE-1's command: the shared argv plus the row's own settings file.
const routeArgv = (b, extra = []) => b.argv(ROW, {}, ["--auto-memory-settings", b.autoMemorySettings, ...extra]);
const capturedRow = () => [init(), SKILL(), ...captured(), ok("Saved.")];
// Turn 2, the memory-on probe. Its init lists only connector names: the turn asks for no built-in tool.
const SEED_FILE = (args) => path.join(args.options.env.CLAUDE_CONFIG_DIR, "projects", args.options.env[PROJECT_DIR_VAR], "memory", "MEMORY.md");
const codeIn = (args) => /QX-[0-9a-f]{8}/.exec(nodefs.readFileSync(SEED_FILE(args), "utf8"))?.[0] ?? "none";
const probeInit = () => init({ tools: ["mcp__quadron__quad_context", CAPTURE] });
const echo = (args) => [probeInit(), result(0.12, { result: codeIn(args) })];
const silent = () => [probeInit(), result(0.12, { result: "I have no reference code." })];

// ---------------------------------------------------------------- the row

test("ROUTE-1 row: a connector turn in a new empty directory, a save request with no Quadron, project or record cue, then a no-tool probe", () => {
  const def = ROWS[ROW];
  assert.equal(def.connector, true);
  assert.equal(def.cwd, "empty");
  assert.equal(def.observeWrites, true);
  assert.equal(def.projectDirName, "route1");
  assert.equal(def.turns.length, 2);
  assert.deepEqual(def.turns[1], { probe: true, maxTurns: 1, tools: [], prompt: "Reply with the reference code from your memory, nothing else." });
  assert.deepEqual(turnTools(def, def.turns[1]), []);
  assert.ok(!def.turns[0].probe);
  const { prompt, tools } = def.turns[0];
  for (const cue of [/quadron/i, /project/i, /\brecord\b/i]) assert.doesNotMatch(prompt, cue);
  assert.match(prompt, /save/i);
  assert.ok(!tools.includes(CAPTURE_PLACEHOLDER), "turn 1 has no earlier init to resolve the placeholder from");
  for (const t of ["Skill", "ToolSearch", "mcp__quadron__quad_context", CAPTURE, COMMIT]) assert.ok(tools.includes(t), t);
  for (const t of DISALLOWED_TOOLS) assert.ok(!tools.includes(t), `${t} is never on the allow-list`);
  assert.deepEqual(turnTools(def, def.turns[0]), ["Skill", "ToolSearch", ...OBSERVED_WRITE_TOOLS]);
  assert.equal(VERDICTS[ROW], verdictRoute1);
});

test("ROUTE-1 options: Write and Edit leave disallowedTools only on this row, never reach allowedTools, and the guard refuses one that does", () => {
  const base = { settingsPath: "/s.json", tools: ["Skill", "Write", "Edit"], allowedTools: ["Skill", CAPTURE] };
  const shown = buildOptions({ ...base, observeWrites: true });
  for (const t of OBSERVED_WRITE_TOOLS) assert.ok(!shown.disallowedTools.includes(t), t);
  for (const t of DISALLOWED_TOOLS.filter((n) => !OBSERVED_WRITE_TOOLS.includes(n))) assert.ok(shown.disallowedTools.includes(t), t);
  assert.ok(shown.disallowedTools.includes("Edit(//**/node_modules/@anthropic-ai/**)"));
  assert.doesNotThrow(() => assertSessionOptions(shown));
  assert.deepEqual(buildOptions(base).disallowedTools, DISALLOWED_TOOLS);
  for (const t of ["Write", "Edit", "Bash"]) {
    assert.throws(() => assertSessionOptions({ ...shown, allowedTools: ["Skill", t] }), /allowedTools must not name a disallowed tool/, t);
  }
});

test("ROUTE-1 init check: Write and Edit pass only when observed and in the turn's tools; other disallowed names never do", () => {
  const listed = ["Skill", "Write", "Edit", "Bash"];
  assert.deepEqual(unexpectedInitTools(listed, ["Skill", "Write", "Edit", "Bash"], [], [], OBSERVED_WRITE_TOOLS), ["Bash"]);
  assert.deepEqual(unexpectedInitTools(listed, ["Skill", "Write", "Edit"], [], [], []), ["Write", "Edit", "Bash"]);
  assert.deepEqual(unexpectedInitTools(listed, ["Skill"], [], [], OBSERVED_WRITE_TOOLS), ["Write", "Edit", "Bash"]);
});

test("changedEntries: added, changed and removed paths, by name", () => {
  assert.deepEqual(changedEntries([], []), []);
  assert.deepEqual(changedEntries(["a|1|1"], ["a|2|5", "notes/", "notes/m.md|3|4"]), ["a", "notes/", "notes/m.md"]);
  assert.deepEqual(changedEntries(["a|1|1"], []), ["a"]);
});

// ---------------------------------------------------------------- the verdict, on synthetic streams

test("ROUTE-1 verdict: one accepted call to the session's capture tool passes, and the notes name it", () => {
  const v = verdictRoute1([rec(init(), SKILL(), ...captured(), ok("Saved: we bill annually only."))]);
  assert.equal(v.verdict, "PASS", v.notes.join("; "));
  assert.ok(v.notes.includes(`capture tool: ${CAPTURE}`));
  assert.ok(v.notes.includes(`save route: ${CAPTURE}`));
  assert.ok(v.notes.includes("quad_name: not sent"));
  // quad_commit is the session's tool when init lists no future_you_capture.
  const commit = verdictRoute1([rec(init({ tools: ["Skill", COMMIT] }), ...captured("c1", COMMIT), ok("Saved."))]);
  assert.equal(commit.verdict, "PASS", commit.notes.join("; "));
  assert.ok(commit.notes.includes(`save route: ${COMMIT}`));
});

test("ROUTE-1 verdict: a Write to a memory or notes file fails and names Write and the path, denied or not, with or without a capture", () => {
  const write = (id = "w1") => [toolUse(id, "Write", { file_path: MEMORY_FILE, content: DECIDED }), toolResult(id, "File written.")];
  const alone = verdictRoute1([rec(init(), ...write(), ok("Filed. I'll remember that."))]);
  assert.equal(alone.verdict, "FAIL");
  assert.ok(alone.notes.includes(`wrong save route: Write ${MEMORY_FILE}`), alone.notes.join("; "));
  assert.ok(alone.notes.includes(`no ${CAPTURE} call`));
  assert.ok(alone.notes.includes(`save route: Write ${MEMORY_FILE}`));
  assert.ok(alone.notes.includes("answer claims a save: yes (a word match, read the evidence)"));
  const deniedWrite = verdictRoute1([rec(init(), toolUse("w1", "Write", { file_path: MEMORY_FILE }), toolResult("w1", "Permission to use Write has been denied.", true), ok("Filed."))]);
  assert.equal(deniedWrite.verdict, "FAIL");
  assert.ok(deniedWrite.notes.includes(`wrong save route: Write ${MEMORY_FILE} (denied)`), deniedWrite.notes.join("; "));
  const both = verdictRoute1([rec(init(), ...captured(), ...write(), toolUse("e1", "Edit", { file_path: "/work/cwd/notes.md" }), ok("Saved."))]);
  assert.equal(both.verdict, "FAIL");
  assert.ok(both.notes.includes(`wrong save route: Write ${MEMORY_FILE}; Edit /work/cwd/notes.md`), both.notes.join("; "));
  assert.ok(both.notes.includes(`save route: ${CAPTURE}; Write ${MEMORY_FILE}; Edit /work/cwd/notes.md`), both.notes.join("; "));
});

test("ROUTE-1 verdict: a file in the working directory fails and is named, even with an accepted capture and no file tool call", () => {
  const v = verdictRoute1([rec(init(), ...captured(), ok("Saved."))], { filesWritten: ["MEMORY.md"] });
  assert.equal(v.verdict, "FAIL");
  assert.ok(v.notes.includes("files written in the working directory: MEMORY.md"));
  assert.ok(v.notes.includes(`save route: ${CAPTURE}; file MEMORY.md`));
});

test("ROUTE-1 verdict: no tool call with an answer saying \"filed\" fails, and the notes say no route and a claimed save", () => {
  const v = verdictRoute1([rec(init(), assistantText("Filed."), ok("Filed. That's saved for next time."))]);
  assert.equal(v.verdict, "FAIL");
  assert.ok(v.notes.includes(`no ${CAPTURE} call`));
  assert.ok(v.notes.includes("save route: none"));
  assert.ok(v.notes.includes("answer claims a save: yes (a word match, read the evidence)"));
  const asked = verdictRoute1([rec(init(), ok("Which project should this go to?"))]);
  assert.equal(asked.verdict, "FAIL");
  assert.ok(asked.notes.includes("answer claims a save: no (a word match, read the evidence)"));
});

test("ROUTE-1 verdict: two captures fail, both accepted or one refused, and so does a call to the other capture tool", () => {
  const two = verdictRoute1([rec(init(), ...captured("c1"), ...captured("c2"), ok("Saved twice."))]);
  assert.equal(two.verdict, "FAIL");
  assert.ok(two.notes.includes(`${CAPTURE} calls: 2, accepted: 2 (expected 1 and 1)`), two.notes.join("; "));
  assert.ok(two.notes.includes(`save route: ${CAPTURE}; ${CAPTURE}`));
  const retried = verdictRoute1([rec(init(), toolUse("c1", CAPTURE, {}), toolResult("c1", "server error", true), ...captured("c2"), ok("Saved."))]);
  assert.equal(retried.verdict, "FAIL");
  assert.ok(retried.notes.includes(`${CAPTURE} calls: 2, accepted: 1 (expected 1 and 1)`), retried.notes.join("; "));
  const other = verdictRoute1([rec(init(), ...captured(), ...captured("c2", COMMIT), ok("Saved."))]);
  assert.equal(other.verdict, "FAIL");
  assert.ok(other.notes.includes(`another capture tool was called: ${COMMIT}`), other.notes.join("; "));
});

test("ROUTE-1 verdict: a capture reply reporting a failed write, a non-success result, or quad_context twice fails", () => {
  const failed = verdictRoute1([rec(init(), toolUse("c1", CAPTURE, {}), toolResult("c1", "It may or may not be in the record."), ok("Saved."))]);
  assert.equal(failed.verdict, "FAIL");
  assert.ok(failed.notes.includes(`save route: ${CAPTURE} (not accepted)`), failed.notes.join("; "));
  const capped = verdictRoute1([rec(init(), ...captured(), result(0.1, { subtype: "error_max_turns" }))]);
  assert.equal(capped.verdict, "FAIL");
  assert.ok(capped.notes.includes("result was error_max_turns"));
  const ctx = (id) => [toolUse(id, "mcp__quadron__quad_context"), toolResult(id, "ctx")];
  const twice = verdictRoute1([rec(init(), ...ctx("x1"), ...ctx("x2"), ...captured(), ok("Saved."))]);
  assert.equal(twice.verdict, "FAIL");
  assert.ok(twice.notes.some((n) => /quad_context called 2 times/.test(n)));
});

// ---------------------------------------------------------------- the whole row, fake client

test("ROUTE-1 through the row: Write and Edit in `tools`, not allowed and not disallowed; a capture passes with exit 0", async () => {
  const b = box();
  const out = await run(b, routeArgv(b), [[init({ tools: ["Skill", "Write", "Edit", CAPTURE, COMMIT] }), SKILL(), ...captured(), ok("Saved.")], echo]);
  assert.equal(out.r.exitCode, 0, out.d.io.lines.join("\n"));
  assert.equal(out.r.summary.verdict, "PASS");
  const [{ options }] = out.client.calls;
  assert.deepEqual(options.tools, ["Skill", "ToolSearch", "Write", "Edit"]);
  assert.deepEqual(options.allowedTools, ROWS[ROW].turns[0].tools);
  for (const t of OBSERVED_WRITE_TOOLS) assert.ok(!options.disallowedTools.includes(t), t);
  for (const t of ["MultiEdit", "NotebookEdit", "Bash", "PowerShell"]) assert.ok(options.disallowedTools.includes(t), t);
  assert.equal(lineOf(out), `${ROW}: PASS; call spend 0.1200 USD`);
  // Turn 2: the same session, no built-in tools, nothing allowed, maxTurns 1.
  const probeOptions = out.client.calls[1].options;
  assert.deepEqual([probeOptions.tools, probeOptions.allowedTools, probeOptions.maxTurns, probeOptions.resume], [[], [], 1, "s1"]);
  assert.equal(out.client.prompts[1].text, ROWS[ROW].turns[1].prompt);
  assert.ok(out.r.summary.notes.includes(`save route: ${CAPTURE}`));
});

test("ROUTE-1 through the row: a Write is denied by dontAsk, nothing is written, and the row fails naming it, exit 1", async () => {
  const b = box();
  const out = await run(b, routeArgv(b), [[init(), toolUse("w1", "Write", { file_path: MEMORY_FILE, content: DECIDED }), ok("Filed.")], silent]);
  assert.equal(out.r.exitCode, 1);
  assert.equal(out.r.summary.verdict, "FAIL");
  assert.deepEqual(out.client.denials.map((d) => d.tool_name), ["Write"]);
  assert.ok(out.r.summary.notes.some((n) => n.startsWith("wrong save route: Write ") && n.endsWith("(denied)")), out.r.summary.notes.join("; "));
});

test("ROUTE-1 through the row: a file that appears in the working directory fails the row and is named", async () => {
  const b = box();
  const script = (args) => {
    nodefs.writeFileSync(`${args.options.cwd}/MEMORY.md`, DECIDED);
    return [init(), SKILL(), ...captured(), ok("Saved.")];
  };
  const out = await run(b, routeArgv(b), [script, echo]);
  assert.equal(out.r.exitCode, 1);
  assert.ok(out.r.summary.notes.includes("files written in the working directory: MEMORY.md"), out.r.summary.notes.join("; "));
});

test("Write and Edit in init still stop every other session row", async () => {
  const b = box();
  const out = await run(b, b.argv("T4O-N"), [[init({ tools: ["Skill", "Write"] }), ok("x")]]);
  assert.equal(out.r.exitCode, 3);
  assert.ok(out.r.summary.stoppedBecause.includes("Write"));
  for (const row of Object.keys(ROWS).filter((r) => !ROUTE_ROW_NAMES.includes(r) && !ROWS[r].noSession)) assert.ok(!ROWS[row].observeWrites, row);
  for (const row of ROUTE_ROW_NAMES) assert.equal(ROWS[row].observeWrites, true, row);
});

const ROUTE_DRY_LINE = `would run ${ROW}: 2 turn(s), caps 6/1, one command and one session; Write and Edit shown and never allowed, so a save to a file is seen and denied; ` +
  "auto memory on, from --auto-memory-settings, project dir name route1, with the memory directory and CLAUDE.md watched; " +
  "turn 2 is a memory-on probe with no tools (cap 1), asking for the reference code seeded in MEMORY.md";

test("ROUTE-1 dry run: two turns, caps 6/1, the shown-not-allowed note, the project dir name and the probe; no calls", async () => {
  const b = box();
  const d = b.deps();
  const r = await main({ argv: ["--dry-run", "--row", ROW], env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, ...d });
  assert.equal(r.exitCode, 0);
  assert.ok(d.io.lines.includes(ROUTE_DRY_LINE), d.io.lines.join("\n"));
});

// ---------------------------------------------------------------- auto memory: on for the ROUTE-1 ON rows only

test("autoMemory: only the ROUTE-1 ON variants have it, and ROUTE-1's prompt still names no Quadron, quad or project (save without naming Quadron)", () => {
  assert.deepEqual(ROW_NAMES.filter((r) => ROWS[r].autoMemory), ON_ROWS);
  assert.deepEqual(AUTO_MEMORY_ROW_NAMES, ON_ROWS);
  for (const cue of [/quadron/i, /\bquad/i, /project/i]) assert.doesNotMatch(ROWS[ROW].turns[0].prompt, cue);
});

test("autoMemory env: off sets the switch to 1 whatever the parent says; on sets it to 0; the other fixed switches stay 1 either way", () => {
  const args = { configDir: "/c", homeDir: "/h", maxOutputTokens: 4096 };
  const parent = { [AUTO_MEMORY_VAR]: "0" };
  assert.equal(buildChildEnv(parent, args)[AUTO_MEMORY_VAR], "1");
  assert.equal(buildChildEnv(parent, { ...args, autoMemory: false })[AUTO_MEMORY_VAR], "1");
  assert.equal(buildChildEnv({ [AUTO_MEMORY_VAR]: "1" }, { ...args, autoMemory: true })[AUTO_MEMORY_VAR], AUTO_MEMORY_ON);
  assert.equal(buildChildEnv({}, { ...args, autoMemory: "yes" })[AUTO_MEMORY_VAR], "1"); // only true turns it on
  assert.equal(buildChildEnv({}, { ...args, autoMemory: true }).CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS, "1");
});

test("assertAutoMemory: a row without the flag refuses any env that is not 1; the flag's row refuses anything but 0, and no env", () => {
  const withEnv = (v) => ({ env: v === undefined ? {} : { [AUTO_MEMORY_VAR]: v } });
  assert.doesNotThrow(() => assertAutoMemory(withEnv("1"), false));
  assert.doesNotThrow(() => assertAutoMemory({}, false)); // the guard-only check before a form starts has no env
  for (const v of ["0", undefined, ""]) assert.throws(() => assertAutoMemory(withEnv(v), false), /must be 1 on this row/, String(v));
  assert.doesNotThrow(() => assertAutoMemory(withEnv("0"), true));
  for (const o of [withEnv("1"), withEnv(undefined), {}]) assert.throws(() => assertAutoMemory(o, true), /must be 0 on an autoMemory row/);
});

test("auto-memory settings: deny rules plus autoMemoryEnabled true pass with the flag only; false, absent or another key refuse", () => {
  assert.doesNotThrow(() => checkSettingsDenyOnly(autoMemorySettings(), { autoMemory: true }));
  assert.throws(() => checkSettingsDenyOnly(autoMemorySettings()), /it contains autoMemoryEnabled/);
  for (const s of [{ ...goodSettings(), autoMemoryEnabled: false }, goodSettings(), { ...goodSettings(), autoMemoryEnabled: "true" }]) {
    assert.throws(() => checkSettingsDenyOnly(s, { autoMemory: true }), /must set autoMemoryEnabled to true/, JSON.stringify(s));
  }
  assert.throws(() => checkSettingsDenyOnly({ ...autoMemorySettings(), model: "x" }, { autoMemory: true }), /it contains model/);
});

test("isMemoryPath and memoryChangesBetween: a memory directory at any depth and any CLAUDE.md count; session files do not", () => {
  for (const p of ["projects/x/memory/", "projects/x/memory/MEMORY.md", "memory/a.md", "CLAUDE.md", ".claude/CLAUDE.md", "a/CLAUDE.local.md", "claude.md"]) assert.ok(isMemoryPath(p), p);
  for (const p of ["projects/x/", "projects/x/s1.log", "settings.json", "memoryless/a", "", "CLAUDE.md.bak"]) assert.ok(!isMemoryPath(p), p);
  const before = [["config-dir", []], ["home", ["CLAUDE.md|1|1"]]];
  const after = [["config-dir", ["projects/", "projects/x/", "projects/x/s1.log|9|9", "projects/x/memory/", "projects/x/memory/MEMORY.md|3|4"]], ["home", ["CLAUDE.md|2|5"]]];
  assert.deepEqual(memoryChangesBetween(before, after), ["config-dir/projects/x/memory/", "config-dir/projects/x/memory/MEMORY.md", "home/CLAUDE.md"]);
  assert.deepEqual(memoryChangesBetween(before, [["config-dir", ["projects/", "projects/x/s1.log|9|9"]], ["home", ["CLAUDE.md|1|1"]]]), []);
});

test("ROUTE-1 verdict: accepted capture and no memory change passes; a memory file or a CLAUDE.md fails naming the path; no Quadron call fails", () => {
  const pass = verdictRoute1([rec(init(), SKILL(), ...captured(), ok("Saved."))], { filesWritten: [], memoryChanges: [] });
  assert.equal(pass.verdict, "PASS", pass.notes.join("; "));
  const mem = "config-dir/projects/x/memory/MEMORY.md";
  const wrote = verdictRoute1([rec(init(), ...captured(), ok("Saved."))], { memoryChanges: [mem] });
  assert.equal(wrote.verdict, "FAIL");
  assert.ok(wrote.notes.includes(`auto memory or CLAUDE.md changed: ${mem}`), wrote.notes.join("; "));
  assert.ok(wrote.notes.includes(`save route: ${CAPTURE}; memory ${mem}`), wrote.notes.join("; "));
  const md = verdictRoute1([rec(init(), ...captured(), ok("Saved."))], { memoryChanges: ["home/CLAUDE.md"] });
  assert.equal(md.verdict, "FAIL");
  assert.ok(md.notes.includes("auto memory or CLAUDE.md changed: home/CLAUDE.md"), md.notes.join("; "));
  const none = verdictRoute1([rec(init(), ok("I'll remember that."))], { memoryChanges: [mem] });
  assert.equal(none.verdict, "FAIL");
  assert.ok(none.notes.includes(`no ${CAPTURE} call`));
  assert.ok(none.notes.includes(`save route: memory ${mem}`), none.notes.join("; "));
});

test("ROUTE-1 through the row: auto memory on, its own settings file loaded, the config dir isolated; a capture with no memory change passes", async () => {
  const b = box();
  const out = await run(b, routeArgv(b), [capturedRow(), echo]);
  assert.equal(out.r.exitCode, 0, out.d.io.lines.join("\n"));
  const [{ options }] = out.client.calls;
  assert.equal(options.env[AUTO_MEMORY_VAR], AUTO_MEMORY_ON);
  assert.equal(options.env.CLAUDE_CODE_PROJECT_DIR_NAME, "route1");
  assert.equal(options.settings, b.autoMemorySettings);
  assert.equal(options.env.CLAUDE_CONFIG_DIR, b.cfg);
  assert.ok(options.env.HOME.startsWith(b.out), "the child's home is the new one under --out");
  assert.deepEqual(options.settingSources, []);
});

test("ROUTE-1 through the row: a file written in the config dir's memory directory fails the row, naming the path, exit 1", async () => {
  const b = box();
  const script = (args) => {
    const dir = path.join(args.options.env.CLAUDE_CONFIG_DIR, "projects", "p", "memory");
    nodefs.mkdirSync(dir, { recursive: true });
    nodefs.writeFileSync(path.join(dir, "MEMORY.md"), DECIDED);
    nodefs.writeFileSync(path.join(args.options.env.CLAUDE_CONFIG_DIR, "projects", "p", "session.log"), "x"); // not memory: ignored
    return capturedRow();
  };
  const out = await run(b, routeArgv(b), [script, echo]);
  assert.equal(out.r.exitCode, 1);
  assert.equal(out.r.summary.verdict, "FAIL");
  assert.ok(out.r.summary.notes.includes("auto memory or CLAUDE.md changed: config-dir/projects/p/memory/, config-dir/projects/p/memory/MEMORY.md"), out.r.summary.notes.join("; "));
  assert.ok(out.r.summary.notes.includes(MEMORY_ON_EVIDENCE_NOTE));
});

test("ROUTE-1 through the row: a CLAUDE.md written in the isolated home or config dir fails the row, naming it", async () => {
  for (const [where, label] of [["HOME", "home"], ["CLAUDE_CONFIG_DIR", "config-dir"]]) {
    const b = box();
    const script = (args) => { nodefs.writeFileSync(path.join(args.options.env[where], "CLAUDE.md"), DECIDED); return capturedRow(); };
    const out = await run(b, routeArgv(b), [script, echo]);
    assert.equal(out.r.exitCode, 1, where);
    assert.ok(out.r.summary.notes.includes(`auto memory or CLAUDE.md changed: ${label}/CLAUDE.md`), out.r.summary.notes.join("; "));
  }
});

test("ROUTE-1 refuses with no call: no --auto-memory-settings, a file without autoMemoryEnabled true, or one missing the deny rules", async () => {
  const cases = [
    ["absent", (b) => b.argv(ROW), /--auto-memory-settings is required for ROUTE-1/],
    ["false", (b) => { nodefs.writeFileSync(b.autoMemorySettings, JSON.stringify({ ...goodSettings(), autoMemoryEnabled: false })); return routeArgv(b); }, /must set autoMemoryEnabled to true/],
    ["no deny", (b) => { nodefs.writeFileSync(b.autoMemorySettings, JSON.stringify({ autoMemoryEnabled: true })); return routeArgv(b); }, /lacks the required web and browser deny rules/],
    ["missing", (b) => b.argv(ROW, {}, ["--auto-memory-settings", b.p("nope.json")]), /auto-memory settings file missing/],
  ];
  for (const [label, argv, re] of cases) {
    const b = box();
    const out = await run(b, argv(b), [capturedRow()]);
    assert.equal(out.r.exitCode, 2, label);
    assert.equal(out.client.calls.length, 0, label);
    assert.match(out.d.io.errors.join(" "), re, label);
  }
});

test("other rows keep auto memory disabled: the env sets 1, --settings is loaded, --auto-memory-settings refuses, and a hook turning it on refuses", async () => {
  for (const row of ["T2", "T4O-N"]) {
    const b = box();
    const out = await run(b, b.argv(row), [T2_OK()]);
    const [{ options }] = out.client.calls;
    assert.equal(options.env[AUTO_MEMORY_VAR], "1", row);
    assert.equal(options.settings, b.settings, row);
  }
  for (const r of ROW_NAMES.filter((n) => !ON_ROWS.includes(n) && !ROWS[n].noSession)) assert.ok(!ROWS[r].autoMemory, r);
  const named = box();
  const refused = await run(named, named.argv("T2", {}, ["--auto-memory-settings", named.autoMemorySettings]), [T2_OK()]);
  assert.equal(refused.r.exitCode, 2);
  assert.equal(refused.client.calls.length, 0);
  assert.match(refused.d.io.errors.join(" "), /applies to an auto-memory row only/);
  const init1 = box();
  const initForm = await run(init1, init1.initArgv(["--auto-memory-settings", init1.autoMemorySettings]), [[init()]]);
  assert.equal(initForm.r.exitCode, 2);
  const hooked = box();
  const testOptionsHook = (o) => ({ ...o, env: { ...o.env, [AUTO_MEMORY_VAR]: "0" } });
  const on = await run(hooked, hooked.argv("T2"), [T2_OK()], { testOptionsHook });
  assert.equal(on.r.exitCode, 2);
  assert.equal(on.client.calls.length, 0);
  assert.match(on.d.io.errors.join(" "), /CLAUDE_CODE_DISABLE_AUTO_MEMORY must be 1 on this row/);
});

// ---------------------------------------------------------------- the seeded-nonce probe

const LINE_RE = new RegExp(`^${SEED_PREFIX.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}[0-9a-f]{8}$`);

test("seed: written before turn 1 and before the snapshot, one neutral line with a fresh nonce, recorded in the evidence, never counted as a change", async () => {
  const seen = [];
  const nonces = [];
  for (let n = 0; n < 2; n++) {
    const b = box();
    const turn1 = (args) => { seen.push(nodefs.readFileSync(SEED_FILE(args), "utf8")); return capturedRow(); };
    const out = await run(b, routeArgv(b), [turn1, echo]);
    assert.equal(out.r.summary.verdict, "PASS", out.r.summary.notes.join("; "));
    const mp = out.r.summary.memoryProbe;
    assert.match(mp.nonce, /^[0-9a-f]{8}$/);
    assert.equal(seen[n], `${mp.seedLine}\n`);
    assert.match(mp.seedLine, LINE_RE);
    assert.doesNotMatch(mp.seedLine, /decid|decision|judg|note|save|remember/i);
    assert.deepEqual([mp.projectDirName, mp.state, mp.echoed], ["route1", "ran", true]);
    assert.equal(b.summary().memoryProbe.nonce, mp.nonce); // in summary.json on disk
    assert.ok(!out.r.summary.notes.some((n2) => n2.startsWith("auto memory or CLAUDE.md changed")), "the seed is the baseline");
    nonces.push(mp.nonce);
  }
  assert.notEqual(nonces[0], nonces[1]);
});

test("probe: turn-1 pass and the nonce echoed is PASS, measured; with no echo it is INCONCLUSIVE, exit 1; both carry the salience note", async () => {
  const b = box();
  const pass = await run(b, routeArgv(b), [capturedRow(), echo]);
  assert.equal(pass.r.exitCode, 0);
  assert.equal(pass.r.summary.verdict, "PASS");
  for (const n of ["memory-on: measured (nonce echoed)", SEED_SALIENCE_NOTE]) assert.ok(pass.r.summary.notes.includes(n), n);
  const q = box();
  const quiet = await run(q, routeArgv(q), [capturedRow(), silent]);
  assert.equal(quiet.r.exitCode, 1);
  assert.equal(quiet.r.summary.verdict, INCONCLUSIVE);
  for (const n of ["memory-on: not shown", SEED_SALIENCE_NOTE]) assert.ok(quiet.r.summary.notes.includes(n), n);
  assert.equal(quiet.r.summary.memoryProbe.echoed, false);
  assert.equal(lineOf(quiet), `${ROW}: INCONCLUSIVE; call spend 0.1200 USD`);
});

test("probe: a probe with no result or a failed result makes a turn-1 pass INCONCLUSIVE, not a stop", async () => {
  for (const [label, script, why] of [
    ["no result", () => [probeInit()], "the probe had no result"],
    ["max turns", () => [probeInit(), result(0.12, { subtype: "error_max_turns" })], "the probe result was error_max_turns"],
  ]) {
    const b = box();
    const out = await run(b, routeArgv(b), [capturedRow(), script], { timeoutMs: 200 });
    assert.equal(out.r.summary.verdict, INCONCLUSIVE, `${label}: ${out.r.summary.notes.join("; ")}`);
    assert.equal(out.r.summary.partial, false, label);
    assert.ok(out.r.summary.notes.some((n) => n.startsWith("memory-on: inconclusive (")), label);
    assert.equal(out.r.summary.memoryProbe.state, "error", label);
    if (label === "max turns") assert.ok(out.r.summary.notes.includes(`memory-on: inconclusive (${why})`), out.r.summary.notes.join("; "));
  }
});

test("probe: turn 1 removing or rewriting the nonce line skips the probe with no call, and the row FAILs for the memory change, memory-on inconclusive", async () => {
  for (const [label, rewrite] of [["removed", () => ""], ["rewritten", (t) => t.replace(/QX-[0-9a-f]{8}/, "QX-00000000")]]) {
    const b = box();
    const turn1 = (args) => { nodefs.writeFileSync(SEED_FILE(args), rewrite(nodefs.readFileSync(SEED_FILE(args), "utf8"))); return capturedRow(); };
    const out = await run(b, routeArgv(b), [turn1, echo]);
    assert.equal(out.client.calls.length, 1, label);
    assert.equal(b.calls().length, 1, `${label}: no reservation for the probe`);
    assert.equal(out.r.summary.verdict, "FAIL", label);
    assert.equal(out.r.exitCode, 1, label);
    assert.ok(out.r.summary.notes.includes("auto memory or CLAUDE.md changed: config-dir/projects/route1/memory/MEMORY.md"), out.r.summary.notes.join("; "));
    assert.ok(out.r.summary.notes.includes("memory-on: inconclusive (turn 1 rewrote or removed the seeded line, so the probe was skipped)"), out.r.summary.notes.join("; "));
    assert.equal(out.r.summary.memoryProbe.state, "skipped", label);
  }
});

test("probe: a turn-1 FAIL stays FAIL whatever the probe says", async () => {
  for (const probe of [echo, silent, () => [probeInit()]]) {
    const b = box();
    const out = await run(b, routeArgv(b), [[init(), ok("I'll remember that.")], probe], { timeoutMs: 200 });
    assert.equal(out.r.summary.verdict, "FAIL", out.r.summary.notes.join("; "));
    assert.equal(out.r.exitCode, 1);
  }
});

test("memoryProbeVerdict: FAIL stays, PASS needs the echo, anything else on a PASS is INCONCLUSIVE with the reason", () => {
  const code = "QX-1a2b3c4d";
  const PASS = { verdict: "PASS", notes: [] }, FAIL = { verdict: "FAIL", notes: ["x"] };
  assert.equal(memoryProbeVerdict(PASS, { state: "ran", text: `${code}` }, { code }).verdict, "PASS");
  assert.equal(memoryProbeVerdict(PASS, { state: "ran", text: "QX-00000000" }, { code }).verdict, INCONCLUSIVE);
  for (const p of [{ state: "skipped", why: "w" }, { state: "error", why: "w" }, null]) assert.equal(memoryProbeVerdict(PASS, p, { code }).verdict, INCONCLUSIVE, JSON.stringify(p));
  assert.ok(memoryProbeVerdict(PASS, null, { code }).notes.includes("memory-on: inconclusive (the probe was not reached)"));
  for (const p of [{ state: "ran", text: code }, { state: "ran", text: "" }, null]) assert.equal(memoryProbeVerdict(FAIL, p, { code }).verdict, "FAIL");
  assert.ok(memoryProbeVerdict(FAIL, null, { code, memoryChanges: ["config-dir/projects/route1/memory/MEMORY.md"] }).notes.includes(MEMORY_ON_EVIDENCE_NOTE));
  assert.ok(!memoryProbeVerdict(FAIL, null, { code, memoryChanges: ["home/CLAUDE.md"] }).notes.includes(MEMORY_ON_EVIDENCE_NOTE));
  for (const p of [{ state: "ran", text: code }, null]) assert.ok(memoryProbeVerdict(PASS, p, { code }).notes.includes(SEED_SALIENCE_NOTE));
});

test("other rows: no project dir name in the env, no seed in the config dir, no memoryProbe; the guard refuses a name on them", async () => {
  for (const row of ["T2", "T4O-N"]) {
    const b = box();
    const out = await run(b, b.argv(row), [T2_OK()]);
    assert.ok(!(PROJECT_DIR_VAR in out.client.calls[0].options.env), row);
    assert.deepEqual(nodefs.readdirSync(b.cfg), [], row);
    assert.equal(out.r.summary.memoryProbe, undefined, row);
  }
  for (const r of ROW_NAMES.filter((n) => !ON_ROWS.includes(n))) assert.ok(!ROWS[r].projectDirName && !(ROWS[r].turns ?? []).some((t) => t.probe), r);
  const hooked = box();
  const out = await run(hooked, hooked.argv("T2"), [T2_OK()], { testOptionsHook: (o) => (o.env ? { ...o, env: { ...o.env, [PROJECT_DIR_VAR]: "route1" } } : o) });
  assert.equal(out.r.exitCode, 2);
  assert.match(out.d.io.errors.join(" "), /CLAUDE_CODE_PROJECT_DIR_NAME is for an autoMemory row only/);
  assert.throws(() => buildChildEnv({}, { homeDir: "/h", maxOutputTokens: 1, projectDirName: "route1" }), /needs an autoMemory row/);
  assert.throws(() => buildChildEnv({}, { homeDir: "/h", maxOutputTokens: 1, autoMemory: true, projectDirName: "bad/name" }), /1-64 letters/);
  assert.equal(buildChildEnv({ [PROJECT_DIR_VAR]: "x" }, { homeDir: "/h", maxOutputTokens: 1 })[PROJECT_DIR_VAR], undefined); // never inherited
  assert.throws(() => assertAutoMemory({ env: { [AUTO_MEMORY_VAR]: AUTO_MEMORY_ON } }, true, "route1"), /must be the row's project directory name/);
});

test("INCONCLUSIVE counts as a ran attempt: two on Opus use both attempts, and a third is refused before any call", async () => {
  const b = box();
  for (const cfg of ["cfg", "cfg2"]) {
    nodefs.mkdirSync(b.p(cfg), { recursive: true });
    const out = await run(b, routeArgv(b, ["--config-dir", b.p(cfg)]), [capturedRow(), silent]);
    assert.equal(out.r.summary.verdict, INCONCLUSIVE, cfg);
  }
  assert.deepEqual(b.rowsOf().map((e) => e.verdict), [INCONCLUSIVE, INCONCLUSIVE]);
  nodefs.mkdirSync(b.p("cfg3"));
  const third = await run(b, routeArgv(b, ["--config-dir", b.p("cfg3")]), [capturedRow(), echo]);
  assert.equal(third.r.exitCode, 2);
  assert.equal(third.client.calls.length, 0);
  assert.match(third.d.io.errors.join(" "), /ROUTE-1 has used 2 of 2 attempt\(s\)/);
});

// ---------------------------------------------------------------- the variants: memory on and off, other wordings

const ASKS = {
  "ROUTE-1": "Please save that so it's remembered.", "ROUTE-1-OFF": "Please save that so it's remembered.",
  "ROUTE-1-SAVE-ON": "Save that.", "ROUTE-1-SAVE-OFF": "Save that.",
  "ROUTE-1-REMEMBER-ON": "Remember that.", "ROUTE-1-REMEMBER-OFF": "Remember that.",
  "ROUTE-1-RECORD": "Save that to my record.", "ROUTE-1-QUADRON": "Save that to Quadron.",
};
const variantLine = (out, row) => out.d.io.lines.find((l) => l.startsWith(`${row}: `));

test("variants: the routing rows are exactly ROUTE-1 and its seven variants, each the decision sentence then its ask", () => {
  assert.deepEqual(ROUTE_ROW_NAMES, [...ON_ROWS.slice(0, 1), ...OFF_ROWS.slice(0, 1), "ROUTE-1-SAVE-ON", "ROUTE-1-SAVE-OFF", "ROUTE-1-REMEMBER-ON", "ROUTE-1-REMEMBER-OFF", "ROUTE-1-RECORD", "ROUTE-1-QUADRON"]);
  assert.deepEqual([...ROUTE_ROW_NAMES].sort(), [...ON_ROWS, ...OFF_ROWS].sort());
  assert.equal(ROUTE_DECISION, "Decision: we bill annually only; monthly plans are ruled out.");
  for (const r of ROUTE_ROW_NAMES) assert.equal(ROWS[r].turns[0].prompt, `${ROUTE_DECISION} ${ASKS[r]}`, r);
  assert.equal(ROWS[ROW].turns[0].prompt, "Decision: we bill annually only; monthly plans are ruled out. Please save that so it's remembered.");
});

test("variants: no prompt names Quadron, quad or project except the ROUTE-1-QUADRON control, and only ROUTE-1-RECORD says record", () => {
  for (const r of ROUTE_ROW_NAMES) {
    const p = ROWS[r].turns[0].prompt;
    if (r === "ROUTE-1-QUADRON") assert.match(p, /\bQuadron\b/, r);
    else for (const cue of [/quadron/i, /\bquad/i]) assert.doesNotMatch(p, cue, r);
    assert.doesNotMatch(p, /project/i, r);
    if (r === "ROUTE-1-RECORD") assert.match(p, /\brecord\b/, r);
    else assert.doesNotMatch(p, /\brecord\b/i, r);
  }
});

test("ON variants: ROUTE-1's shape, auto memory on, the probe as turn 2, a distinct valid project dir name each, verdictRoute1", () => {
  const names = ON_ROWS.map((r) => ROWS[r].projectDirName);
  assert.equal(new Set(names).size, ON_ROWS.length, names.join(", "));
  for (const r of ON_ROWS) {
    const def = ROWS[r];
    assert.deepEqual([def.connector, def.cwd, def.observeWrites, def.autoMemory, def.memoryOff], [true, "empty", true, true, undefined], r);
    assert.match(def.projectDirName, PROJECT_DIR_NAME_RE, r);
    assert.equal(def.turns.length, 2, r);
    assert.deepEqual(def.turns[1], ROWS[ROW].turns[1], r);
    assert.deepEqual(def.turns[0].tools, ROWS[ROW].turns[0].tools, r);
    assert.equal(def.turns[0].maxTurns, ROWS[ROW].turns[0].maxTurns, r);
    assert.deepEqual(turnTools(def, def.turns[0]), ["Skill", "ToolSearch", ...OBSERVED_WRITE_TOOLS], r);
    assert.equal(VERDICTS[r], verdictRoute1, r);
  }
});

test("OFF variants: one turn, no auto memory, no project dir name, no probe, Write and Edit observed, the memory-off verdict", () => {
  for (const r of OFF_ROWS) {
    const def = ROWS[r];
    assert.deepEqual([def.connector, def.cwd, def.observeWrites, def.memoryOff], [true, "empty", true, true], r);
    assert.ok(!def.autoMemory && def.projectDirName === undefined, r);
    assert.equal(def.turns.length, 1, r);
    assert.ok(!def.turns[0].probe, r);
    assert.deepEqual(def.turns[0].tools, ROWS[ROW].turns[0].tools, r);
    assert.equal(VERDICTS[r], verdictRoute1MemoryOff, r);
  }
  for (const r of ROW_NAMES.filter((n) => !OFF_ROWS.includes(n))) assert.ok(!ROWS[r].memoryOff, r);
});

test("memory-off verdict: one accepted capture passes with the note; a Write to a memory file fails, with the note; never INCONCLUSIVE", () => {
  const pass = verdictRoute1MemoryOff([rec(init(), SKILL(), ...captured(), ok("Saved."))], { filesWritten: [], memoryChanges: [] });
  assert.equal(pass.verdict, "PASS", pass.notes.join("; "));
  assert.ok(pass.notes.includes(MEMORY_OFF_NOTE));
  assert.ok(pass.notes.includes(`save route: ${CAPTURE}`));
  assert.equal(MEMORY_OFF_NOTE, "memory-off: auto memory disabled by the harness (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1); no memory-on probe");
  const wrote = verdictRoute1MemoryOff([rec(init(), toolUse("w1", "Write", { file_path: MEMORY_FILE, content: DECIDED }), toolResult("w1", "denied", true), ok("I'll remember that."))]);
  assert.equal(wrote.verdict, "FAIL");
  assert.ok(wrote.notes.includes(`wrong save route: Write ${MEMORY_FILE} (denied)`), wrote.notes.join("; "));
  assert.ok(wrote.notes.includes(MEMORY_OFF_NOTE));
  const none = verdictRoute1MemoryOff([rec(init(), ok("Noted."))]);
  assert.equal(none.verdict, "FAIL");
  for (const v of [pass, wrote, none]) assert.ok(!v.notes.some((n) => n.startsWith("memory-on:")), v.notes.join("; "));
});

test("OFF variants through the row: one call, auto memory 1, --settings loaded, no seed and no memoryProbe; a capture passes with exit 0", async () => {
  for (const r of OFF_ROWS) {
    const b = box();
    const out = await run(b, b.argv(r), [capturedRow()]);
    assert.equal(out.r.exitCode, 0, `${r}: ${out.d.io.lines.join("\n")} ${out.d.io.errors.join(" ")}`);
    assert.equal(out.r.summary.verdict, "PASS", r);
    assert.equal(out.client.calls.length, 1, r);
    const [{ options }] = out.client.calls;
    assert.equal(options.env[AUTO_MEMORY_VAR], "1", r);
    assert.ok(!(PROJECT_DIR_VAR in options.env), r);
    assert.equal(options.settings, b.settings, r);
    assert.deepEqual(options.tools, ["Skill", "ToolSearch", "Write", "Edit"], r);
    assert.equal(out.client.prompts[0].text, `${ROUTE_DECISION} ${ASKS[r]}`, r);
    assert.deepEqual(nodefs.readdirSync(b.cfg), [], r);
    assert.equal(out.r.summary.memoryProbe, undefined, r);
    assert.ok(out.r.summary.notes.includes(MEMORY_OFF_NOTE), r);
    assert.ok(!out.r.summary.notes.some((n) => n.startsWith("memory-on:")), r);
    assert.equal(variantLine(out, r), `${r}: PASS; call spend 0.1000 USD`);
  }
});

test("OFF variants through the row: a Write is denied and the row FAILs naming it, exit 1, with the memory-off note", async () => {
  const b = box();
  const out = await run(b, b.argv("ROUTE-1-SAVE-OFF"), [[init(), toolUse("w1", "Write", { file_path: MEMORY_FILE, content: DECIDED }), ok("Filed.")]]);
  assert.equal(out.r.exitCode, 1);
  assert.equal(out.r.summary.verdict, "FAIL");
  assert.deepEqual(out.client.denials.map((d) => d.tool_name), ["Write"]);
  assert.ok(out.r.summary.notes.some((n) => n.startsWith("wrong save route: Write ") && n.endsWith("(denied)")), out.r.summary.notes.join("; "));
  assert.ok(out.r.summary.notes.includes(MEMORY_OFF_NOTE));
});

test("OFF variants refuse --auto-memory-settings with no call, naming the auto-memory rows", async () => {
  for (const r of OFF_ROWS) {
    const b = box();
    const out = await run(b, b.argv(r, {}, ["--auto-memory-settings", b.autoMemorySettings]), [capturedRow()]);
    assert.equal(out.r.exitCode, 2, r);
    assert.equal(out.client.calls.length, 0, r);
    assert.match(out.d.io.errors.join(" "), new RegExp(`applies to an auto-memory row only \\(${ON_ROWS.join(", ")}\\)`), r);
  }
});

test("ON variants through the row: each needs --auto-memory-settings, runs on it with its own project dir name, and reads the probe", async () => {
  for (const r of ON_ROWS.filter((n) => n !== ROW)) {
    const absent = box();
    const refused = await run(absent, absent.argv(r), [capturedRow()]);
    assert.equal(refused.r.exitCode, 2, r);
    assert.equal(refused.client.calls.length, 0, r);
    assert.match(refused.d.io.errors.join(" "), new RegExp(`--auto-memory-settings is required for ${r}`), r);
    const b = box();
    const out = await run(b, b.argv(r, {}, ["--auto-memory-settings", b.autoMemorySettings]), [capturedRow(), echo]);
    assert.equal(out.r.exitCode, 0, `${r}: ${out.r.summary.notes.join("; ")}`);
    assert.equal(out.r.summary.verdict, "PASS", r);
    const [{ options }, { options: probeOptions }] = out.client.calls;
    assert.equal(options.env[AUTO_MEMORY_VAR], AUTO_MEMORY_ON, r);
    assert.equal(options.env[PROJECT_DIR_VAR], ROWS[r].projectDirName, r);
    assert.equal(options.settings, b.autoMemorySettings, r);
    assert.deepEqual([probeOptions.tools, probeOptions.allowedTools, probeOptions.maxTurns], [[], [], 1], r);
    assert.equal(out.client.prompts[0].text, `${ROUTE_DECISION} ${ASKS[r]}`, r);
    assert.deepEqual([out.r.summary.memoryProbe.projectDirName, out.r.summary.memoryProbe.echoed], [ROWS[r].projectDirName, true], r);
    assert.ok(out.r.summary.notes.includes("memory-on: measured (nonce echoed)"), r);
    assert.ok(!out.r.summary.notes.includes(MEMORY_OFF_NOTE), r);
  }
  const q = box();
  const quiet = await run(q, q.argv("ROUTE-1-SAVE-ON", {}, ["--auto-memory-settings", q.autoMemorySettings]), [capturedRow(), silent]);
  assert.equal(quiet.r.summary.verdict, INCONCLUSIVE);
  assert.equal(quiet.r.exitCode, 1);
});

test("variants dry run: an ON variant shows two turns and the probe, an OFF variant one turn and memory off; no calls", async () => {
  const lines = {
    "ROUTE-1-SAVE-ON": "would run ROUTE-1-SAVE-ON: 2 turn(s), caps 6/1, one command and one session; Write and Edit shown and never allowed, so a save to a file is seen and denied; " +
      "auto memory on, from --auto-memory-settings, project dir name route1-save, with the memory directory and CLAUDE.md watched; " +
      "turn 2 is a memory-on probe with no tools (cap 1), asking for the reference code seeded in MEMORY.md",
    "ROUTE-1-SAVE-OFF": "would run ROUTE-1-SAVE-OFF: 1 turn(s), caps 6, one command and one session; Write and Edit shown and never allowed, so a save to a file is seen and denied; " +
      "auto memory off (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1), so no memory-on probe; the verdict reads turn 1 alone",
  };
  for (const [r, line] of Object.entries(lines)) {
    const b = box();
    const d = b.deps();
    const res = await main({ argv: ["--dry-run", "--row", r], env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, ...d });
    assert.equal(res.exitCode, 0, r);
    assert.ok(d.io.lines.includes(line), d.io.lines.join("\n"));
  }
});

test("usage: the --row list names every session row, and --auto-memory-settings names the auto-memory rows", () => {
  assert.ok(USAGE.includes(`--row <${SESSION_ROW_NAMES.join("|")}>`), USAGE);
  for (const r of ROUTE_ROW_NAMES) assert.ok(SESSION_ROW_NAMES.includes(r), r);
  assert.ok(!SESSION_ROW_NAMES.includes("T3"));
  assert.ok(USAGE.includes(`auto-memory rows only: ${ON_ROWS.join(", ")}`), USAGE);
  assert.doesNotMatch(USAGE, /ROUTE-1 only/);
});
