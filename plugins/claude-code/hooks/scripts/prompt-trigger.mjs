#!/usr/bin/env node
// UserPromptSubmit hook. When the person reaches back to their prior work, nudge a
// Quadron recall; when they appear to state a judgment, nudge a one-line capture offer.
// Context only: it never calls a tool and never blocks the prompt. Fails open.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const RECALL_PHRASES = [
  'what do I already think about',
  'what did I decide',
  'what have I decided',
  'my projects',
  'my record',
];

export const CAPTURE_PHRASES = [
  'remember this',
  'remember that',
  'note this',
  'note that',
  'keep this',
  'save this',
  'I decided',
  'we decided',
  "we'll go with",
  "I'll go with",
  'ruled out',
  'my rule is',
  'I always',
  'I never',
];

export const RECALL_TEXT =
  'Quadron: the person is reaching back to their prior work. Call quad_context with the topic (or quad_recall within a named project) before answering.';

export const CAPTURE_TEXT =
  'Quadron: the person may have just stated a judgment. If so, offer once in one line to keep it in Quadron, quoting their words; call the capture tool only on a yes.';

function phraseRegex(phrase, flags = 'i') {
  const body = phrase
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['\u2019]"))
    .join('\\s+');
  return new RegExp(`\\b${body}\\b`, flags);
}

const RECALL_RES = RECALL_PHRASES.map((p) => phraseRegex(p, 'gi'));
const CAPTURE_RES = CAPTURE_PHRASES.map((p) => phraseRegex(p, 'i'));

export function stripPasted(prompt) {
  return String(prompt).replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\s*>/gi, ' ');
}

// Returns { recall, capture } booleans for a prompt. Recall phrases are blanked out before
// the capture check, so "what have I decided" does not also read as "I decided".
export function classifyPrompt(prompt) {
  let text = stripPasted(prompt);
  let recall = false;
  for (const re of RECALL_RES) {
    text = text.replace(re, () => {
      recall = true;
      return ' ';
    });
  }
  return { recall, capture: CAPTURE_RES.some((re) => re.test(text)) };
}

export function contextFor(prompt) {
  const { recall, capture } = classifyPrompt(prompt);
  const lines = [];
  if (recall) lines.push(RECALL_TEXT);
  if (capture) lines.push(CAPTURE_TEXT);
  return lines.join('\n');
}

const silent = () => ({ stdout: '', stderr: '', exitCode: 0 });
const failOpen = (why) => ({
  stdout: '',
  stderr: `quadron prompt-trigger: ${String(why).replace(/\s+/g, ' ')}\n`,
  exitCode: 0,
});

export function decide(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return failOpen('input is not a JSON object; skipped');
  }
  if (payload.hook_event_name !== 'UserPromptSubmit') {
    return failOpen(`unexpected event ${JSON.stringify(payload.hook_event_name ?? null)}; skipped`);
  }
  if (typeof payload.prompt !== 'string') return silent();
  const text = contextFor(payload.prompt);
  if (!text) return silent();
  const out = {
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
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
