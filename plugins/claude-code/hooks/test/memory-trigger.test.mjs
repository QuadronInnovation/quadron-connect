import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  decide as decideIn, run as runIn, excerpt, classifyPath, normalisePath, usableConfigDir,
} from '../scripts/memory-trigger.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/memory-trigger.mjs', import.meta.url));
// The runner's own CLAUDE_CONFIG_DIR must not leak into the cases; each passes its env.
const CHILD_ENV = { ...process.env, CLAUDE_CONFIG_DIR: '' };
const decide = (payload, env = {}, home) => decideIn(payload, env, home);
const run = (raw, env = {}, home) => runIn(raw, env, home);

function write(file_path, content, extra = {}) {
  return { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path, content }, ...extra };
}
function edit(file_path, new_string, extra = {}) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path, old_string: 'x', new_string },
    ...extra,
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

const fires = (r) => assert.ok(context(r).startsWith('Quadron: you just saved a memory: "'));
const tp = (transcript_path) => ({ transcript_path });

test('normalisePath: one key for C:\\x and /c/x, case-folded; POSIX keeps case', () => {
  assert.equal(normalisePath('C:\\Users\\U\\cfg\\'), '/c/users/u/cfg');
  assert.equal(normalisePath('/c/Users/U/cfg'), '/c/users/u/cfg');
  assert.equal(normalisePath('/home/U/cfg/'), '/home/U/cfg');
  assert.equal(normalisePath('/a/b/../c/./d.md'), '/a/c/d.md');
});

test('default home layout, POSIX and Windows, with and without transcript_path', () => {
  fires(decide(write('/home/u/.claude/projects/-home-u-app/memory/a.md', 'Body')));
  fires(decide(write('/home/u/.claude/projects/-home-u-app/memory/a.md', 'Body',
    tp('/home/u/.claude/projects/-home-u-app/s1.jsonl'))));
  fires(decide(edit('C:\\Users\\u\\.claude\\projects\\C--Users-u-app\\memory\\a.md', 'Body',
    tp('C:\\Users\\u\\.claude\\projects\\C--Users-u-app\\s1.jsonl'))));
  // The /c/ form against a drive-letter transcript, and a subpath under memory/.
  fires(decide(write('/c/Users/u/.claude/projects/C--app/memory/topic/a.md', 'Body',
    tp('C:\\Users\\u\\.claude\\projects\\C--app\\s1.jsonl'))));
});

test('CLAUDE_CONFIG_DIR: memory under it fires, memory elsewhere is silent', () => {
  const env = { CLAUDE_CONFIG_DIR: '/srv/cfg' };
  fires(decide(write('/srv/cfg/projects/-w-app/memory/a.md', 'Body'), env));
  fires(decide(write('/srv/cfg/projects/-w-app/memory/a.md', 'Body', tp('/srv/cfg/projects/-w-app/s.jsonl')), env));
  nothing(decide(write('/home/u/.claude/projects/-w-app/memory/a.md', 'Body'), env));
  fires(decide(edit('d:\\CFG\\projects\\D--app\\memory\\a.md', 'Body'), { CLAUDE_CONFIG_DIR: 'D:\\cfg\\' }));
  nothing(decide(edit('E:\\cfg\\projects\\D--app\\memory\\a.md', 'Body'), { CLAUDE_CONFIG_DIR: 'D:\\cfg' }));
  // Env and transcript disagree: each known source must agree, so silent.
  nothing(decide(write('/srv/cfg/projects/p/memory/a.md', 'Body', tp('/home/u/.claude/projects/p/s.jsonl')), env));
  // `..` cannot walk out of the config directory and back in by shape.
  nothing(decide(write('/srv/cfg/projects/p/memory/../../../../home/u/src/app/projects/alpha/memory/n.md', 'Body'), env));
  fires(run(JSON.stringify(write('/srv/cfg/projects/p/memory/a.md', 'Body')), env));
});

