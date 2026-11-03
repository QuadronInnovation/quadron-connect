#!/usr/bin/env node
"use strict";
// quadron-connect — wire a terminal coding agent to Quadron.
//
// What this is NOT: the MCP server. mcp.quadron.tech is a remote HTTP server; nobody downloads
// it, you point a client at a URL. This package is the glue that (a) registers that URL with the
// agent, (b) installs the lifecycle hooks the agent runs, and (c) holds the credential both need.
//
//   cli.js                         sign in, register the MCP server, install the recall hook
//   cli.js status                  what is wired, and is the token good
//   cli.js uninstall               remove exactly what was installed
//
// ★ THERE IS NO CAPTURE HOOK, AND THAT IS DELIBERATE.
//
// The first version posted `last_assistant_message` — the MODEL's words — into the person's
// record as though it were their own judgment. A terminal turn contains the assistant's output,
// and writing that as the person's own decision is the wrong attribution. Whose words a terminal
// turn contains is a design question that needs answering before any hook writes from that
// surface. Recall ships; capture waits.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const auth = require("../lib/auth.js");
const settings = require("../lib/settings.js");

const HOOK_DIR = path.join(__dirname, "..", "hooks");
const MCP_URL = auth.MCP_URL;   // resolved once in auth: env > ~/.quadron/config.json > default

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;

function say(s = "") { process.stdout.write(`${s}\n`); }

async function signIn() {
  if (auth.isLinked() && (await auth.accessToken())) {
    say(`${ok("✓")} already signed in`);
    return true;
  }
  const dev = await auth.beginDeviceAuth();
  const url = dev.verification_uri_complete || dev.verification_uri;
  say("");
  say(`  ${bold("Open this to sign in:")}  ${url}`);
  if (!dev.verification_uri_complete) say(`  ${bold("Code:")}  ${dev.user_code}`);
  say("");
  process.stdout.write("  waiting");
  try {
    await auth.pollForToken(dev, () => process.stdout.write("."));
    say(`\n${ok("✓")} signed in`);
    return true;
  } catch (e) {
    say(`\n${warn("✗")} ${e.message}`);
    return false;
  }
}

// Registering the MCP server is best-effort: `claude` may not be on PATH (Cursor, Codex, a bare
// shell), and failing the whole install over it would be wrong when the hooks are the harder half.
function registerMcp() {
  try {
    execFileSync("claude", ["mcp", "add", "--transport", "http", "quadron", MCP_URL],
                 { stdio: "pipe" });
    return { done: true };
  } catch (e) {
    const msg = String((e && e.stderr) || (e && e.message) || "");
    if (/already exists/i.test(msg)) return { done: true, already: true };
    return { done: false, reason: msg.split("\n")[0].slice(0, 120) || "claude CLI not available" };
  }
}

function installHooks() {
  const r = settings.read();
  if (!r.ok) { say(`${warn("✗")} ${r.error}`); say("  Fix that file, then run this again."); return false; }
  const backup = r.existed ? settings.backup() : null;
  const { data, added } = settings.install(r.data, HOOK_DIR);
  settings.write(data);
  if (added.length) say(`${ok("✓")} installed hooks: ${added.join(", ")}`);
  else say(`${ok("✓")} hooks already installed`);
  if (backup) say(dim(`  (backed up your settings to ${path.basename(backup)})`));
  return true;
}

async function cmdInstall() {
  say(bold("\nQuadron — connect this terminal\n"));
  // Persist the endpoints BEFORE anything else uses them, so the hook installed below inherits the
  // environment this install chose. Without it the hook falls back to production at every session
  // start, whatever QUADRON_ISSUER/QUADRON_MCP_URL were set to here.
  auth.saveConfig();
  if (auth.ISSUER !== auth.DEFAULTS.issuer) say(`${warn("!")} non-production endpoints: ${auth.ISSUER}`);
  if (!(await signIn())) process.exit(1);

  const m = registerMcp();
  if (m.done) say(`${ok("✓")} MCP server registered${m.already ? " (already present)" : ""}`);
  else {
    say(`${warn("!")} could not register the MCP server automatically: ${m.reason}`);
    say(`  Add it by hand:  claude mcp add --transport http quadron ${MCP_URL}`);
  }

  if (!installHooks()) process.exit(1);

  say("");
  say("  Recall is on: a new session starts knowing your projects.");
  say(dim("  Nothing is captured from this terminal — recall only, for now."));
  say("");
  say(dim("  Restart your agent if the hooks do not appear in /hooks within a few seconds."));
  say("");
}

async function cmdStatus() {
  say(bold("\nQuadron — status\n"));
  // ★ Shown first, and always. The endpoints are now remembered in ~/.quadron/config.json, so a
  //   terminal can stay pointed at staging long after the person who pointed it there has
  //   forgotten — "linked" on its own would be the most misleading word on this screen.
  const prod = auth.ISSUER === auth.DEFAULTS.issuer;
  say(`  quadron       ${prod ? ok("production") : warn(auth.ISSUER)}`);
  if (!prod) say(dim(`  mcp           ${auth.MCP_URL}`));
  const linked = auth.isLinked();
  say(`  sign-in       ${linked ? ok("linked") : warn("not linked")}`);
  if (linked) {
    const t = await auth.accessToken();
    say(`  token         ${t ? ok("valid") : warn("could not refresh — run the installer again")}`);
  }
  const r = settings.read();
  if (!r.ok) { say(`  settings      ${warn(r.error)}`); }
  else {
    const st = settings.status(r.data);
    say(`  recall hook   ${st.SessionStart ? ok("installed") : dim("not installed")}`);
    say(`  capture hook  ${st.Stop ? warn("installed — remove with uninstall") : dim("none (by design)")}`);
  }
  const log = path.join(auth.HOME, "hook.log");
  if (fs.existsSync(log)) {
    const lines = fs.readFileSync(log, "utf8").trim().split("\n").slice(-3);
    if (lines[0]) { say(""); say(dim("  recent hook activity:")); for (const l of lines) say(dim(`    ${l}`)); }
  }
  say("");
}

function cmdUninstall() {
  say(bold("\nQuadron — remove\n"));
  const r = settings.read();
  if (!r.ok) { say(`${warn("✗")} ${r.error}`); process.exit(1); }
  settings.backup();
  const { data, removed } = settings.uninstall(r.data);
  settings.write(data);
  say(removed.length ? `${ok("✓")} removed hooks: ${removed.join(", ")}` : "  no Quadron hooks were installed");
  say(dim(`  Your sign-in is untouched. Delete ${auth.HOME} to remove it too.`));
  say(dim("  The MCP server stays registered: claude mcp remove quadron"));
  say("");
}

const [, , ...argv] = process.argv;
const cmd = argv.find((a) => !a.startsWith("-")) || "install";

(async () => {
  if (cmd === "status") return cmdStatus();
  if (cmd === "uninstall" || cmd === "remove") return cmdUninstall();
  if (cmd === "install") return cmdInstall();
  say(`unknown command: ${cmd}`);
  say("usage: quadron-connect [install|status|uninstall]");
  process.exit(2);
})().catch((e) => { say(`\n${warn("✗")} ${e && e.message}`); process.exit(1); });
