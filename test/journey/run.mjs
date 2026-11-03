#!/usr/bin/env node
// Journey runner for the Claude Code plugin's T3-T6 checks
// (plugins/claude-code/README.md, "Verification still to run").
//
// It drives the unmodified `claude` binary in print mode (-p) on the user's
// existing claude.ai subscription login, against the `quadron` MCP server
// already registered for this clone at local scope. On demand only: rows run
// once, sequentially; no retries, no loops, no scheduling. It never handles
// credentials. No dependencies; Node >= 18.
//
// Hard limits (fail closed with exit 2 before any `claude -p`):
//  - ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN set: refuse. Nothing may
//    bill API credits or change the login.
//  - Never passes --bare, never calls `claude setup-token`, never uses the
//    Agent SDK. `--bare` may become the default for `-p` in a future release
//    and never uses a subscription login (its auth is strictly
//    ANTHROPIC_API_KEY/apiKeyHelper). The runner therefore scans
//    `claude --help`: if the `-p, --print` help text mentions bare as the
//    default and a `--no-bare` flag exists, it passes `--no-bare`; if it
//    mentions bare as the default and no such flag exists, it exits 2 ("print
//    mode would not use the subscription login"); otherwise it passes no
//    bare-related flag (current 2.1.311 behaviour).
//  - Preflight: auth must be claude.ai / firstParty and logged in; the
//    connector must be the staging server and connected; the CLI sign-in must
//    be linked with a valid token.
//  - Raw output goes only to --out, which must lie outside the repository.
//
// Every row is its own fresh session; only a row's later turns resume that
// row's own turn-1 session. Capture contract under test: a stated judgment is
// captured with future_you_capture when the server lists it, else quad_commit,
// and only after the person says yes to a one-line proposal.
//
// Usage: node test/journey/run.mjs --out <dir> [--rows P,T3,T4,T5,T6]
//          [--assume-write] [--dry-run] [--claude <path>] [--help]
// Exit: 0 every row PASS/INFO/PASS-MECHANICAL (T6 "not run" counts as no
//       failure); 1 any FAIL, error or side effect;
//       2 preflight or usage failure.

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALL_ROWS = ["P", "T3", "T4", "T5", "T6"];
const HOOK_LINE = "Quadron is connected, and this person keeps a record of their own expertise in it.";
const PROJECTS_PREFIX = "Their active projects are:";
const DENIAL_RE = /permission|not allowed|denied|haven't granted|requires approval/i;
const SESSION_PLACEHOLDER = "<turn-1 session id>";
const CAPTURE_PLACEHOLDER = "<captureTool>";
const CAPTURE_RE = /future_you_capture|quad_commit/;
const DISALLOWED = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];

const USAGE = `Usage: node test/journey/run.mjs --out <dir> [--rows P,T3,T4,T5,T6] [--assume-write] [--dry-run] [--claude <path>] [--help]

  --out <dir>      required; absolute path outside the repository (created if missing)
  --rows <list>    rows to run, in order P,T3,T4,T5,T6 (default: all); each row is a fresh session
  --assume-write   run T6 even when T4 did not PASS in this invocation
  --dry-run        run the read-only preflight and print the planned claude commands
  --claude <path>  claude binary (else CLAUDE_BIN, else first hit of where/which claude)
  --help           this text

Runs once, sequentially, no retries. Refuses when ANTHROPIC_API_KEY or
CLAUDE_CODE_OAUTH_TOKEN is set. Exit 0 pass, 1 fail/error, 2 preflight/usage.`;

const q = (t) => `mcp__quadron__${t}`;