test('CLAUDE_CONFIG_DIR: a leading ~ expands to the home directory', () => {
  assert.equal(usableConfigDir('~/.cfg', '/home/u'), '/home/u/.cfg');
  assert.equal(usableConfigDir('~', '/home/u/'), '/home/u');
  assert.equal(usableConfigDir('~\\.cfg', 'C:\\Users\\u'), 'C:\\Users\\u\\.cfg');
  fires(decide(write('/home/u/.cfg/projects/x/memory/a.md', 'Body'), { CLAUDE_CONFIG_DIR: '~/.cfg' }, '/home/u'));
  nothing(decide(write('/home/u/.claude/projects/x/memory/a.md', 'Body'), { CLAUDE_CONFIG_DIR: '~/.cfg' }, '/home/u'));
  fires(decide(edit('C:\\Users\\u\\.cfg\\projects\\x\\memory\\a.md', 'Body'),
    { CLAUDE_CONFIG_DIR: '~\\.cfg' }, 'C:\\Users\\u'));
});

test('CLAUDE_CONFIG_DIR that is not absolute is ignored, never silencing a memory write', () => {
  for (const v of ['cfg', './cfg', '.claude', '~user/cfg']) {
    assert.equal(usableConfigDir(v, '/home/u'), '', v);
    fires(decide(write('/home/u/.claude/projects/x/memory/a.md', 'Body'), { CLAUDE_CONFIG_DIR: v }, '/home/u'));
  }
  // A home directory that is itself unusable makes `~` unusable too.
  assert.equal(usableConfigDir('~/.cfg', ''), '');
  // The transcript check still applies when the env value is ignored.
  nothing(decide(write('/home/u/.claude/projects/x/memory/a.md', 'Body', tp('/srv/cfg/projects/x/s.jsonl')),
    { CLAUDE_CONFIG_DIR: './cfg' }, '/home/u'));
  for (const v of ['/srv/cfg', 'D:\\cfg', 'D:/cfg', '/c/cfg', '']) {
    assert.equal(usableConfigDir(v, '/home/u'), v, v);
  }
});

test('config directory known only through transcript_path', () => {
  const t = tp('/opt/claude-cfg/projects/-w-app/s.jsonl');
  fires(decide(write('/opt/claude-cfg/projects/-w-app/memory/a.md', 'Body', t)));
  // Another project under the same projects/ parent (memory is keyed by the git root).
  fires(decide(write('/opt/claude-cfg/projects/-w-app-worktree/memory/a.md', 'Body', t)));
  fires(decide(write('/opt/claude-cfg/projects/-w-app/memory/a.md', 'Body',
    tp('/opt/claude-cfg/projects/-w-app/s/subagents/agent-1.jsonl'))));
  nothing(decide(write('/home/u/.claude/projects/-w-app/memory/a.md', 'Body', t)));
  // A transcript_path with no projects/ segment says nothing; the shape decides.
  fires(decide(write('/opt/claude-cfg/projects/-w-app/memory/a.md', 'Body', tp('/tmp/s.jsonl'))));
});

test('an ordinary repository with projects/<x>/memory/ is silent when the config dir is known', () => {
  const repo = '/home/u/src/app/projects/alpha/memory/notes.md';
  nothing(decide(write(repo, 'Body', tp('/home/u/.claude/projects/-home-u-src-app/s.jsonl'))));
  nothing(decide(write(repo, 'Body'), { CLAUDE_CONFIG_DIR: '/home/u/.claude' }));
  nothing(decide(write('C:\\src\\app\\projects\\alpha\\memory\\notes.md', 'Body',
    tp('C:\\Users\\u\\.claude\\projects\\C--src-app\\s.jsonl'))));
  // With neither source the shape alone decides, so it fires; the hook always sends transcript_path.
  fires(decide(write(repo, 'Body')));
  // Only markdown counts.
  nothing(decide(write('/home/u/.claude/projects/p/memory/a.txt', 'Body')));
  nothing(decide(write('/home/u/.claude/projects/p/memory', 'Body')));
});

