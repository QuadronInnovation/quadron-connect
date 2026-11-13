#!/usr/bin/env node
// PostToolUse hook (Write|Edit). When Claude saves an auto-memory file or updates a
// CLAUDE.md / CLAUDE.local.md, inject one line of context nudging it to offer a Quadron
// capture. Context only: it never calls a tool and never blocks one. Fails open.
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { CAPTURE_RULE } from './capture-rule.mjs';

export const EXCERPT_MAX = 200;

// After the root: <project>/memory/<file or subpath>.md
const MEMORY_TAIL_RE = /^[^/]+\/memory\/(?:[^/]+\/)*[^/]+\.md$/;
const PROJECTS = '/projects/';

// Slashes forward, `.`/`..` resolved, no trailing slash. C:\x and the /c/x form Claude Code
// matches rules against become one key, compared case-insensitively.
export function normalisePath(p) {
  let s = String(p).replace(/\\/g, '/');
  const drive = /^([a-zA-Z]):(?:\/|$)/.exec(s);
  if (drive) s = `/${drive[1]}/${s.slice(drive[0].length)}`;
  s = path.posix.normalize(s);
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return isWinForm(s) ? s.toLowerCase() : s;
}

function isWinForm(p) {
  return /^\/[a-zA-Z](?:\/|$)/.test(p);
}

function basename(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

// Every <root> for which p is <root>/projects/<project>/memory/<...>.md.
function memoryRoots(p) {
  const roots = [];
  for (let i = p.indexOf(PROJECTS); i !== -1; i = p.indexOf(PROJECTS, i + 1)) {
    if (MEMORY_TAIL_RE.test(p.slice(i + PROJECTS.length))) roots.push(p.slice(0, i));
  }
  return roots;
}

// hooks.json has no path filter (removed in 0.2.2); this function does all the narrowing.
// <root> must be the config directory wherever that is known: equal to CLAUDE_CONFIG_DIR when
// set, and the parent of the `projects` directory holding transcript_path when that has one
// (any project there: memory is keyed by the git root, the transcript by the cwd). Each known
// source must agree. With neither, the path shape alone decides. Known limit: the comparison is
// textual, so a config directory reached through a symlink, or one differing only in letter case
// on a case-insensitive POSIX filesystem, is not matched by the CLAUDE_CONFIG_DIR check.
function isConfigRoot(root, where) {
  if (where.configDir && root !== normalisePath(where.configDir)) return false;
  if (where.transcriptPath) {
    const t = normalisePath(where.transcriptPath);
    if (t.includes(PROJECTS) && !t.startsWith(root + PROJECTS)) return false;
  }
  return true;
}

// CLAUDE_CONFIG_DIR as a narrowing key: a leading `~` expands to the home directory; a value
// that is still not absolute (POSIX, C:\ or C:/, /c/) is ignored, as if unset, so an unusable
// value never silences a memory write. Returns '' when it is not to be used.
export function usableConfigDir(raw, home) {
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') return '';
  if (s === '~' || /^~[\\/]/.test(s)) {
    let h;
    try {
      h = home === undefined ? os.homedir() : home;
    } catch {
      return '';
    }
    if (typeof h !== 'string' || h === '') return '';
    s = h.replace(/[\\/]+$/, '') + s.slice(1);
  }
  return /^(?:[\\/]|[a-zA-Z]:[\\/])/.test(s) ? s : '';
}

// Returns 'memory', 'instructions' or null. `where` carries { configDir, transcriptPath }.
export function classifyPath(filePath, where = {}) {
  if (typeof filePath !== 'string' || filePath === '') return null;
  const p = normalisePath(filePath);
  const lower = p.toLowerCase();
  const isWin = isWinForm(p);
  const base = basename(p);
  const eq = (a, b) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (lower.includes('/agent-memory/') || lower.includes('/agent-memory-local/')) return null;
  if (eq(base, 'MEMORY.md')) return null;
  if (eq(base, 'CLAUDE.md') || eq(base, 'CLAUDE.local.md')) return 'instructions';
  if (memoryRoots(p).some((root) => isConfigRoot(root, where))) return 'memory';
  return null;
}

export function stripFrontmatter(text) {
  const s = String(text).replace(/^﻿/, '');
  const m = /^\s*---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(s);
  return m ? s.slice(m[0].length) : s;
}

export function excerpt(text, max = EXCERPT_MAX) {
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  const chars = Array.from(collapsed);
  if (chars.length <= max) return collapsed;
  return chars.slice(0, max).join('') + '…';
}

export function contextText(kind, ex) {
  const what = kind === 'instructions'
    ? 'you just updated their instructions file'
    : 'you just saved a memory';
  return `Quadron: ${what}: "${ex}". If it records the person's own decision, standard or preference, it may belong in their Quadron record. ${CAPTURE_RULE} If it is your own note, do nothing.`;
}

const silent = () => ({ stdout: '', stderr: '', exitCode: 0 });
const failOpen = (why) => ({
  stdout: '',
  stderr: `quadron memory-trigger: ${String(why).replace(/\s+/g, ' ')}\n`,
  exitCode: 0,
});

// `home` is for tests; unset, a leading `~` in CLAUDE_CONFIG_DIR uses os.homedir().
export function decide(payload, env = process.env, home = undefined) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return failOpen('input is not a JSON object; skipped');
  }
  if (payload.hook_event_name !== 'PostToolUse') {
    return failOpen(`unexpected event ${JSON.stringify(payload.hook_event_name ?? null)}; skipped`);
  }
  const tool = payload.tool_name;
  if (tool !== 'Write' && tool !== 'Edit') return silent();
  const input = payload.tool_input;
  if (input === null || typeof input !== 'object') return silent();
  const where = {
    configDir: usableConfigDir(env ? env.CLAUDE_CONFIG_DIR : undefined, home),
    transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : '',
  };
  const kind = classifyPath(input.file_path, where);
  if (!kind) return silent();
  const raw = tool === 'Write' ? input.content : input.new_string;
  if (typeof raw !== 'string') return silent();
  const body = stripFrontmatter(raw);
  if (body.trim() === '') return silent();
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: contextText(kind, excerpt(body)),
    },
  };
  return { stdout: JSON.stringify(out) + '\n', stderr: '', exitCode: 0 };
}

export function run(rawStdin, env = process.env, home = undefined) {
  const text = String(rawStdin ?? '');
  if (text.trim() === '') return failOpen('empty stdin; skipped');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return failOpen('stdin is not valid JSON; skipped');
  }
  return decide(payload, env, home);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function isMain() {
  try {
    return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  let r;
  try {
    r = run(await readStdin());
  } catch (e) {
    r = failOpen(`internal error: ${e && e.message ? e.message : e}`);
  }
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.exitCode;
}