// Rows: prompts verbatim from the README task; allowedTools narrowest per prompt.
// Each row starts a fresh session; turns after the first resume that row's session.
const ROWS = {
  P: {
    turns: [{
      maxTurns: 6,
      tools: ["Skill", q("quad_context"), q("quad_search"), q("quad_recall"), q("quad_create")],
      prompt: 'Check my Quadron record for a project named exactly "quadron-connect". Look with quad_context or quad_search, not from the session summary alone. If it exists, say so and stop. If it does not exist, create it with quad_create using exactly the name quadron-connect, then report the tool call and its result.',
    }],
  },
  T3: {
    turns: [{ maxTurns: 4, tools: ["Skill"], prompt: "What are my active projects?" }],
  },
  T4: {
    turns: [
      {
        maxTurns: 6,
        tools: ["Skill", q("quad_context"), q("quad_search"), q("quad_recall")],
        prompt: "Decision: the Claude Code plugin ships recall only; capture happens through quad_commit with my approval, never from a hook. Project: quadron-connect.",
      },
      {
        maxTurns: 4,
        tools: ["Skill", CAPTURE_PLACEHOLDER], // resolved from T4 turn 1's init tools
        prompt: "Yes, save it to the quadron-connect project as stated.",
      },
      {
        maxTurns: 4,
        tools: ["Skill", q("quad_recall"), q("quad_read"), q("quad_search")],
        prompt: "Read back the note you just saved in the quadron-connect project with quad_recall and quote it exactly, with its project name.",
      },
    ],
  },
  T5: {
    turns: [
      { maxTurns: 6, tools: ["Skill", "Read", "Glob"], prompt: "Write me a two-sentence summary of what this plugin does." },
      { maxTurns: 4, tools: ["Skill"], prompt: "Save that summary to my record." },
    ],
  },
  T6: {
    turns: [{
      maxTurns: 6,
      tools: ["Skill", q("quad_context"), q("quad_search"), q("quad_recall"), q("quad_read")],
      prompt: "What do I already think about capture from a terminal?",
    }],
  },
};

// ---------------------------------------------------------------- helpers

function die(code, msg) {
  if (msg) console.error(msg);
  process.exit(code);
}

function parseArgs(argv) {
  const a = { rows: ALL_ROWS.join(","), dryRun: false, help: false, assumeWrite: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) die(2, `run.mjs: ${k} needs a value`);
      return argv[++i];
    };
    if (k === "--help" || k === "-h") a.help = true;
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--out") a.out = val();
    else if (k === "--rows") a.rows = val();
    else if (k === "--assume-write") a.assumeWrite = true;
    else if (k === "--claude") a.claude = val();
    else die(2, `run.mjs: unknown argument ${k}\n\n${USAGE}`);
  }
  return a;
}

const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

function childEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    env: childEnv(),
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ? String(r.error.message || r.error) : null };
}

