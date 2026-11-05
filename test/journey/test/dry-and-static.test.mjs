import test from "node:test";
import assert from "node:assert/strict";
import * as nodefs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../lib/main.mjs";
import { ROW_NAMES } from "../lib/rows.mjs";
import { box, fakeClient, liveEnv, T2_OK, fetchStub } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOURNEY = path.resolve(HERE, "..");
const frag = (...p) => p.join("");

// run.mjs and README.md are excluded from the scans, in either form they may take.
const EXCLUDED_FILES = new Set(["run.mjs", "README.md"]);

// node_modules is never entered, and neither excluded file is opened.
function walk(dir, root = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else if (!(dir === root && EXCLUDED_FILES.has(e.name))) out.push(p);
  }
  return out;
}
const files = walk(JOURNEY);
const src = (p) => readFileSync(p, "utf8");
const rel = (p) => path.relative(JOURNEY, p).replace(/\\/g, "/");

// A spy over the child_process module object: any spawn-like call is recorded.
function spawnSpy() {
  const cp = createRequire(import.meta.url)("node:child_process");
  const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
  const orig = {}, calls = [];
  for (const n of names) { orig[n] = cp[n]; cp[n] = () => { calls.push(n); throw new Error("spawn blocked"); }; }
  return { calls, restore: () => names.forEach((n) => { cp[n] = orig[n]; }) };
}

const secretNames = ["ANTHROPIC_API_KEY", "QUADRON_CONNECTOR_REFRESH_TOKEN", "QUADRON_CONNECTOR_CLIENT_ID", "QUADRON_CONNECTOR_ISSUER"];
function watchedEnv(base) {
  const reads = [];
  const env = new Proxy(base, { get(t, k) { reads.push(String(k)); return t[k]; } });
  return { env, reads };
}
const untouchedFs = () => new Proxy({}, { get() { throw new Error("fs touched in dry"); } });

test("dry by default: with a key set and --live absent, the SDK loader is never called, fetch is never reached, nothing is spawned, the key is never read", async () => {
  const spy = spawnSpy();
  const b = box();
  try {
    let loaded = 0;
    const f = fetchStub();
    const { env, reads } = watchedEnv(liveEnv());
    const fetchSeenInDry = [];
    const d = b.deps({ fetch: f, io: { out: () => { fetchSeenInDry.push(globalThis.fetch); }, err: () => {} } });
    const before = globalThis.fetch;
    const argv = ["--model", "claude-opus-5-5", "--effort", "low", "--max-session-usd", "1", "--max-run-usd", "2", "--max-total-usd", "5",
      "--expected-account", "x", "--ledger", "/l", "--row", "T2"];
    const r = await main({ argv, env, loadSdk: () => { loaded++; return {}; }, client: undefined, ...d });
    assert.equal(r.exitCode, 0);
    assert.equal(r.dry, true);
    assert.equal(loaded, 0);
    assert.equal(f.seen.length, 0);
    assert.equal(spy.calls.length, 0);
    assert.deepEqual(reads.filter((k) => secretNames.includes(k)), []);
    assert.ok(fetchSeenInDry.length > 0);
    for (const fn of fetchSeenInDry) assert.throws(() => fn("https://x.example.test"), /network is disabled/);
    assert.equal(globalThis.fetch, before); // restored afterwards

    for (const bad of ["--livee", "--lve", "--Live", "--live=true"]) {
      const c = fakeClient([T2_OK()]);
      let l2 = 0;
      const rr = await main({ argv: [...argv, bad], env: liveEnv(), client: c, loadSdk: () => { l2++; return {}; }, ...b.deps({ fetch: f }) });
      assert.equal(rr.exitCode, 2, bad);
      assert.equal(c.calls.length, 0); assert.equal(l2, 0); assert.equal(f.seen.length, 0); assert.equal(spy.calls.length, 0);
    }
    // missing required flags in the implicit dry form refuse too
    const rr = await main({ argv: ["--row", "T2"], env: liveEnv(), ...b.deps() });
    assert.equal(rr.exitCode, 2);
  } finally { spy.restore(); }
});

