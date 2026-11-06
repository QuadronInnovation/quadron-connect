// Shared helpers for gen-routing.mjs and routing-drift.mjs. Node >= 18, no dependencies.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SNAPSHOT_PATH = join(REPO_ROOT, "plugins", "claude-code", "routing", "save-routing.json");
export const SKILL_PATH = join(REPO_ROOT, "plugins", "claude-code", "skills", "quadron", "SKILL.md");

// The save tools that carry the routing sentence on the server. Bare MCP names (no client prefix);
// the same two names as CAPTURE_RE in test/journey/lib/rows.mjs.
export const SAVE_TOOLS = ["quad_commit", "future_you_capture"];

export const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// Collapse whitespace runs so a re-wrapped description still matches the sentence.
export const norm = (s) => String(s).replace(/\s+/g, " ").trim();

export function readSnapshot(path = SNAPSHOT_PATH) {
  const snap = JSON.parse(readFileSync(path, "utf8"));
  for (const k of ["text", "source", "server_commit", "status", "sha256"]) {
    if (typeof snap[k] !== "string" || snap[k] === "") throw new Error(`${path}: field "${k}" missing or empty`);
  }
  const actual = sha256(snap.text);
  if (actual !== snap.sha256) throw new Error(`${path}: sha256 ${snap.sha256} does not match text (${actual}); update both together`);
  return snap;
}
