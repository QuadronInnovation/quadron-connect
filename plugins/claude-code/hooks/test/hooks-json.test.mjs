import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]$/, '');
const HOOKS = fileURLToPath(new URL('../hooks.json', import.meta.url));

const config = JSON.parse(readFileSync(HOOKS, 'utf8'));
const handlers = Object.values(config.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks));

test('parses with exactly the three events', () => {
  assert.equal(typeof config.hooks, 'object');
  assert.deepEqual(Object.keys(config.hooks).sort(), ['PostToolUse', 'SessionStart', 'UserPromptSubmit']);
  assert.equal(config.hooks.PostToolUse[0].matcher, 'Write|Edit');
  assert.equal(config.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  assert.equal(config.hooks.UserPromptSubmit[0].matcher, undefined);
});

test('every command script exists under the plugin root', () => {
  assert.equal(handlers.length, 3);
  for (const h of handlers) {
    assert.equal(h.type, 'command');
    const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}([^"]+)"$/.exec(h.command);
    assert.ok(m, h.command);
    const p = PLUGIN_ROOT + m[1];
    assert.ok(existsSync(p), p);
  }
});

// In a live run on Windows the `if` path filters let no PostToolUse hook start for a Write of
// CLAUDE.md, so the script alone narrows by path: it runs on every Write or Edit and is silent
// on a non-match.
test('PostToolUse has one handler, the memory trigger, and no handler carries an if', () => {
  assert.equal(config.hooks.PostToolUse.length, 1);
  assert.deepEqual(config.hooks.PostToolUse[0].hooks, [
    { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/memory-trigger.mjs"' },
  ]);
  for (const h of handlers) assert.ok(!('if' in h), JSON.stringify(h));
});

test('no handler is mcp_tool, prompt or agent', () => {
  for (const h of handlers) assert.ok(!['mcp_tool', 'prompt', 'agent'].includes(h.type), h.type);
});