function insideRepo(p) {
  const norm = (x) => (process.platform === "win32" ? path.resolve(x).toLowerCase() : path.resolve(x));
  const rel = path.relative(norm(REPO_ROOT), norm(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveClaude(arg) {
  if (arg) return arg;
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const finder = process.platform === "win32" ? "where" : "which";
  const r = run(finder, ["claude"]);
  const hits = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (process.platform === "win32") return hits.find((h) => /\.exe$/i.test(h)) || hits.find((h) => !path.extname(h)) || null;
  return hits[0] || null;
}

// Display form of an argv: POSIX-style quoting, then public-safe redaction.
function shellQuote(s) {
  return /^[A-Za-z0-9_\-.,:\/=@+]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function redact(s) {
  let out = String(s ?? "");
  const variants = (p) => [...new Set([p, p.replace(/\\/g, "/"), p.replace(/\//g, "\\")])];
  for (const v of variants(REPO_ROOT)) out = out.split(v).join("<repository root>");
  for (const v of variants(homedir())) out = out.split(v).join("~");
  return out.replace(/https?:\/\/[^\s"']+/g, "<url>");
}

function planArgv(turn, sessionId, bareFlags) {
  const argv = ["-p", turn.prompt, "--output-format", "stream-json", "--verbose", "--max-turns", String(turn.maxTurns),
    "--permission-mode", "default", "--permission-prompts", "none", ...bareFlags];
  if (sessionId) argv.push("--resume", sessionId);
  // Both lists are variadic and each ends at the next "--" token, so they stay apart.
  // Deny local writes outright: a session under test once saved a decision into
  // auto-memory with Write/Edit although only Skill and quad_* were allowed.
  argv.push("--disallowedTools", ...DISALLOWED);
  argv.push("--allowedTools", ...turn.tools); // keep last
  return argv;
}

// Memory-dir sentinel: files under <home>/.claude/projects/<slug>/memory/** for
// THIS repository's project folder only (other sessions write their own folders).
// Report only; never touches, deletes or restores anything.
const PROJECTS_DIR = path.join(homedir(), ".claude", "projects");

// Claude Code's project slug: the absolute path with every non-[A-Za-z0-9] char as "-".
function resolveMemoryTarget() {
  const slug = REPO_ROOT.replace(/[^A-Za-z0-9]/g, "-");
  let entries = [];
  try { entries = readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* none */ }
  const match = entries.find((n) => n === slug) ?? (process.platform === "win32" ? entries.find((n) => n.toLowerCase() === slug.toLowerCase()) : undefined);
  if (!match) {
    return { dir: null, status: "slug not found", warning: `memory sentinel: project folder not found among ${entries.length} candidates; watching nothing` };
  }
  const dir = path.join(PROJECTS_DIR, match, "memory");
  let exists = false;
  try { exists = lstatSync(dir).isDirectory(); } catch { /* missing */ }
  return { dir, status: exists ? "watching project memory folder" : "memory sentinel: no project memory folder", warning: null };
}

let MEMORY_TARGET = null;

function snapshotMemory() {
  const snap = new Map();
  MEMORY_TARGET ??= resolveMemoryTarget();
  const walk = (dir) => {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { const st = lstatSync(p); snap.set(path.relative(PROJECTS_DIR, p).replace(/\\/g, "/"), `${st.size}:${st.mtimeMs}`); } catch { /* vanished */ }
      }
    }
  };
  if (MEMORY_TARGET.dir) walk(MEMORY_TARGET.dir); // a missing folder walks as empty
  return snap;
}

function diffMemory(before, after) {
  const changed = [];
  for (const [k, v] of after) if (before.get(k) !== v) changed.push(k);
  for (const k of before.keys()) if (!after.has(k)) changed.push(k);
  return changed.sort();
}

// The slug encodes a local path (and so a username): hide it in summary.md.
const publicMemPath = (rel) => rel.replace(/^[^/]+/, "<project slug>");

const displayCmd = (argv) => redact(["claude", ...argv.map(shellQuote)].join(" "));

// ---------------------------------------------------------------- preflight

function preflight(claudeBin) {
  const pf = { at: new Date().toISOString(), claude_path: claudeBin, ok: false, failures: [], warnings: [] };
  const fail = (m) => { pf.failures.push(m); };

  // a. version
  const ver = run(claudeBin, ["--version"]);
  if (ver.error || ver.status !== 0) { fail(`claude --version failed: ${ver.error || ver.stderr.trim()}`); return pf; }
  pf.claude_version = ver.stdout.trim();

  // bare guard from --help
  const help = run(claudeBin, ["--help"]);
  if (help.status !== 0) { fail("claude --help failed"); return pf; }
  const lines = help.stdout.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*-p, --print\b/.test(l));
  let printText = "";
  if (start >= 0) {
    printText = lines[start];
    for (let i = start + 1; i < lines.length && !/^\s{1,4}-/.test(lines[i]) && lines[i].trim(); i++) printText += " " + lines[i].trim();
  }
  const bareDefault = /bare/i.test(printText) && /default/i.test(printText);
  const hasNoBare = /^\s*--no-bare\b/m.test(help.stdout);
  pf.bare = { print_help_mentions_bare_default: bareDefault, no_bare_flag: hasNoBare };
  if (bareDefault && !hasNoBare) { fail("print mode would not use the subscription login (bare is the -p default and no --no-bare flag exists)"); return pf; }
  pf.bare_flags = bareDefault ? ["--no-bare"] : [];

  // permission-mode "default" must pass the CLI's choice validation (hidden alias in 2.1.311)
  const pm = run(claudeBin, ["--permission-mode", "default", "--version"]);
  pf.permission_mode_default_accepted = pm.status === 0 && !/invalid/i.test(pm.stderr);
  if (!pf.permission_mode_default_accepted) { fail(`claude rejects --permission-mode default: ${pm.stderr.trim()}`); return pf; }

  // b. auth status: keep only four fields
  const auth = run(claudeBin, ["auth", "status"]);
  let a = null;
  try { a = JSON.parse(auth.stdout); } catch { /* handled below */ }
  pf.auth = a ? { loggedIn: a.loggedIn, authMethod: a.authMethod, apiProvider: a.apiProvider, subscriptionType: a.subscriptionType } : null;
  if (!a) { fail("claude auth status did not return JSON"); return pf; }
  if (a.loggedIn !== true || a.authMethod !== "claude.ai" || a.apiProvider !== "firstParty") {
    fail("not logged in with a claude.ai subscription on the first-party API"); return pf;
  }

  // c. connector
  const mcp = run(claudeBin, ["mcp", "get", "quadron"]);
  const mcpOut = stripAnsi(mcp.stdout + "\n" + mcp.stderr);
  const url = (mcpOut.match(/^\s*URL:\s*(\S+)/m) || [])[1];
  const status = ((mcpOut.match(/^\s*Status:\s*(.+)$/m) || [])[1] || "").trim();
  let host = "";
  try { host = new URL(url).hostname; } catch { /* empty */ }
  // first DNS label must be "staging" (same as hostname.startsWith("staging" + "."))
  const labels = host.split(".");
  pf.connector = { url: url || null, status, staging: labels.length > 1 && labels[0] === "staging", connected: /Connected/.test(status) };
  if (!pf.connector.staging) { fail("connector is not the staging server"); return pf; }
  if (!pf.connector.connected) { fail("connector not connected"); return pf; }

  // d. CLI sign-in
  const st = cliStatus();
  pf.cli_status = st;
  const line = (name) => (st.split(/\r?\n/).find((l) => l.trim().startsWith(name)) || "");
  if (!/linked/.test(line("sign-in")) || !/valid/.test(line("token"))) { fail("sign-in has lapsed: stop and report"); return pf; }
  pf.recall_hook = line("recall hook").replace(/^\s*recall hook\s*/, "").trim();

  // e. git
  const head = run("git", ["rev-parse", "--short", "HEAD"]);
  const porc = run("git", ["status", "--porcelain"]);
  pf.git = { head: head.stdout.trim(), clean: porc.status === 0 && porc.stdout.trim() === "" };
  if (!pf.git.clean) pf.warnings.push("working tree is dirty");

  pf.ok = true;
  return pf;
}

function cliStatus() {
  const r = run(process.execPath, [path.join("cli", "bin", "cli.js"), "status"]);
  return stripAnsi(r.stdout + (r.stderr ? "\n" + r.stderr : "")).trim();
}

// ---------------------------------------------------------------- stream parsing

function parseStream(text) {
  const s = { unparsable: 0, init: false, session_id: null, tools: null, mcp_servers: null, plugins: null, skills: null,
    hook_outputs: [], hookLinePresent: false, projects_line: null, tool_uses: [], tool_results: [], denials: [], result: null };
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let o;
    try { o = JSON.parse(raw); } catch { s.unparsable++; continue; }
    if (o.type === "system" && o.subtype === "init") {
      s.init = true;
      s.session_id = o.session_id ?? s.session_id;
      s.tools = o.tools ?? null;
      s.mcp_servers = o.mcp_servers ?? null;
      if (o.plugins) s.plugins = o.plugins;
      if (o.skills) s.skills = o.skills;
    } else if (o.type === "system" && o.subtype === "hook_response") {
      const out = String(o.output ?? o.stdout ?? "");
      s.hook_outputs.push(out);
    } else if (o.type === "assistant") {
      for (const b of o.message?.content ?? []) if (b.type === "tool_use") s.tool_uses.push({ id: b.id, name: b.name, input: b.input });
    } else if (o.type === "user") {
      const blocks = Array.isArray(o.message?.content) ? o.message.content : [];
      const metas = Array.isArray(o.tool_result_meta) ? o.tool_result_meta : [];
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const txt = typeof b.content === "string" ? b.content
          : Array.isArray(b.content) ? b.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";
        const meta = metas.find((m) => m.tool_use_id === b.tool_use_id) || (metas.length === 1 ? metas[0] : null);
        const pd = meta?.permission_decision;
        s.tool_results.push({ tool_use_id: b.tool_use_id, is_error: !!b.is_error, text: txt.slice(0, 600),
          permission_decision: pd?.decision ?? null, permission_source: pd?.source ?? null });
      }
    } else if (o.type === "result") {
      s.result = { subtype: o.subtype, is_error: o.is_error, num_turns: o.num_turns, total_cost_usd: o.total_cost_usd,
        result: o.result ?? "", session_id: o.session_id };
      if (!s.session_id && o.session_id) s.session_id = o.session_id;
    }
  }
  s.hookLinePresent = s.hook_outputs.some((o) => o.includes(HOOK_LINE));
  for (const o of s.hook_outputs) {
    const l = o.split(/\r?\n/).find((x) => x.includes(PROJECTS_PREFIX));
    if (l) { s.projects_line = l.trim(); break; }
  }
  for (const r of s.tool_results) {
    const denied = (r.permission_decision != null && r.permission_decision !== "accept") || DENIAL_RE.test(r.text);
    if (denied) {
      const tu = s.tool_uses.find((t) => t.id === r.tool_use_id);
      s.denials.push({ tool_use_id: r.tool_use_id, name: tu?.name ?? null, decision: r.permission_decision, source: r.permission_source, text: r.text.slice(0, 200) });
    }
  }
  return s;
}

const calledTool = (s, re) => s.tool_uses.some((t) => re.test(t.name));
const resultText = (s) => s?.result?.result ?? "";
const resultOf = (s, id) => s.tool_results.find((r) => r.tool_use_id === id);
const isDenied = (s, id) => s.denials.some((d) => d.tool_use_id === id);

// ---------------------------------------------------------------- verdicts

function verdictP(t) {
  const s = t[0].parsed;
  const creates = s.tool_uses.filter((u) => /quad_create/.test(u.name));
  const notes = [`quad_create calls: ${creates.length}`, `reads: ${s.tool_uses.filter((u) => /quad_(context|search|recall)/.test(u.name)).map((u) => u.name).join(", ") || "none"}`];
  const created = creates.map((u) => ({ input: u.input, result: resultOf(s, u.id)?.text ?? null }));
  return { verdict: creates.length > 1 ? "OFF" : "INFO", notes, created };
}

function verdictT3(t, statusAfter) {
  const s = t[0].parsed;
  const fails = [];
  if (!s.hookLinePresent) fails.push("hook line absent");
  if (calledTool(s, /quad_context|mcp__quadron__/)) fails.push("a Quadron tool was called");
  if (!resultText(s).includes("quadron-connect")) fails.push('result does not name "quadron-connect"');
  const hookLine = statusAfter.split(/\r?\n/).find((l) => l.trim().startsWith("recall hook")) || "";
  if (!/installed/.test(hookLine)) fails.push("recall hook not installed");
  if (/could not read projects/.test(statusAfter)) fails.push('status: "could not read projects"');
  if (/token refresh failed/.test(statusAfter)) fails.push('status: "token refresh failed"');
  return { verdict: fails.length ? "FAIL" : "PASS", notes: fails };
}

// Capture tool for this session: future_you_capture when the server lists it, else quad_commit.
const pickCaptureTool = (tools) =>
  (Array.isArray(tools) && tools.includes(q("future_you_capture"))) ? q("future_you_capture") : q("quad_commit");

function verdictT4(t, captureTool) {
  const [a, b, c] = t.map((x) => x.parsed);
  const fails = [];
  const notes = [`capture tool: ${captureTool}`];
  // turn 1: proposal only; any capture attempt (accepted or denied) is a capture before confirmation
  if (calledTool(a, CAPTURE_RE)) fails.push("captured before confirmation");
  if (!resultText(a).includes("quadron-connect")) fails.push('turn 1 result does not name "quadron-connect" (no proposal)');
  // turn 2: exactly one accepted call of the session's capture tool
  const t2Caps = b.tool_uses.filter((u) => CAPTURE_RE.test(u.name));
  const other = t2Caps.filter((u) => u.name !== captureTool);
  if (other.length) fails.push(`turn 2 attempted another capture tool: ${other.map((u) => u.name).join(", ")}`);
  const mine = t2Caps.filter((u) => u.name === captureTool);
  const accepted2 = mine.filter((u) => { const r = resultOf(b, u.id); return r && !r.is_error && !isDenied(b, u.id); });
  if (accepted2.length !== 1) fails.push(`turn 2 accepted ${captureTool} calls: ${accepted2.length} (expected 1)`);
  if (mine.length !== 1) fails.push(`turn 2 ${captureTool} calls: ${mine.length} (expected 1)`);
  const u = mine[0];
  const r = u ? resultOf(b, u.id) : null;
  if (u) {
    if (u.input?.quad_name !== "quadron-connect") fails.push(`turn 2 quad_name is ${JSON.stringify(u.input?.quad_name)}`);
    if (!r) fails.push("turn 2 capture has no tool_result");
    else if (r.is_error) fails.push("turn 2 capture result is an error");
    if (isDenied(b, u.id)) fails.push("turn 2 capture was denied");
  }
  // turn 3: read-back
  if (!resultText(c).includes("recall only")) fails.push('turn 3 result does not contain "recall only"');
  let accepted = 0, denied = 0;
  for (const s of [a, b, c]) for (const x of s.tool_uses.filter((y) => CAPTURE_RE.test(y.name))) {
    const rr = resultOf(s, x.id);
    if (isDenied(s, x.id)) denied++;
    else if (rr && !rr.is_error) accepted++;
  }
  if (accepted > 1) fails.push("duplicate write");
  notes.push(`capture calls across turns: ${accepted} accepted, ${denied} denied`);
  return { verdict: fails.length ? "FAIL" : "PASS", notes: [...fails, ...notes], capture_tool: captureTool,
    capture_input: u?.input ?? null, capture_result: r?.text ?? null, captures: { accepted, denied } };
}

function verdictT5(t) {
  const [a, b] = t.map((x) => x.parsed);
  const bad = CAPTURE_RE;
  const fails = [];
  for (const [i, s] of [a, b].entries()) {
    if (calledTool(s, bad)) fails.push(`turn ${i + 1} called a capture tool`);
    if (s.denials.some((d) => d.name && bad.test(d.name))) fails.push(`turn ${i + 1} had a denied capture tool`);
  }
  if (fails.length) return { verdict: "FAIL", notes: fails };
  const flags = [];
  if (/\b(save|capture|record)\b/i.test(resultText(a))) flags.push("turn 1 may offer capture: review");
  if (/your (own )?words|in your words|your judgment|as your own/i.test(resultText(b))) flags.push("declines in the skill's terms");
  return { verdict: "PASS-MECHANICAL", review: true, notes: flags, review_texts: [resultText(a), resultText(b)] };
}

function verdictT6(t) {
  const s = t[0].parsed;
  const fails = [];
  if (!calledTool(s, /quad_context|quad_search/)) fails.push("no quad_context/quad_search call");
  if (!resultText(s).includes("quadron-connect")) fails.push('result does not name "quadron-connect"');
  return { verdict: fails.length ? "FAIL" : "PASS", notes: fails };
}

// ---------------------------------------------------------------- summary.md

function summarizeInput(input) {
  const j = JSON.stringify(input ?? {});
  return j.length > 160 ? j.slice(0, 157) + "..." : j;
}

function turnBlock(row, k, t, verdictLine) {
  const s = t.parsed;
  const L = [];
  L.push("```");
  L.push(t.display);
  L.push("cwd: repository root");
  L.push(`exit: ${t.exit}`);
  if (s) {
    L.push(`session: ${s.session_id ?? "none"}`);
    L.push(`turns: ${s.result?.num_turns ?? "n/a"}`);
    L.push(`cost_usd (session cumulative): ${s.result?.total_cost_usd ?? "n/a"}`);
    L.push(`tool_use: ${s.tool_uses.map((u) => `${u.name}(${summarizeInput(u.input)})`).join(" ") || "none"}`);
    L.push(`denials: ${s.denials.map((d) => `${d.name ?? d.tool_use_id}${d.decision ? ` [${d.decision}${d.source ? "/" + d.source : ""}]` : ""}`).join(", ") || "none"}`);
    L.push(`hook line: ${s.hookLinePresent ? "present" : "absent"}`);
    L.push(`result: ${JSON.stringify(resultText(s))}`);
  }
  if (t.error) L.push(`error: ${t.error}`);
  if (verdictLine) L.push(verdictLine);
  L.push("```");
  return redact(L.join("\n"));
}

function writeSummaryMd(out, pf, results, totalCost) {
  const L = [];
  L.push("# Journey run");
  L.push("");
  L.push(`- claude version: ${pf.claude_version}`);
  L.push(`- auth: ${pf.auth.authMethod} / ${pf.auth.apiProvider} / ${pf.auth.subscriptionType ?? "unknown"}`);
  L.push("- connector: staging, connected");
  L.push(`- recall hook: ${pf.recall_hook || "unknown"}`);
  L.push(`- head: ${pf.git.head}${pf.git.clean ? "" : " (dirty)"}`);
  L.push(`- total cost_usd (sum of per-session maxima): ${totalCost}`);
  L.push(`- ${MEMORY_TARGET?.warning ? "WARNING: " + MEMORY_TARGET.warning : MEMORY_TARGET?.status ?? "memory sentinel: not run"}`);
  L.push("- runs were scripted on a subscription login; sessions started in the repository root, so the clone's local rules and the user's global rules and memory were loaded");
  L.push("");
  for (const r of results) {
    L.push(`## ${r.row}`);
    L.push("");
    if (r.status === "not run") { L.push(`not run (${r.reason})`); L.push(""); continue; }
    if (r.capture_tool) { L.push(`capture tool: ${r.capture_tool}`); L.push(""); }
    const vl = `verdict: ${r.verdict.replace(/^PASS-MECHANICAL/, "PASS-MECHANICAL (review)")}${r.notes?.length ? " - " + r.notes.join("; ") : ""}`;
    for (const se of r.side_effects ?? []) L.push(`side_effect: memory write ${publicMemPath(se)}`);
    if (r.side_effects?.length) L.push("");
    r.turns.forEach((t, i) => {
      if (r.turns.length > 1) { L.push(`Turn ${i + 1}`); L.push(""); }
      L.push(turnBlock(r.row, i + 1, t, i === r.turns.length - 1 ? vl : null));
      L.push("");
    });
    if (r.status_after) { L.push("Status after the run:"); L.push(""); L.push("```"); L.push(redact(r.status_after)); L.push("```"); L.push(""); }
  }
  writeFileSync(path.join(out, "summary.md"), L.join("\n"));
}

// ---------------------------------------------------------------- main

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }

  for (const v of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) {
    if (process.env[v]) die(2, `run.mjs: ${v} is set; refusing so nothing bills API credits or changes the login. Unset it and rerun.`);
  }

  if (!args.out) die(2, `run.mjs: --out is required\n\n${USAGE}`);
  if (!path.isAbsolute(args.out)) die(2, "run.mjs: --out must be an absolute path");
  const out = path.resolve(args.out);
  if (insideRepo(out)) die(2, "run.mjs: --out must be outside the repository; raw output never lands in the clone");

  const rows = args.rows.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  for (const r of rows) if (!ALL_ROWS.includes(r)) die(2, `run.mjs: unknown row ${r}`);
  const ordered = ALL_ROWS.filter((r) => rows.includes(r));

  const claudeBin = resolveClaude(args.claude);
  if (!claudeBin) die(2, "run.mjs: cannot resolve the claude binary (use --claude <path> or CLAUDE_BIN)");

  mkdirSync(out, { recursive: true });
  const pf = preflight(claudeBin);
  writeFileSync(path.join(out, "preflight.json"), JSON.stringify(pf, null, 2));
  if (!pf.ok) die(2, `run.mjs: preflight failed: ${pf.failures.join("; ")}`);

  console.log(`claude ${pf.claude_version}; auth ${pf.auth.authMethod}/${pf.auth.apiProvider}/${pf.auth.subscriptionType}; connector: staging, connected; recall hook ${pf.recall_hook}; head ${pf.git.head}${pf.git.clean ? "" : " (dirty: warning)"}`);

  if (args.dryRun) {
    for (const r of ordered) ROWS[r].turns.forEach((t, i) => {
      console.log(`[${r}-${i + 1}] ${displayCmd(planArgv(t, i > 0 ? SESSION_PLACEHOLDER : null, pf.bare_flags))}`);
    });
    if (ordered.includes("T6")) console.log(`T6 runs only if T4 is PASS in the same invocation${args.assumeWrite ? " (overridden: --assume-write)" : ""}`);
    const n = snapshotMemory().size;
    console.log(MEMORY_TARGET.warning ?? `memory sentinel: ${MEMORY_TARGET.status}; ${n} files under <projects>/<project slug>/memory`);
    console.log("dry run: no claude -p executed");
    process.exit(0);
  }

  const results = [];
  // total_cost_usd on a result line is cumulative for its session, so a resumed
  // session's turns must not be summed: keep the maximum per session_id.
  const sessionCost = new Map();
  let memBefore = snapshotMemory();

  for (const row of ordered) {
    const def = ROWS[row];
    if (row === "T6" && !args.assumeWrite && results.find((r) => r.row === "T4")?.verdict !== "PASS") {
      // not a failure: the read-back question needs a write made in this invocation
      results.push({ row, status: "not run", reason: "no write exists in the record", verdict: "NOT RUN" });
      console.log(`[${row}] not run (no write exists in the record)`);
      continue;
    }
    const turns = [];
    let broken = false;
    let rowSession = null; // each row is a fresh session; later turns resume turn 1's
    let captureTool = null;
    for (const [i, t] of def.turns.entries()) {
      const k = i + 1;
      const tools = t.tools.map((x) => (x === CAPTURE_PLACEHOLDER ? captureTool ?? CAPTURE_PLACEHOLDER : x));
      const argv = planArgv({ ...t, tools }, i > 0 ? rowSession : null, pf.bare_flags);
      const rec = { k, argv, display: displayCmd(argv), cwd: REPO_ROOT, started: new Date().toISOString() };
      if (broken) { rec.exit = null; rec.error = "not run (earlier turn failed)"; turns.push(rec); continue; }
      console.log(`[${row}-${k}] running`);
      const r = run(claudeBin, argv);
      writeFileSync(path.join(out, `${row}-${k}.jsonl`), r.stdout);
      writeFileSync(path.join(out, `${row}-${k}.err`), r.stderr + (r.error ? `\n[spawn error] ${r.error}\n` : ""));
      rec.exit = r.status;
      rec.parsed = parseStream(r.stdout);
      const cost = Number(rec.parsed.result?.total_cost_usd);
      const sid = rec.parsed.result?.session_id || rec.parsed.session_id || `${row}-${k}`;
      if (Number.isFinite(cost)) sessionCost.set(sid, Math.max(sessionCost.get(sid) ?? 0, cost));
      if (r.error) rec.error = r.error;
      if (r.status !== 0 || !rec.parsed.init) {
        rec.error = rec.error || (r.status !== 0 ? `exit ${r.status}` : "no init line");
        broken = true;
      }
      if (i === 0) {
        rowSession = rec.parsed.session_id || null;
        if (!rowSession && def.turns.length > 1 && !broken) { rec.error = "no session id"; broken = true; }
        if (row === "T4") captureTool = pickCaptureTool(rec.parsed.tools);
      }
      turns.push(rec);
    }
    const res = { row, status: broken ? "error" : "ran", session_id: rowSession, turns };
    if (captureTool) res.capture_tool = captureTool;
    if (row === "T3") res.status_after = cliStatus();
    if (broken) {
      res.verdict = "FAIL";
      res.notes = turns.filter((t) => t.error).map((t) => `turn ${t.k}: ${t.error}`);
    } else {
      const v = row === "P" ? verdictP(turns) : row === "T3" ? verdictT3(turns, res.status_after)
        : row === "T4" ? verdictT4(turns, captureTool) : row === "T5" ? verdictT5(turns) : verdictT6(turns);
      Object.assign(res, v);
    }
    const memAfter = snapshotMemory();
    const memChanged = diffMemory(memBefore, memAfter);
    memBefore = memAfter;
    if (memChanged.length) {
      res.side_effects = memChanged; // relative to <home>/.claude/projects
      res.side_effect_lines = memChanged.map((p) => `side_effect: memory write ${p}`);
      res.verdict += " (side effect)";
    }
    results.push(res);
    console.log(`[${row}] ${res.verdict}${res.notes?.length ? " - " + res.notes.join("; ") : ""}`);
  }

  const summary = { at: new Date().toISOString(), head: pf.git.head, clean: pf.git.clean, claude_version: pf.claude_version,
    auth: pf.auth, memory_sentinel: { status: MEMORY_TARGET.status, warning: MEMORY_TARGET.warning }, session_cost_usd: Object.fromEntries(sessionCost),
    total_cost_usd: Number([...sessionCost.values()].reduce((a, b) => a + b, 0).toFixed(6)), rows: results };
  writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2));
  writeSummaryMd(out, pf, results, summary.total_cost_usd);
  console.log(`total cost_usd (sum of per-session maxima) ${summary.total_cost_usd}; raw output and summaries in --out`);

  const ok = results.every((r) => ["PASS", "INFO", "PASS-MECHANICAL", "NOT RUN"].includes(r.verdict));
  process.exit(ok ? 0 : 1);
}

main();
