// Per-client connection text: goldens pin the output, negative controls pin the refusals.
// Proves our output only. It says nothing about whether any client accepts it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { CLIENTS, render } = require("../lib/client-config.js");

const BASE = "https://mcp.example.test/mcp";
const golden = (name) => readFileSync(new URL(`fixtures/client-config/${name}`, import.meta.url), "utf8");
let passed = 0;
const check = (fn) => { fn(); passed += 1; };

check(() => assert.deepEqual(CLIENTS, ["cursor", "codex", "chatgpt", "gemini", "antigravity"]));
check(() => assert.equal(render("cursor", BASE).text, golden("cursor.mcp.json")));
check(() => assert.equal(JSON.parse(render("cursor", BASE).text).mcpServers.quadron.url, BASE));
check(() => assert.equal(render("codex", BASE).text, golden("codex.config.toml")));
check(() => assert.equal(render("chatgpt", BASE).text, golden("chatgpt.url.txt")));
check(() => assert.equal(render("gemini", BASE).text, golden("gemini.url.txt")));
check(() => assert.deepEqual(render("gemini", BASE).targets, []));
check(() => assert.equal(render("antigravity", BASE).text, golden("antigravity.mcp_config.json")));
check(() => assert.equal(JSON.parse(render("antigravity", BASE).text).mcpServers.quadron.serverUrl, BASE));
check(() => assert.deepEqual(render("antigravity", BASE).targets, ["~/.gemini/config/mcp_config.json"]));
for (const bad of ["http://mcp.example.test/mcp", "https://u:p@mcp.example.test/mcp",
                   "https://mcp.example.test/mcp?x=1", "https://mcp.example.test/mcp#f"]) {
  check(() => assert.throws(() => render("cursor", bad), /must be HTTPS/));
}
check(() => assert.throws(() => render("windsurf", BASE), /unknown client/));
// Negative control: the golden comparison can fail.
check(() => assert.notEqual(render("cursor", "https://other.example.test/mcp").text, golden("cursor.mcp.json")));
// The renderer must stay unable to touch anything.
const source = readFileSync(new URL("../lib/client-config.js", import.meta.url), "utf8");
check(() => assert.doesNotMatch(source, /\brequire\s*\(|\bprocess\b|\bimport\b|\bfetch\b/));

// The `config` command, spawned. auth.js reads ~/.quadron/config.json at load, so every spawn gets
// a temp home, and any QUADRON_* in the caller's environment is dropped.
const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "quadron-client-config-"));
const work = mkdtempSync(join(tmpdir(), "quadron-client-config-cwd-"));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("QUADRON_")));
const cli = (args, mcpUrl = BASE) => spawnSync(process.execPath, [join(CLI_DIR, "bin/cli.js"), ...args], {
  cwd: work,
  encoding: "utf8",
  env: { ...baseEnv, HOME: home, USERPROFILE: home, ...(mcpUrl ? { QUADRON_MCP_URL: mcpUrl } : {}) },
});
const USAGE = /usage: quadron-connect config <cursor, codex, chatgpt, gemini or antigravity>/;

try {
  for (const [client, file] of [["cursor", "cursor.mcp.json"], ["codex", "codex.config.toml"], ["chatgpt", "chatgpt.url.txt"],
                                ["gemini", "gemini.url.txt"], ["antigravity", "antigravity.mcp_config.json"]]) {
    const r = cli(["config", client]);
    check(() => assert.equal(r.status, 0, r.stderr));
    check(() => assert.equal(r.stdout, golden(file)));
    check(() => assert.match(r.stderr, /non-production endpoints: https:\/\/mcp\.example\.test\/mcp/));
  }
  check(() => assert.match(cli(["config", "cursor"]).stderr, /targets: ~\/\.cursor\/mcp\.json, \.cursor\/mcp\.json/));
  check(() => assert.match(cli(["config", "codex"]).stderr, /targets: ~\/\.codex\/config\.toml, \.codex\/config\.toml/));
  check(() => assert.match(cli(["config", "antigravity"]).stderr, /targets: ~\/\.gemini\/config\/mcp_config\.json/));
  check(() => assert.doesNotMatch(cli(["config", "gemini"]).stderr, /targets:/));
  // Negative control: on the default URL the warning stays away, so the match above can fail.
  check(() => assert.doesNotMatch(cli(["config", "cursor"], null).stderr, /non-production/));
  const prod = cli(["config", "cursor"], null);
  check(() => assert.equal(prod.status, 0, prod.stderr));
  check(() => assert.equal(JSON.parse(prod.stdout).mcpServers.quadron.url, "https://mcp.quadron.tech/mcp"));
  // Refusals exit nonzero with nothing on stdout, so a redirect cannot fill a config file with an error.
  for (const args of [["config", "windsurf"], ["config"]]) {
    const r = cli(args);
    check(() => assert.equal(r.status, 2));
    check(() => assert.equal(r.stdout, ""));
    check(() => assert.match(r.stderr, USAGE));
  }
  const badUrl = cli(["config", "cursor"], "http://mcp.example.test/mcp");
  check(() => assert.equal(badUrl.status, 1));
  check(() => assert.equal(badUrl.stdout, ""));
  check(() => assert.match(badUrl.stderr, /must be HTTPS/));
  // Print only: nothing was written under the home it ran with.
  check(() => assert.deepEqual(readdirSync(home), []));
  check(() => assert.deepEqual(readdirSync(work), []));
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

console.log(`client-config: ${passed} checks passed`);
