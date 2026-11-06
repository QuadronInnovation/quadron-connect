#!/usr/bin/env node
// Writes the save-routing block of the plugin skill from the committed snapshot
// (plugins/claude-code/routing/save-routing.json). The block between the markers is generated:
// change the snapshot and re-run this script, never edit the block by hand.
//
//   node scripts/gen-routing.mjs            rewrite the block in SKILL.md
//   node scripts/gen-routing.mjs --check    exit 1 if SKILL.md differs from what would be written
//   --snapshot <path>  --skill <path>       override the default files (used by the tests)
//
// Exit codes: 0 written or in sync; 1 --check found a difference; 2 bad input (snapshot, markers).
// Reads only repository files. Node >= 18, no dependencies.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SKILL_PATH, SNAPSHOT_PATH, readSnapshot } from "./lib/routing.mjs";

export const BEGIN = "<!-- BEGIN GENERATED: save-routing (scripts/gen-routing.mjs; do not edit) -->";
export const END = "<!-- END GENERATED: save-routing -->";

// The sentence addresses a tool ("with this tool"), so the lead-in names the tool it belongs to and
// the sentence is quoted verbatim.
export const LEAD_IN = "Save requests go to the Quadron capture tool (`future_you_capture` or `quad_commit`, as the rules below decide), never to built-in memory or files. The Quadron capture tool's description says:";

export const renderBlock = (snap) => `${BEGIN}\n${LEAD_IN}\n\n> ${snap.text}\n${END}`;

export function generate(skillText, snap) {
  const b = skillText.split(BEGIN).length - 1;
  const e = skillText.split(END).length - 1;
  if (b !== 1 || e !== 1) throw new Error(`expected exactly one BEGIN and one END marker, found ${b} and ${e}`);
  const start = skillText.indexOf(BEGIN);
  const stop = skillText.indexOf(END) + END.length;
  if (stop < start) throw new Error("END marker comes before BEGIN marker");
  return skillText.slice(0, start) + renderBlock(snap) + skillText.slice(stop);
}

function main(argv) {
  let check = false;
  let snapshotPath = SNAPSHOT_PATH;
  let skillPath = SKILL_PATH;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") check = true;
    else if (a === "--snapshot") snapshotPath = argv[++i];
    else if (a === "--skill") skillPath = argv[++i];
    else { console.error(`unknown argument: ${a}`); return 2; }
  }
  let current, next;
  try {
    const snap = readSnapshot(snapshotPath);
    current = readFileSync(skillPath, "utf8");
    next = generate(current, snap);
  } catch (err) {
    console.error(`gen-routing: ${err.message}`);
    return 2;
  }
  if (check) {
    if (current === next) { console.log(`OK ${skillPath} matches ${snapshotPath}`); return 0; }
    console.error(`DIFF ${skillPath} differs from the snapshot; run: node scripts/gen-routing.mjs`);
    return 1;
  }
  if (current === next) { console.log(`unchanged ${skillPath}`); return 0; }
  writeFileSync(skillPath, next, "utf8");
  console.log(`wrote ${skillPath}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
