import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, run, excerpt, classifyPath } from '../scripts/memory-trigger.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/memory-trigger.mjs', import.meta.url));

function write(file_path, content) {
  return { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path, content } };
}
function edit(file_path, new_string) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path, old_string: 'x', new_string },
  };
}
function context(r) {
  assert.equal(r.exitCode, 0);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  return out.hookSpecificOutput.additionalContext;
}
function nothing(r) {
  assert.deepEqual(r, { stdout: '', stderr: '', exitCode: 0 });
}

const FM = '---\nname: feedback_y\ndescription: release habit\ntype: feedback\n---\n';

test('Write to a POSIX memory file: body excerpt, no frontmatter', () => {
  const ctx = context(decide(write('/home/u/.claude/projects/-x/memory/feedback_y.md',
    `${FM}\nAlways record the exact command and exit code before reporting.\n`)));
  assert.match(ctx, /^Quadron: you just saved a memory: "Always record the exact command and exit code/);
  assert.ok(!ctx.includes('feedback_y'));
  assert.ok(!ctx.includes('---'));
  assert.ok(ctx.endsWith('If it is your own note, do nothing.'));
});

test('Edit to a Windows memory file via new_string', () => {
  const ctx = context(decide(edit('C:\\Users\\u\\.claude\\projects\\C--x\\memory\\user_role.md',
    'The person leads platform engineering.')));
  assert.ok(ctx.includes('you just saved a memory: "The person leads platform engineering."'));
});

test('Windows drive paths compare case-insensitively', () => {
  assert.equal(classifyPath('c:\\USERS\\u\\.Claude\\Projects\\C--x\\Memory\\a.md'), 'memory');
  assert.equal(classifyPath('D:\\repo\\claude.md'), 'instructions');
});

test('CLAUDE.md and CLAUDE.local.md use the instructions-file wording', () => {
  for (const p of ['/repo/CLAUDE.md', '/repo/CLAUDE.local.md', 'C:\\repo\\CLAUDE.md']) {
    const ctx = context(decide(edit(p, 'Use pnpm, never npm.')));
    assert.ok(ctx.startsWith('Quadron: you just updated their instructions file: "Use pnpm, never npm."'), p);
  }
});

test('exact context text', () => {
  const ctx = context(decide(write('/home/u/.claude/projects/-x/memory/a.md', 'Body')));
  assert.equal(ctx,
    'Quadron: you just saved a memory: "Body". If it records the person\'s own decision, standard or preference, offer once in one line to keep it in their Quadron record, quoting their words; call future_you_capture (or quad_commit if that is not listed) only on a yes. If it is your own note, do nothing.');
});

test('non-matches produce nothing', () => {
  nothing(decide(write('/home/u/.claude/projects/-x/memory/MEMORY.md', '- [a](a.md) index line')));
  nothing(decide(write('/x/.claude/agent-memory/r/a.md', 'Subagent note body')));
  nothing(decide(write('/x/.claude/agent-memory-local/r/a.md', 'Subagent note body')));
  nothing(decide(edit('/home/u/.claude/projects/-x/memory/a.md', FM)));
  nothing(decide(edit('/home/u/.claude/projects/-x/memory/a.md', '---\nname: a\n---')));
  nothing(decide(write('src/app.ts', 'export const x = 1;')));
  nothing(decide(write('/home/u/.claude/projects/-x/notes/a.md', 'Body')));
  nothing(decide({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/r/CLAUDE.md' } }));
});

test('excerpt collapses whitespace and truncates at 200 chars with an ellipsis', () => {
  assert.equal(excerpt('a \n\t b'), 'a b');
  const exact = 'x'.repeat(200);
  assert.equal(excerpt(exact), exact);
  const long = 'y'.repeat(250);
  const ex = excerpt(long);
  assert.equal(ex, 'y'.repeat(200) + '\u2026');
  const ctx = context(decide(write('/home/u/.claude/projects/-x/memory/a.md', `${FM}${'word '.repeat(100)}`)));
  const quoted = /saved a memory: "([^"]*)"/.exec(ctx)[1];
  assert.equal(Array.from(quoted).length, 201);
  assert.ok(quoted.endsWith('\u2026'));
});

test('malformed input fails open with one stderr line', () => {
  for (const raw of ['', '   ', '{not json', '[]', '"str"', '42',
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write' })]) {
    const r = run(raw);
    assert.equal(r.exitCode, 0, raw);
    assert.equal(r.stdout, '', raw);
    assert.equal(r.stderr.split('\n').filter(Boolean).length, 1, raw);
  }
});

test('child process: matching payload on stdin yields JSON on stdout', () => {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify(write('/home/u/.claude/projects/-x/memory/feedback_y.md', `${FM}Ship on Fridays never.`)),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('"Ship on Fridays never."'));
});

test('child process: malformed stdin exits 0, no stdout, one stderr line', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { input: '{oops', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.split('\n').filter(Boolean).length, 1);
});
