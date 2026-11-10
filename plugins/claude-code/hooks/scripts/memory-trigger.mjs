#!/usr/bin/env node
// PostToolUse hook (Write|Edit). When Claude saves an auto-memory file or updates a
// CLAUDE.md / CLAUDE.local.md, inject one line of context nudging it to offer a Quadron
// capture. Context only: it never calls a tool and never blocks one. Fails open.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const EXCERPT_MAX = 200;

const MEMORY_RE = /\/\.claude\/projects\/.+\/memory\/[^/]+\.md$/;

export function normalisePath(p) {
  let s = String(p).replace(/\\/g, '/');
  // Windows drive paths compare case-insensitively.
  if (/^[a-zA-Z]:\//.test(s)) s = s.toLowerCase();
  return s;
}

function basename(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

// Returns 'memory', 'instructions' or null.
export function classifyPath(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return null;
  const p = normalisePath(filePath);
  const lower = p.toLowerCase();
  const isWin = /^[a-z]:\//.test(p);
  const base = basename(p);
  const eq = (a, b) => (isWin ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (lower.includes('/agent-memory/') || lower.includes('/agent-memory-local/')) return null;
  if (eq(base, 'MEMORY.md')) return null;
  if (eq(base, 'CLAUDE.md') || eq(base, 'CLAUDE.local.md')) return 'instructions';
  if (MEMORY_RE.test(p)) return 'memory';
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
  return `Quadron: ${what}: "${ex}". If it records the person's own decision, standard or preference, offer once in one line to keep it in their Quadron record, quoting their words; call future_you_capture (or quad_commit if that is not listed) only on a yes. If it is your own note, do nothing.`;
}

const silent = () => ({ stdout: '', stderr: '', exitCode: 0 });
const failOpen = (why) => ({
  stdout: '',
  stderr: `quadron memory-trigger: ${String(why).replace(/\s+/g, ' ')}\n`,
  exitCode: 0,
});

export function decide(payload) {
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
  const kind = classifyPath(input.file_path);
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

export function run(rawStdin) {
  const text = String(rawStdin ?? '');
  if (text.trim() === '') return failOpen('empty stdin; skipped');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return failOpen('stdin is not valid JSON; skipped');
  }
  return decide(payload);
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
