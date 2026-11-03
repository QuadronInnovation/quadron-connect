#!/usr/bin/env node
"use strict";
// SessionStart hook — the person's own prior judgment, already loaded.
//
// This is the half of the loop that makes the record worth having: you open a terminal and what
// you have already worked out is there, without asking for it. MCP can only answer when asked,
// because the server cannot initiate; a hook runs before the first prompt and can.
//
// ── how injection works ───────────────────────────────────────────────────────────────────────
// SessionStart is one of the three events where plain stdout becomes context Claude can see. So
// this prints text and exits 0 — no JSON envelope needed. (The JSON form exists for when you also
// want sessionTitle or watchPaths; we want neither.)
//
// ★ Phrased as STATEMENTS OF RECORD, never as instructions. The docs are explicit: "Text framed
//   as out-of-band system commands can trigger Claude's prompt-injection defenses, which causes
//   Claude to surface the text to you instead of treating it as context." So this says "Your
//   active projects are X and Y" and never "you must call quad_commit". Telling the model what to
//   do is INSTRUCTIONS' job, and the MCP server already does that once at initialize.
//
// ── budget ────────────────────────────────────────────────────────────────────────────────────
// Hook output is capped at 10,000 characters; past that it is written to a file and replaced with
// a preview, which would be worse than sending less. This stays well inside that.
//
// ── failure posture ───────────────────────────────────────────────────────────────────────────
// Silence. Not linked, offline, service down: print nothing, exit 0. A session that starts a
// second slower with no context is a minor loss; a session that starts with an error banner, or
// with a claim about someone's record that we could not actually read, is a real one.

const fs = require("fs");
const path = require("path");
const auth = require("../lib/auth.js");

const LOG = path.join(auth.HOME, "hook.log");
const CAP = 4000;   // well inside the 10k limit, and small enough to stay cheap every session
// From auth, not a second copy of the default. This file and cli.js each carried their own
// MCP_URL constant, so the URL the installer registered and the URL the hook called could
// drift apart — and resolving it here, at hook runtime, read an environment the agent does
// not have. auth resolves it once: env > ~/.quadron/config.json > production default.
const MCP_URL = auth.MCP_URL;

function log(msg) {
  try {
    fs.mkdirSync(auth.HOME, { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG, `${new Date().toISOString()} session-start ${msg}\n`);
  } catch { /* never throw from logging */ }
}

// Statements, not directives. Each line is a fact about the record; nothing here tells the model
// what to do with them.
function render(projects) {
  if (!projects.length) return "";
  const names = projects.map((p) => (p.name || "").trim()).filter(Boolean).slice(0, 12);
  if (!names.length) return "";
  const lines = [
    "Quadron is connected, and this person keeps a record of their own expertise in it.",
    // Each name is quoted: a project may be called "Hello, Quadron", and an unquoted comma list
    // would state it to the model as two projects (the split-then-join fallback below hides it).
    `Their active projects are: ${names.map((n) => JSON.stringify(n)).join(", ")}.`,
    "Their prior decisions, standards and methods are readable through the Quadron tools —" +
      " quad_context for a working frame on a topic, quad_recall within one project," +
      " quad_search across all of them.",
  ];
  const out = lines.join("\n");
  return out.length > CAP ? out.slice(0, CAP) : out;
}

// ★ The list arrives " · "-separated because a project name may CONTAIN a comma — the default seed
//   Quad is named "Hello, Quadron". Splitting on "," turned that one Quad into two projects that do
//   not exist ("Hello", "Quadron") and then stated them to the model as fact; the rendered line looked
//   right because split-then-join round-trips, which is why it went unnoticed. A list with ONE
//   project has no separator at all, so "does the text contain ' · '" is not a test for the new
//   format: the old comma fallback fired on exactly the seed Quad. Every server since 2026-08 sends
//   " · ", so the split is unconditional and a comma is always part of a name.
//
// Extracted from main() to be testable at all. An inline parser is one whose logic never gets checked.
function parseProjects(txt) {
  const match = txt.match(/^Active Quadron projects:\s*(.+?)\.(?:\s|$)/);
  if (!match) return null;
  const raw = match[1];
  const names = raw.split(" · ")
    .map((s) => s.replace(/\s*\(\d+ recorded judgment.*?\)/, "").trim())
    .filter(Boolean);
  return names.map((name) => ({ name }));
}

async function main() {
  // Drain stdin so the caller never blocks on a pipe we ignore. `source` is startup | resume |
  // clear | compact | fork — we treat them alike, because the record is equally worth having in
  // all five and SessionStart is documented to re-run on resume precisely so context stays fresh.
  let input = "";
  for await (const chunk of process.stdin) input += chunk;

  if (!auth.isLinked()) return;                 // never nag; `cli.js status` explains
  const token = await auth.accessToken();
  if (!token) {
    log("token refresh failed — starting without context");
    return;
  }

  // ★ Calls the MCP server, not the product gateway. The gateway validates aud/azp against its
  // own client_id ("quadron-web"), which a device-code DCR token does not carry. The MCP server
  // accepts any Keycloak token whose azp is not a first-party client, and calls /api/quads
  // internally with service auth — so the user's token only needs to pass the MCP's check.
  const r = await auth.request(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "quad_context", arguments: {} },
    }),
  });
  if (!r.ok) {
    log(`could not read projects: ${r.status}`);
    return;
  }
  const rpc = await r.json().catch(() => null);
  const txt = rpc && rpc.result && Array.isArray(rpc.result.content)
    ? (rpc.result.content.find((c) => c.type === "text") || {}).text || ""
    : "";
  const projects = parseProjects(txt);
  if (!projects) {
    if (txt) process.stdout.write(txt.length > CAP ? txt.slice(0, CAP) : txt);
    return;
  }
  const text = render(projects);
  if (text) process.stdout.write(text);
}

// ★ Only run when executed as a hook. Without this guard, importing the module (as the
// tests do, to exercise the detector and the renderer) starts reading stdin and hangs
// forever — and an untestable hook is one whose logic never gets checked.
if (require.main === module) {
  const deadline = setTimeout(() => process.exit(0), 2000);
  main().catch(() => log("recall unavailable")).finally(() => { clearTimeout(deadline); process.exit(0); });
}

module.exports = { render, parseProjects, CAP };
