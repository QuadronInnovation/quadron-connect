// ROUTE-1, the routing row: asked to save with no Quadron or project cue, the save goes to the capture
// tool and not to a file. Synthetic streams on the verdict, then the whole row through the fake client.
import test from "node:test";
import assert from "node:assert/strict";
import * as nodefs from "node:fs";
import { main } from "../lib/main.mjs";
import { DISALLOWED_TOOLS, OBSERVED_WRITE_TOOLS, assertSessionOptions, unexpectedInitTools } from "../lib/guards.mjs";
import { buildOptions } from "../lib/options.mjs";
import { ROWS, CAPTURE_PLACEHOLDER, turnTools } from "../lib/rows.mjs";
import { changedEntries } from "../lib/live.mjs";
import { VERDICTS, collect, verdictRoute1 } from "../lib/verdicts.mjs";
import { box, fakeClient, liveEnv, init, result, toolUse, toolResult, assistantText, SKILL, CAPTURE } from "./helpers.mjs";

const ROW = "ROUTE-1";
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

// ---------------------------------------------------------------- the row

test("ROUTE-1 row: one connector turn in a new empty directory, a save request with no Quadron, project or record cue", () => {
  const def = ROWS[ROW];
  assert.equal(def.connector, true);
  assert.equal(def.cwd, "empty");
  assert.equal(def.observeWrites, true);
  assert.equal(def.turns.length, 1);
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
  const out = await run(b, b.argv(ROW), [[init({ tools: ["Skill", "Write", "Edit", CAPTURE, COMMIT] }), SKILL(), ...captured(), ok("Saved.")]]);
  assert.equal(out.r.exitCode, 0, out.d.io.lines.join("\n"));
  assert.equal(out.r.summary.verdict, "PASS");
  const [{ options }] = out.client.calls;
  assert.deepEqual(options.tools, ["Skill", "ToolSearch", "Write", "Edit"]);
  assert.deepEqual(options.allowedTools, ROWS[ROW].turns[0].tools);
  for (const t of OBSERVED_WRITE_TOOLS) assert.ok(!options.disallowedTools.includes(t), t);
  for (const t of ["MultiEdit", "NotebookEdit", "Bash", "PowerShell"]) assert.ok(options.disallowedTools.includes(t), t);
  assert.equal(lineOf(out), `${ROW}: PASS; call spend 0.1000 USD`);
  assert.ok(out.r.summary.notes.includes(`save route: ${CAPTURE}`));
});

test("ROUTE-1 through the row: a Write is denied by dontAsk, nothing is written, and the row fails naming it, exit 1", async () => {
  const b = box();
  const out = await run(b, b.argv(ROW), [[init(), toolUse("w1", "Write", { file_path: MEMORY_FILE, content: DECIDED }), ok("Filed.")]]);
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
  const out = await run(b, b.argv(ROW), [script]);
  assert.equal(out.r.exitCode, 1);
  assert.ok(out.r.summary.notes.includes("files written in the working directory: MEMORY.md"), out.r.summary.notes.join("; "));
});

test("Write and Edit in init still stop every other session row", async () => {
  const b = box();
  const out = await run(b, b.argv("T4O-N"), [[init({ tools: ["Skill", "Write"] }), ok("x")]]);
  assert.equal(out.r.exitCode, 3);
  assert.ok(out.r.summary.stoppedBecause.includes("Write"));
  for (const row of Object.keys(ROWS).filter((r) => r !== ROW && !ROWS[r].noSession)) assert.ok(!ROWS[row].observeWrites, row);
});

test("ROUTE-1 dry run: listed with one turn, cap 6, and the shown-not-allowed note; no calls", async () => {
  const b = box();
  const d = b.deps();
  const r = await main({ argv: ["--dry-run", "--row", ROW], env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, ...d });
  assert.equal(r.exitCode, 0);
  assert.ok(d.io.lines.includes(`would run ${ROW}: 1 turn(s), caps 6, one command and one session; Write and Edit shown and never allowed, so a save to a file is seen and denied`), d.io.lines.join("\n"));
});
