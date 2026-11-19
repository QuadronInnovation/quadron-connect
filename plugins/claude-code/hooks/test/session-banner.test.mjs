import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BANNER } from '../scripts/session-banner.mjs';
import { CAPTURE_RULE } from '../scripts/capture-rule.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/session-banner.mjs', import.meta.url));
const SKILL = fileURLToPath(new URL('../../skills/quadron/SKILL.md', import.meta.url));
const SKILL_SENTENCE = 'Quadron is connected, and this person keeps a record of their own expertise in it.';
const EXPECTED =
  `Quadron hooks are active. If quad_* tools are present: when the person reaches back to their prior work, call quad_context with the topic (or quad_recall inside a project) before answering, unless the session already lists what they ask for. When they state a decision, standard or preference: ${CAPTURE_RULE}`;

test('BANNER is the agreed reminder line', () => {
  assert.equal(BANNER, EXPECTED);
});

test('banner never claims the connection: the SKILL.md sentence belongs to the CLI hook', () => {
  const skill = readFileSync(SKILL, 'utf8').replace(/\s+/g, ' ');
  assert.ok(skill.includes(SKILL_SENTENCE), 'SKILL.md still checks for the CLI hook sentence');
  const r = spawnSync(process.execPath, [SCRIPT], { input: '{}', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout, EXPECTED + '\n');
  assert.ok(!r.stdout.includes(SKILL_SENTENCE));
});
