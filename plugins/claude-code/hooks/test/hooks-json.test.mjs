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
  assert.ok(handlers.length >= 5);
  for (const h of handlers) {
    assert.equal(h.type, 'command');
    const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}([^"]+)"$/.exec(h.command);
    assert.ok(m, h.command);
    const p = PLUGIN_ROOT + m[1];
    assert.ok(existsSync(p), p);
  }
});

test('every if is an Edit(...) rule, and PostToolUse carries the three paths', () => {
  for (const h of handlers) {
    if ('if' in h) assert.match(h.if, /^Edit\(.+\)$/);
  }
  assert.deepEqual(config.hooks.PostToolUse[0].hooks.map((h) => h.if), [
    'Edit(~/.claude/projects/**/memory/**)',
    'Edit(**/CLAUDE.md)',
    'Edit(**/CLAUDE.local.md)',
  ]);
});

test('no handler is mcp_tool, prompt or agent', () => {
  for (const h of handlers) assert.ok(!['mcp_tool', 'prompt', 'agent'].includes(h.type), h.type);
});
