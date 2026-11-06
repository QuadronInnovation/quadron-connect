#!/usr/bin/env node
// Local-only: run before merging; not wired into public CI.
//
// Compares the committed save-routing snapshot (plugins/claude-code/routing/save-routing.json) with
// a saved dump of the Quadron MCP server's tools/list result. Makes no network calls: whoever runs it
// produces the dump separately and passes its path.
//
//   node scripts/routing-drift.mjs <tools-list.json>
//       [--tools quad_commit,future_you_capture]   save tools that must carry the sentence
//       [--expect-instructions <file>]             also require the sentence in the server's
//                                                  instructions (off by default; the sentence is not
//                                                  in the instructions today)
//       [--snapshot <path>]
//
// The dump may be the tools/list result ({"tools":[...]}) or the JSON-RPC response around it
// ({"result":{"tools":[...]}}). The instructions file may be plain text, or JSON holding
// "instructions" or "result.instructions" (an initialize response).
// Whitespace runs are collapsed before comparing. Tools not named in --tools are ignored.
//
// Prints one OK or DRIFT row per check. Exit codes: 0 all OK; 1 drift; 2 bad input.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { SAVE_TOOLS, SNAPSHOT_PATH, norm, readSnapshot } from "./lib/routing.mjs";

export function toolsFrom(dump) {
  const tools = dump?.result?.tools ?? dump?.tools;
  if (!Array.isArray(tools)) throw new Error("dump holds no tools array (expected tools or result.tools)");
  return tools;
}

export function instructionsFrom(raw) {
  try {
    const j = JSON.parse(raw);
    const s = typeof j === "string" ? j : j?.result?.instructions ?? j?.instructions;
    if (typeof s === "string") return s;
  } catch { /* plain text */ }
  return raw;
}

// Returns rows [{ status: "OK"|"DRIFT", subject, detail }].
export function checkDrift({ text, tools, saveTools = SAVE_TOOLS, instructions = null }) {
  const want = norm(text);
  const rows = [];
  for (const name of saveTools) {
    const tool = tools.find((t) => t?.name === name);
    if (!tool) rows.push({ status: "DRIFT", subject: `tool ${name}`, detail: "not in tools/list" });
    else if (norm(tool.description ?? "").includes(want)) rows.push({ status: "OK", subject: `tool ${name}`, detail: "description carries the snapshot text" });
    else rows.push({ status: "DRIFT", subject: `tool ${name}`, detail: "description lacks the snapshot text" });
  }
  if (instructions !== null) {
    if (norm(instructions).includes(want)) rows.push({ status: "OK", subject: "instructions", detail: "carry the snapshot text" });
    else rows.push({ status: "DRIFT", subject: "instructions", detail: "lack the snapshot text" });
  }
  return rows;
}

function main(argv) {
  let dumpPath = null;
  let instructionsPath = null;
  let snapshotPath = SNAPSHOT_PATH;
  let saveTools = SAVE_TOOLS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tools") saveTools = String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--expect-instructions") instructionsPath = argv[++i];
    else if (a === "--snapshot") snapshotPath = argv[++i];
    else if (a.startsWith("--")) { console.error(`unknown option: ${a}`); return 2; }
    else if (dumpPath === null) dumpPath = a;
    else { console.error(`unexpected argument: ${a}`); return 2; }
  }
  if (!dumpPath) { console.error("usage: node scripts/routing-drift.mjs <tools-list.json> [--tools a,b] [--expect-instructions <file>]"); return 2; }
  if (saveTools.length === 0 || (instructionsPath !== null && instructionsPath === undefined)) { console.error("empty --tools or missing --expect-instructions path"); return 2; }
  let rows;
  try {
    const snap = readSnapshot(snapshotPath);
    const tools = toolsFrom(JSON.parse(readFileSync(dumpPath, "utf8")));
    const instructions = instructionsPath ? instructionsFrom(readFileSync(instructionsPath, "utf8")) : null;
    rows = checkDrift({ text: snap.text, tools, saveTools, instructions });
  } catch (err) {
    console.error(`routing-drift: ${err.message}`);
    return 2;
  }
  for (const r of rows) console.log(`${r.status} ${r.subject}: ${r.detail}`);
  return rows.some((r) => r.status === "DRIFT") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
