import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  decide, run, RECALL_PHRASES, CAPTURE_PHRASES, RECALL_TEXT, CAPTURE_TEXT,
} from '../scripts/prompt-trigger.mjs';
import { CAPTURE_RULE } from '../scripts/capture-rule.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/prompt-trigger.mjs', import.meta.url));

const ev = (prompt) => ({ hook_event_name: 'UserPromptSubmit', prompt });
function context(r) {
  assert.equal(r.exitCode, 0);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  return out.hookSpecificOutput.additionalContext;
}
function nothing(r) {
  assert.deepEqual(r, { stdout: '', stderr: '', exitCode: 0 });
}

test('every recall phrase yields the recall line only', () => {
  assert.equal(RECALL_PHRASES.length, 5);
  for (const p of RECALL_PHRASES) {
    assert.equal(context(decide(ev(`Hey, ${p.toUpperCase()} pricing?`))), RECALL_TEXT, p);
  }
});

test('every capture phrase yields the capture line only', () => {
  assert.equal(CAPTURE_PHRASES.length, 14);
  for (const p of CAPTURE_PHRASES) {
    assert.equal(context(decide(ev(`OK. ${p} the blue option for launch.`))), CAPTURE_TEXT, p);
  }
});

test('capture phrases accept a curly apostrophe', () => {
  assert.equal(context(decide(ev('We’ll go with Postgres.'))), CAPTURE_TEXT);
});

test('the capture line keeps offer-then-yes and treats an explicit save request as the yes', () => {
  assert.equal(CAPTURE_TEXT,
    `Quadron: the person may have just stated a judgment or asked to keep something. ${CAPTURE_RULE}`);
  assert.equal(RECALL_TEXT,
    'Quadron: the person is reaching back to their prior work. Unless the session already lists what they ask for, call quad_context (with the topic, if there is one) or quad_recall within a named project before answering.');
  assert.equal(context(decide(ev('Save this to Quadron: we ship on Fridays only.'))), CAPTURE_TEXT);
});

test('capture phrases need word boundaries', () => {
  nothing(decide(ev('Is denote that a word? Ianever mind.')));
  nothing(decide(ev('The keep thistle grows here.')));
});

test('both forms fire together, recall first', () => {
  assert.equal(context(decide(ev('What did I decide about caching? I decided last week, I think.'))),
    `${RECALL_TEXT}\n${CAPTURE_TEXT}`);
});

test('neutral prompt and a lone "Quadron" yield nothing', () => {
  nothing(decide(ev('Refactor the parser to use a switch statement.')));
  nothing(decide(ev('Quadron')));
  nothing(decide(ev('quadron?')));
});

test('phrases only inside pasted_content are ignored', () => {
  nothing(decide(ev('Fix the typo in this: <pasted_content id="1">I decided to remember this and check my record</pasted_content>')));
  assert.equal(
    context(decide(ev('<pasted_content>log text</pasted_content> I always squash merges.'))),
    CAPTURE_TEXT);
});

test('non-string prompt is a silent non-match', () => {
  nothing(decide({ hook_event_name: 'UserPromptSubmit' }));
});

test('malformed input fails open with one stderr line', () => {
  for (const raw of ['', '{bad', 'null', '[1]', JSON.stringify({ hook_event_name: 'Stop', prompt: 'I decided' })]) {
    const r = run(raw);
    assert.equal(r.exitCode, 0, raw);
    assert.equal(r.stdout, '', raw);
    assert.equal(r.stderr.split('\n').filter(Boolean).length, 1, raw);
  }
});

test('child process: stdin in, JSON out; malformed fails open', () => {
  const ok = spawnSync(process.execPath, [SCRIPT], { input: JSON.stringify(ev('my rule is: no Friday deploys')), encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext, CAPTURE_TEXT);
  const bad = spawnSync(process.execPath, [SCRIPT], { input: 'nope', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
  assert.equal(bad.stderr.split('\n').filter(Boolean).length, 1);
});
