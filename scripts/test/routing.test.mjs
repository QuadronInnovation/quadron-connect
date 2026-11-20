// Tests for scripts/gen-routing.mjs and scripts/routing-drift.mjs, against fixtures only.
// Run: node --test scripts/test/routing.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTURE_RE } from "../../test/journey/lib/rows.mjs";
import { SAVE_TOOLS, readSnapshot } from "../lib/routing.mjs";
import { BEGIN, END, generate, renderBlock } from "../gen-routing.mjs";
import { instructionsFrom } from "../routing-drift.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => join(here, "fixtures", name);
const script = (name) => join(here, "..", name);
const run = (name, args) => spawnSync(process.execPath, [script(name), ...args], { encoding: "utf8" });
const drift = (...args) => run("routing-drift.mjs", ["--snapshot", fx("snapshot.json"), ...args]);

// ---- drift check
test("drift: in sync -> OK rows, exit 0; quad_create and quad_apply_method lacking the text are ignored", () => {
  const r = drift(fx("in-sync.tools.json"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^OK tool quad_commit:/m);
  assert.match(r.stdout, /^OK tool future_you_capture:/m);
  assert.doesNotMatch(r.stdout, /quad_create|quad_apply_method|DRIFT|instructions/);
});

test("drift: one description missing the text -> DRIFT naming the tool, exit 1 (JSON-RPC envelope accepted)", () => {
  const r = drift(fx("commit-missing.rpc.json"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^DRIFT tool quad_commit: description lacks the snapshot text$/m);
  assert.match(r.stdout, /^OK tool future_you_capture:/m);
});

test("drift: a save tool absent from tools/list -> DRIFT", () => {
  const r = drift(fx("in-sync.tools.json"), "--tools", "quad_commit,quad_missing");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^DRIFT tool quad_missing: not in tools\/list$/m);
});

test("drift: --tools narrows the list", () => {
  const r = drift(fx("commit-missing.rpc.json"), "--tools", "future_you_capture");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /quad_commit/);
});

test("drift: instructions are not checked by default", () => {
  const r = drift(fx("in-sync.tools.json"));
  assert.doesNotMatch(r.stdout, /instructions/);
});

test("drift: --expect-instructions with instructions missing the text -> DRIFT, exit 1", () => {
  const r = drift(fx("in-sync.tools.json"), "--expect-instructions", fx("instructions-without.txt"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^DRIFT instructions: lack the snapshot text$/m);
});

test("drift: --expect-instructions with an initialize response carrying the text -> OK", () => {
  const r = drift(fx("in-sync.tools.json"), "--expect-instructions", fx("instructions-with.initialize.json"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^OK instructions:/m);
});

test("drift: bad input -> exit 2", () => {
  assert.equal(drift().status, 2);
  assert.equal(drift(fx("instructions-without.txt")).status, 2);
});

test("drift: --expect-instructions JSON with no string instructions field -> exit 2, even when the text sits elsewhere in the document", () => {
  const r = drift(fx("in-sync.tools.json"), "--expect-instructions", fx("instructions-outside.initialize.json"));
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /holds no string "instructions"/);
  assert.doesNotMatch(r.stdout, /instructions/);
  assert.throws(() => instructionsFrom(JSON.stringify({ result: { instructions: 7 } })), /holds no string "instructions"/);
  assert.equal(instructionsFrom("plain text"), "plain text");
});

test("drift and gen: --snapshot with no path after it -> exit 2, never the default snapshot", () => {
  const d = run("routing-drift.mjs", [fx("in-sync.tools.json"), "--snapshot"]);
  assert.equal(d.status, 2, d.stdout + d.stderr);
  assert.match(d.stderr, /missing path after --snapshot/);
  const g = run("gen-routing.mjs", ["--check", "--snapshot"]);
  assert.equal(g.status, 2, g.stdout + g.stderr);
  assert.match(g.stderr, /missing path after --snapshot/);
});

test("drift: default save tools are exactly quad_commit and future_you_capture, and match CAPTURE_RE", () => {
  assert.deepEqual([...SAVE_TOOLS].sort(), ["future_you_capture", "quad_commit"]);
  for (const t of SAVE_TOOLS) assert.match(t, CAPTURE_RE);
});

// ---- generator
test("gen: --check on a stale block -> exit 1", () => {
  const r = run("gen-routing.mjs", ["--check", "--snapshot", fx("snapshot.json"), "--skill", fx("skill-stale.md")]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^DIFF /m);
});

test("gen: write then --check -> exit 0, and only the block changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-routing-"));
  try {
    const skill = join(dir, "SKILL.md");
    copyFileSync(fx("skill-stale.md"), skill);
    const w = run("gen-routing.mjs", ["--snapshot", fx("snapshot.json"), "--skill", skill]);
    assert.equal(w.status, 0, w.stdout + w.stderr);
    const out = readFileSync(skill, "utf8");
    assert.ok(out.includes(renderBlock(readSnapshot(fx("snapshot.json")))));
    assert.ok(out.startsWith("# Fixture skill\n") && out.endsWith("- Other rules stay as they are.\n"));
    assert.doesNotMatch(out, /hand edit/);
    const c = run("gen-routing.mjs", ["--check", "--snapshot", fx("snapshot.json"), "--skill", skill]);
    assert.equal(c.status, 0, c.stdout + c.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gen: missing or duplicated markers are rejected", () => {
  const snap = readSnapshot(fx("snapshot.json"));
  assert.throws(() => generate("no markers", snap), /exactly one/);
  assert.throws(() => generate(`${BEGIN}\n${END}\n${BEGIN}\n${END}`, snap), /exactly one/);
});

test("gen: END before BEGIN is rejected, adjacent or apart", () => {
  const snap = readSnapshot(fx("snapshot.json"));
  assert.throws(() => generate(`${END}${BEGIN}`, snap), /END marker comes before BEGIN/);
  assert.throws(() => generate(`intro\n${END}\ntext\n${BEGIN}\n`, snap), /END marker comes before BEGIN/);
});

test("snapshot: a sha256 that does not match the text, or a missing field, is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "gen-routing-"));
  try {
    const bad = join(dir, "snapshot.json");
    const snap = JSON.parse(readFileSync(fx("snapshot.json"), "utf8"));
    writeFileSync(bad, JSON.stringify({ ...snap, text: snap.text + " Edited." }));
    assert.throws(() => readSnapshot(bad), /does not match text/);
    assert.equal(run("gen-routing.mjs", ["--check", "--snapshot", bad, "--skill", fx("skill-stale.md")]).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => readSnapshot(fx("in-sync.tools.json")), /field "text"/);
});

test("repo: the committed SKILL.md matches the committed snapshot", () => {
  const r = run("gen-routing.mjs", ["--check"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