test("the live branch alone holds the dynamic import of the SDK loader (static scan)", () => {
  const dyn = files.filter((p) => /\.mjs$/.test(p) && !rel(p).startsWith("test/") && /\bimport\s*\(/.test(src(p)));
  assert.deepEqual(dyn.map(rel), ["lib/main.mjs"]);
  const m = src(path.join(JOURNEY, "lib/main.mjs"));
  assert.equal(m.match(/\bimport\s*\(/g).length, 1);
  const at = m.indexOf("import(\"./sdk.mjs\")");
  assert.ok(at > m.indexOf("async function runLive"));
  assert.ok(at > m.indexOf("checkConfigDir(f[\"config-dir\"], fs)")); // after the refusals
  assert.ok(!/^import .*["']\.\/sdk\.mjs["']/m.test(m));
});

test("--dry-run works with only --row or none; run flags print 'not set'; exit 0; no ledger or settings read", async () => {
  const env = { QUADRON_HARNESS_DRY: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };
  const b = box();
  for (const row of ROW_NAMES) {
    const d = b.deps({ fs: untouchedFs() });
    const r = await main({ argv: ["--dry-run", "--row", row], env, ...d });
    assert.equal(r.exitCode, 0, row);
    const text = d.io.lines.join("\n");
    assert.match(text, /DRY RUN: no calls made/);
    assert.match(text, new RegExp(`would run ${row}:`));
    assert.match(text, /model: not set; effort: not set/);
    assert.match(text, /ledger: not set; expected account: not set/);
  }
  const d = b.deps();
  assert.equal((await main({ argv: ["--dry-run"], env, ...d })).exitCode, 0);
  assert.equal(d.io.lines.filter((l) => l.startsWith("would run")).length, ROW_NAMES.length);
  assert.equal((await main({ argv: ["--dry-run", "--row", "T9"], env, ...b.deps() })).exitCode, 2);
  assert.equal((await main({ argv: ["--dry-run", "--row", "T2,T4"], env, ...b.deps() })).exitCode, 2);
});

test("--dry-run names T3 as no session and points at its check", async () => {
  const b = box();
  const d = b.deps();
  assert.equal((await main({ argv: ["--dry-run", "--row", "T3"], env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, ...d })).exitCode, 0);
  assert.match(d.io.lines.join("\n"), /would run T3: no session.*t3-hook\.test\.mjs/);
});

test("--dry-run refuses (exit 2) unless ANTHROPIC_BASE_URL parses as a loopback URL", async () => {
  const ok = ["http://127.0.0.1:9", "http://127.0.0.1", "http://localhost:8080/x", "http://[::1]:9"];
  const bad = [undefined, "", "http://127.0.0.1.evil.example", "http://localhost.evil.example", "https://api.example.test", "garbage", "http://10.0.0.1", "http://evil.example/127.0.0.1", "ftp://127.0.0.1", "file://localhost/x"];
  const b = box();
  for (const u of ok) assert.equal((await main({ argv: ["--dry-run", "--row", "T2"], env: { ANTHROPIC_BASE_URL: u }, ...b.deps() })).exitCode, 0, u);
  for (const u of bad) {
    const d = b.deps();
    const r = await main({ argv: ["--dry-run", "--row", "T2"], env: u === undefined ? {} : { ANTHROPIC_BASE_URL: u }, ...d });
    assert.equal(r.exitCode, 2, String(u));
    assert.deepEqual(d.io.lines, []);
  }
});

test("the dry-run environment: dummy key, proxies, MCP URL and base URL at the closed port, empty home; succeeds quickly without reading the key or any file", async () => {
  const spy = spawnSpy();
  const b = box();
  try {
    const { env, reads } = watchedEnv({
      QUADRON_HARNESS_DRY: "1", ANTHROPIC_API_KEY: "dummy", ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "http://127.0.0.1:9", QUADRON_MCP_URL: "http://127.0.0.1:9",
      HOME: "/empty", USERPROFILE: "/empty",
    });
    const f = fetchStub();
    const started = Date.now();
    const d = b.deps({ fetch: f, fs: untouchedFs() });
    delete d.home;
    for (const row of ["T2", "T4", "T6", "ISSUE2"]) {
      const r = await main({ argv: ["--dry-run", "--row", row], env, ...d });
      assert.equal(r.exitCode, 0);
    }
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(reads.filter((k) => secretNames.includes(k) || k === "QUADRON_MCP_URL"), []);
    assert.equal(f.seen.length, 0);
    assert.equal(spy.calls.length, 0);
  } finally { spy.restore(); }
});

test("QUADRON_HARNESS_DRY=1 refuses --live (exit 2); --dry-run with --live also refuses", async () => {
  const b = box();
  for (const [argv, env] of [
    [b.argv("T2"), liveEnv({ QUADRON_HARNESS_DRY: "1" })],
    [[...b.argv("T2"), "--dry-run"], liveEnv({ ANTHROPIC_BASE_URL: "http://127.0.0.1:9" })],
  ]) {
    const c = fakeClient([T2_OK()]);
    let loaded = 0;
    const f = fetchStub();
    const r = await main({ argv, env, client: c, loadSdk: () => { loaded++; return {}; }, ...b.deps({ fetch: f }) });
    assert.equal(r.exitCode, 2);
    assert.equal(c.calls.length, 0); assert.equal(loaded, 0); assert.equal(f.seen.length, 0);
  }
});

test("clone. the dry path refuses a --out, --ledger or --config-dir inside the clone by path text alone, touching no file", async () => {
  const b = box();
  const env = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" };
  const inside = path.join(b.repo, "x");
  for (const flag of ["--out", "--ledger", "--config-dir"]) {
    const d = b.deps({ fs: untouchedFs() });
    const r = await main({ argv: ["--dry-run", "--row", "T2", flag, inside], env, ...d });
    assert.equal(r.exitCode, 2, flag);
    assert.match(d.io.errors.join(" "), /outside the clone/);
    assert.deepEqual(d.io.lines, []);
  }
  assert.equal((await main({ argv: ["--dry-run", "--row", "T2", "--out", b.out], env, ...b.deps({ fs: untouchedFs() }) })).exitCode, 0);
});

test("H1. dry does not touch the campaign record: no file, no variable read, and a ceiling above the constant refuses by value alone", async () => {
  const b = box();
  const { env, reads } = watchedEnv({ ANTHROPIC_BASE_URL: "http://127.0.0.1:9", QUADRON_CAMPAIGN_RECORD: b.p("not-there.jsonl"), QUADRON_CAMPAIGN_WORKSPACE: "w", QUADRON_CAMPAIGN_ID: "c" });
  const d = b.deps({ fs: untouchedFs() });
  const argv = ["--dry-run", "--row", "T2", "--model", "claude-opus-5-5", "--max-session-usd", "0.5"];
  assert.equal((await main({ argv, env, ...d })).exitCode, 0);
  assert.deepEqual(reads.filter((k) => k.startsWith("QUADRON_CAMPAIGN")), []);
  assert.equal(nodefs.existsSync(b.p("not-there.jsonl")), false);
  const text = d.io.lines.join("\n");
  assert.match(text, /campaign ceiling \(USD\): 5/);
  assert.match(text, /one call's worst case \(USD\): 1\.08192/);
  assert.equal((await main({ argv: [...argv, "--max-total-usd", "50"], env, ...b.deps({ fs: untouchedFs() }) })).exitCode, 2);
  assert.equal((await main({ argv: [...argv, "--max-output-tokens", "4097"], env, ...b.deps({ fs: untouchedFs() }) })).exitCode, 2);
});

test("the scans' file list holds the harness files and skips node_modules", () => {
  assert.ok(files.some((p) => p.endsWith("main.mjs")));
  assert.ok(!files.some((p) => p.includes("node_modules")));
});

test("static scan: only lib/sdk.mjs imports the SDK package, no test imports it or lib/sdk.mjs, only one test file imports child_process", () => {
  const pkg = frag("@anthropic-ai/", "claude-agent-sdk");
  const importsPkg = new RegExp(`(from|import\\s*\\(|require\\s*\\()\\s*["']${pkg}`);
  const importsSdkLib = /(from|import\s*\()\s*["'][^"']*lib\/sdk\.mjs["']|from\s*["']\.\.?\/sdk\.mjs["']/;
  const code = files.filter((p) => /\.mjs$/.test(p));
  assert.deepEqual(code.filter((p) => importsPkg.test(src(p))).map(rel), ["lib/sdk.mjs"]);
  for (const p of code.filter((x) => rel(x).startsWith("test/"))) {
    assert.ok(!importsPkg.test(src(p)), rel(p));
    assert.ok(!importsSdkLib.test(src(p)), rel(p));
  }
  for (const p of code.filter((x) => !rel(x).startsWith("test/"))) assert.ok(!/child_process/.test(src(p)), rel(p));
  // No print-mode spawn anywhere in the library or the entry. A method call on a pattern, /x/.exec(), is not one.
  for (const p of code.filter((x) => !rel(x).startsWith("test/"))) assert.ok(!/(?<![/.])\b(spawn|exec|execFile|fork)(Sync)?\s*\(/.test(src(p)), rel(p));
  const spawning = code.filter((p) => rel(p).startsWith("test/") && /^import .*"node:child_process";$/m.test(src(p))).map(rel);
  assert.deepEqual(spawning, ["test/t3-hook.test.mjs"]);
});

test("static scan: the entry is thin and no test names or imports it", () => {
  const entry = frag("sdk", "-run");
  const e = src(path.join(JOURNEY, `${entry}.mjs`));
  assert.ok(e.split("\n").length < 12);
  assert.match(e, /from "\.\/lib\/main\.mjs"/);
  for (const p of files.filter((x) => rel(x).startsWith("test/"))) {
    assert.ok(!src(p).includes(entry), rel(p));
    assert.ok(!rel(p).includes(entry));
  }
});

test("F24. nothing in the harness imports run.mjs, which is excluded from the scans", () => {
  const re = new RegExp(`(from|import\\s*\\(|require\\s*\\()\\s*["'][^"']*\\brun\\.mjs["']`);
  for (const p of files.filter((x) => /\.mjs$/.test(x))) assert.ok(!re.test(src(p)), rel(p));
});

test("F24. the scans' walker tolerates run.mjs and README.md in either form, never enters node_modules and never opens those two", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "journey-walk-")));
  try {
    mkdirSync(path.join(root, "lib"));
    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(root, "lib", "a.mjs"), "x");
    writeFileSync(path.join(root, "lib", "run.mjs"), "a nested file of that name is still scanned");
    writeFileSync(path.join(root, "run.mjs"), `import("x"); ${frag("spa", "wn")}("claude");`); // a print-mode form would fail every scan
    writeFileSync(path.join(root, "README.md"), "never opened");
    writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "never listed");
    assert.deepEqual(walk(root).map((p) => path.relative(root, p).replace(/\\/g, "/")).sort(), ["lib/a.mjs", "lib/run.mjs"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.ok(files.every((p) => !["run.mjs", "README.md"].includes(rel(p))));
});

test("F23. the install note with --ignore-scripts is a comment in lib/sdk.mjs", () => {
  assert.match(src(path.join(JOURNEY, "lib/sdk.mjs")), /^\/\/.*--ignore-scripts/m);
});

test("the T3 check names a real file", () => {
  assert.ok(readdirSync(HERE).includes("t3-hook.test.mjs"));
});
