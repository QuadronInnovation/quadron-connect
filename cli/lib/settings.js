"use strict";
// Writing into someone else's settings.json.
//
// This is the part of the package most able to do harm. ~/.claude/settings.json is a file the
// person owns and may have hand-edited; other tools register hooks in it too. So:
//
//   * MERGE, never replace. Hook events hold an array of matcher groups, and multiple groups per
//     event are valid and run in parallel — so ours is appended as its own group and leaves any
//     existing group untouched. (Verified against a live config with two sibling UserPromptSubmit
//     groups from unrelated tools.)
//   * IDEMPOTENT. Re-running must not add a second copy. Ours are identified by a marker in the
//     command string rather than by array position, because positions shift.
//   * BACKED UP. A timestamped copy before the first write, so a mistake here is recoverable
//     without git.
//   * REMOVABLE. uninstall() takes out exactly what install() put in, and nothing adjacent.

const fs = require("fs");
const os = require("os");
const path = require("path");

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
// Every command we write contains this, so ours are findable without relying on ordering.
const MARKER = "quadron-connect";

function read(file = SETTINGS) {
  // Separated deliberately: "cannot read it" and "read it but it is not JSON" are different
  // situations with different right answers, and collapsing them reported a missing directory as
  // a syntax error. Anything unreadable is treated as absent (a fresh install); only a file we
  // DID read and could not parse is refused.
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: true, data: {}, existed: false };
  }
  try {
    const data = JSON.parse(raw);
    // A settings file that exists but does not parse is NOT ours to fix. Rewriting it would
    // discard whatever the person was mid-edit on; refusing tells them what to look at.
    return { ok: true, data: data && typeof data === "object" ? data : {}, existed: true };
  } catch (e) {
    return { ok: false, error: `${file} is not valid JSON (${e.message})` };
  }
}

function backup(file = SETTINGS) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${file}.quadron-backup-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

function write(data, file = SETTINGS) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function ourGroup(group) {
  return (group.hooks || []).some((h) => String(h.command || "").includes(MARKER));
}

/** Add our hook groups, leaving every other group alone. Returns what changed. */
function install(data, hookDir) {
  const d = { ...data };
  d.hooks = { ...(d.hooks || {}) };
  const added = [];
  // ★ RECALL ONLY. The capture hook was removed before merge — see the note in bin/cli.js.
  // Recall reads; it has no authorship question to get wrong.
  const plan = [
    ["SessionStart", "session-start.js", "Loading your Quadron record...", 10],
  ];
  for (const [event, script, statusMessage, timeout] of plan) {
    const groups = Array.isArray(d.hooks[event]) ? [...d.hooks[event]] : [];
    if (groups.some(ourGroup)) continue;                 // idempotent
    groups.push({
      hooks: [{
        type: "command",
        // Absolute path, double-quoted: the docs recommend quoting in shell form, and a relative
        // path would resolve against whatever cwd the session happens to start in.
        command: `node "${path.join(hookDir, script)}"`,
        timeout,
        statusMessage,
      }],
    });
    d.hooks[event] = groups;
    added.push(event);
  }
  return { data: d, added };
}

/** Remove only our groups. An event left with no groups is deleted rather than left as []. */
function uninstall(data) {
  const d = { ...data };
  d.hooks = { ...(d.hooks || {}) };
  const removed = [];
  for (const event of Object.keys(d.hooks)) {
    if (!Array.isArray(d.hooks[event])) continue;
    const kept = d.hooks[event].filter((g) => !ourGroup(g));
    if (kept.length !== d.hooks[event].length) removed.push(event);
    if (kept.length) d.hooks[event] = kept;
    else delete d.hooks[event];
  }
  if (!Object.keys(d.hooks).length) delete d.hooks;
  return { data: d, removed };
}

/** Which of our hooks are currently registered. */
function status(data) {
  const out = {};
  for (const event of Object.keys((data && data.hooks) || {})) {
    if (Array.isArray(data.hooks[event]) && data.hooks[event].some(ourGroup)) out[event] = true;
  }
  return out;
}

module.exports = { SETTINGS, MARKER, read, backup, write, install, uninstall, status, ourGroup };
