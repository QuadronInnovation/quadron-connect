// T3 is no session. This is the check: it runs the session-start hook script directly as a child
// process, with an empty temporary home and the Quadron URLs at a closed port, and records every
// file write and socket through a preload. The real home is never the home here.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as nodefs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../lib/main.mjs";
import { ROWS, T3_CHECK } from "../lib/rows.mjs";
import { box, fakeClient, liveEnv, T2_OK } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const HOOK = path.join(REPO, "cli", "hooks", "session-start.js");
const CLOSED = "http://127.0.0.1:9";

const PRELOAD = `
const fs = require("fs"), net = require("net"), path = require("path");
const log = process.env.T3_ACTIVITY_LOG;
const fd = fs.openSync(log, "a");
const writeSync = fs.writeSync;
const note = (o) => writeSync(fd, JSON.stringify(o) + "\\n"); // not through the functions patched below
for (const name of ["writeFileSync", "appendFileSync", "mkdirSync", "rmSync", "unlinkSync", "renameSync", "copyFileSync", "createWriteStream"]) {
  const orig = fs[name];
  fs[name] = function (p, ...rest) { note({ write: name, path: path.resolve(String(p)) }); return orig.call(this, p, ...rest); };
}
const openSync = fs.openSync;
fs.openSync = function (p, flags, ...rest) {
  if (typeof flags === "string" && /[wa+x]/.test(flags)) note({ write: "openSync", path: path.resolve(String(p)) });
  return openSync.call(this, p, flags, ...rest);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) { note({ connect: true }); return connect.apply(this, a); };
`;

test("F26. T3: the hook script with an empty home and no network exits clean, attempts nothing and writes nothing outside its temp directory", () => {
  const root = nodefs.realpathSync(nodefs.mkdtempSync(path.join(tmpdir(), "journey-t3-")));
  try {
    const home = path.join(root, "home");
    const support = path.join(root, "support");
    const cwd = path.join(root, "cwd");
    for (const d of [home, support, cwd]) nodefs.mkdirSync(d);
    const preload = path.join(support, "preload.cjs");
    const activity = path.join(support, "activity.jsonl");
    nodefs.writeFileSync(preload, PRELOAD);
    nodefs.writeFileSync(activity, "");
    const parsed = path.win32.parse(home);
    const env = {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, HOMEDRIVE: parsed.root.slice(0, 2), HOMEPATH: home,
      QUADRON_ISSUER: CLOSED, QUADRON_API: CLOSED, QUADRON_MCP_URL: CLOSED, T3_ACTIVITY_LOG: activity,
    };
    const r = spawnSync(process.execPath, ["--require", preload, HOOK], {
      cwd, env, input: JSON.stringify({ source: "startup" }), encoding: "utf8", timeout: 30_000,
    });
    assert.equal(r.error, undefined);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.signal, null);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");

    const events = nodefs.readFileSync(activity, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(events.filter((e) => e.connect), []); // nothing attempted over the network, capture included
    const outside = events.filter((e) => e.write && !e.path.startsWith(root + path.sep));
    assert.deepEqual(outside, []);
    assert.deepEqual(nodefs.readdirSync(home), []); // not linked: it does not even log
  } finally {
    nodefs.rmSync(root, { recursive: true, force: true });
  }
});

test("F26. the check's own recording works: a write and a connection through the preload are seen", () => {
  const root = nodefs.realpathSync(nodefs.mkdtempSync(path.join(tmpdir(), "journey-t3-")));
  try {
    const preload = path.join(root, "preload.cjs"), activity = path.join(root, "activity.jsonl");
    nodefs.writeFileSync(preload, PRELOAD);
    nodefs.writeFileSync(activity, "");
    const script = `require("fs").writeFileSync(${JSON.stringify(path.join(root, "x"))}, "y"); require("net").connect(9, "127.0.0.1").on("error", () => {});`;
    const r = spawnSync(process.execPath, ["--require", preload, "-e", script], { env: { PATH: process.env.PATH, T3_ACTIVITY_LOG: activity }, encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    const events = nodefs.readFileSync(activity, "utf8");
    assert.match(events, /"write":"writeFileSync"/);
    assert.match(events, /"connect":true/);
  } finally {
    nodefs.rmSync(root, { recursive: true, force: true });
  }
});

test("F26. the library's T3 row refuses any session and points at the check: exit 2, no client call, no ledger entry, never a pass", async () => {
  const b = box();
  const client = fakeClient([T2_OK()]);
  const d = b.deps();
  const r = await main({ argv: b.argv("T3"), env: { ...b.campaign, ...liveEnv() }, client, ...d });
  assert.equal(r.exitCode, 2);
  assert.equal(client.calls.length, 0);
  assert.deepEqual(b.entries(), []);
  const text = [...d.io.lines, ...d.io.errors].join("\n");
  assert.ok(text.includes(T3_CHECK));
  assert.ok(text.includes(path.basename(fileURLToPath(import.meta.url))));
  assert.ok(!text.includes("PASS"));
  assert.ok(ROWS.T3.noSession);
  assert.deepEqual(ROWS.T3.turns, []);
});