test('MEMORY.md, agent memory and frontmatter-only stay skipped under a relocated dir', () => {
  const env = { CLAUDE_CONFIG_DIR: '/srv/cfg' };
  const t = tp('/srv/cfg/projects/p/s.jsonl');
  nothing(decide(write('/srv/cfg/projects/p/memory/MEMORY.md', '- [a](a.md) index line', t), env));
  nothing(decide(write('/srv/cfg/agent-memory/r/a.md', 'Subagent note body', t), env));
  nothing(decide(write('/srv/cfg/projects/p/memory/agent-memory/a.md', 'Subagent note body', t), env));
  nothing(decide(write('/srv/cfg/projects/p/memory/agent-memory-local/a.md', 'Subagent note body', t), env));
  nothing(decide(edit('/srv/cfg/projects/p/memory/a.md', FM, t), env));
  nothing(decide(edit('D:\\cfg\\projects\\p\\memory\\memory.md', 'index', tp('D:\\cfg\\projects\\p\\s.jsonl')),
    { CLAUDE_CONFIG_DIR: 'D:\\cfg' }));
  fires(decide(edit('/srv/cfg/projects/p/memory/a.md', `${FM}Prefers small PRs.`, t), env));
});

test('instruction files classify at any absolute path, including directly in a config directory', () => {
  for (const p of ['/home/u/.claude/CLAUDE.md', '/srv/cfg/CLAUDE.md', 'C:\\Users\\u\\.claude\\CLAUDE.md',
    '/c/Users/u/.claude/CLAUDE.md', '/home/u/src/app/CLAUDE.local.md', 'D:\\src\\app\\CLAUDE.local.md']) {
    assert.equal(classifyPath(p), 'instructions', p);
  }
  // The config directory does not narrow instruction files.
  const ctx = context(decide(edit('/srv/cfg/CLAUDE.md', 'Use pnpm, never npm.', tp('/srv/cfg/projects/p/s.jsonl')),
    { CLAUDE_CONFIG_DIR: '/home/u/.claude' }));
  assert.ok(ctx.startsWith('Quadron: you just updated their instructions file: "Use pnpm, never npm."'));
});

// Permission-rule glob as the docs describe it: `//` anchors at the root, `**` spans
// directories, `*` stays within one segment. Paths are in the POSIX (/c/) form rules see.
function ruleMatches(rule, p) {
  const glob = /^Edit\(\/\/(.+)\)$/.exec(rule)[1];
  const re = glob.split('/').map((seg, i, all) => {
    if (seg === '**') return i === all.length - 1 ? '.*' : '(?:[^/]+/)*';
    return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + (i === all.length - 1 ? '' : '/');
  }).join('');
  return new RegExp(`^/${re}$`).test(p);
}
const RULES = ['Edit(//**/projects/*/memory/**)', 'Edit(//**/CLAUDE.md)', 'Edit(//**/CLAUDE.local.md)'];

test('a path matches at most one filter by shape; the one overlap classifies the same every time', () => {
  for (const p of ['/home/u/.claude/projects/-x/memory/a.md', '/c/Users/u/.claude/projects/C--x/memory/a.md',
    '/srv/cfg/projects/p/memory/topic/a.md', '/home/u/.claude/CLAUDE.md', '/c/src/app/CLAUDE.local.md',
    '/home/u/src/app/CLAUDE.md', '/home/u/src/app/src/x.ts']) {
    assert.ok(RULES.filter((r) => ruleMatches(r, p)).length <= 1, p);
  }
  // A memory file named CLAUDE.md matches the memory and the CLAUDE.md filter. Both handlers
  // run the same script on the same input, so each classifies it as an instructions file and
  // injects the same line.
  const edge = '/home/u/.claude/projects/-x/memory/CLAUDE.md';
  assert.equal(RULES.filter((r) => ruleMatches(r, edge)).length, 2);
  assert.equal(classifyPath(edge), 'instructions');
  assert.equal(classifyPath(edge, { configDir: '/elsewhere' }), 'instructions');
  assert.equal(decide(write(edge, 'Body')).stdout, decide(write(edge, 'Body')).stdout);
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
    env: CHILD_ENV,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(out.hookSpecificOutput.additionalContext.includes('"Ship on Fridays never."'));
});

test('child process: malformed stdin exits 0, no stdout, one stderr line', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { input: '{oops', encoding: 'utf8', env: CHILD_ENV });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.split('\n').filter(Boolean).length, 1);
});
