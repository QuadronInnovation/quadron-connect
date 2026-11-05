// Per-client connection text: goldens pin the output, negative controls pin the refusals.
// Proves our output only. It says nothing about whether any client accepts it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { CLIENTS, render } = require("../lib/client-config.js");

const BASE = "https://mcp.example.test/mcp";
const golden = (name) => readFileSync(new URL(`fixtures/client-config/${name}`, import.meta.url), "utf8");
let passed = 0;
const check = (fn) => { fn(); passed += 1; };

check(() => assert.deepEqual(CLIENTS, ["cursor", "codex", "chatgpt"]));
check(() => assert.equal(render("cursor", BASE).text, golden("cursor.mcp.json")));
check(() => assert.equal(JSON.parse(render("cursor", BASE).text).mcpServers.quadron.url, BASE));
check(() => assert.equal(render("codex", BASE).text, golden("codex.config.toml")));
check(() => assert.equal(render("chatgpt", BASE).text, golden("chatgpt.url.txt")));
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

console.log(`client-config: ${passed} checks passed`);
