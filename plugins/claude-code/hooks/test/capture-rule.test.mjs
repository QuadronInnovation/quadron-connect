import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CAPTURE_RULE } from '../scripts/capture-rule.mjs';
import { BANNER } from '../scripts/session-banner.mjs';
import { CAPTURE_TEXT } from '../scripts/prompt-trigger.mjs';
import { contextText } from '../scripts/memory-trigger.mjs';

// The sentence is fixed word for word; the hooks repeat it and add no capture rule of their own.
const SENTENCE =
  'Write to Quadron only on the person\'s yes: offer once, in one line quoting the exact words you would save, and call the capture tool (future_you_capture for a judgment, quad_commit for a note) only after they say yes in this conversation; an explicit request in this conversation to save or keep that specific thing is already the yes, so save it with no separate offer; anything less explicit still gets the offer, including a bare "note this" or a "save this" that leaves unclear which words; on a bare "remember this" that does not name Quadron, ask whether they mean Quadron.';

const script = (name) => fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
const emitted = (name, payload) => {
  const r = spawnSync(process.execPath, [script(name)], {
    input: payload === undefined ? '' : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: '' },
  });
  assert.equal(r.status, 0, name);
  assert.equal(r.stderr, '', name);
  return r.stdout;
};

test('CAPTURE_RULE is the agreed sentence, character for character', () => {
  assert.equal(CAPTURE_RULE, SENTENCE);
});

test('the three hook reminders each carry CAPTURE_RULE verbatim, exactly once', () => {
  const texts = {
    banner: BANNER,
    capture: CAPTURE_TEXT,
    memory: contextText('memory', 'Body'),
    instructions: contextText('instructions', 'Body'),
  };
  for (const [name, text] of Object.entries(texts)) {
    assert.equal(text.split(CAPTURE_RULE).length, 2, name);
  }
});

test('the scripts, run as hooks.json runs them, emit CAPTURE_RULE verbatim', () => {
  assert.ok(emitted('session-banner.mjs').includes(CAPTURE_RULE));
  const prompt = JSON.parse(emitted('prompt-trigger.mjs', { hook_event_name: 'UserPromptSubmit', prompt: 'save this: I always ship on Tuesdays' }));
  assert.ok(prompt.hookSpecificOutput.additionalContext.includes(CAPTURE_RULE));
  const memory = JSON.parse(emitted('memory-trigger.mjs', {
    hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/CLAUDE.md', content: 'Ship on Tuesdays.' },
  }));
  assert.ok(memory.hookSpecificOutput.additionalContext.includes(CAPTURE_RULE));
});
