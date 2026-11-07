// Before a paid run:
// (a) Check whether a managed settings file is on the host: managed policy loads whatever this run sets.
// (b) Server-managed settings for the key's organization cannot be seen from the host, so record them
//     as unknown. A pattern of denied calls points there first.
// (c) The run ceiling must fit a two-turn row's turn 1 spend plus its turn 2 reservation, or the row
//     stops after turn 1.
//
// Builds the SDK `options` object for one call. Pure; the SDK itself is imported only by sdk.mjs.
// Option names, all in sdk.d.ts (0.3.316): model :2023, effort :1974 ('low'|'medium'|'high'|
// 'xhigh'|'max'), maxBudgetUsd :1993, maxTurns :1988, settingSources :2339, env :1721,
// plugins :2096, mcpServers :2018, disallowedTools :1664, allowedTools :1644, cwd :1658,
// permissionMode :2055, resume :2148, systemPrompt :2490.
//
// Bare mode is not used. The headless docs (code.claude.com/docs/en/headless) say "In bare mode Claude
// has access to the Bash, file read, and file edit tools", and that Claude "doesn't get the list of
// available skills". A keyed run under it measured init `tools: ["Read"]`, so a row that needs the skill
// tool cannot pass there. Kept out here instead, one by one: user and project settings (empty
// `settingSources`), other MCP servers (`strictMcpConfig`), built-in tools outside a turn's set (`tools`,
// and the load check on init), and through the child's environment auto memory (on for an `autoMemory`
// row only: see rows.mjs), built-in agents,
// background tasks and marketplace installs. A settings file carrying hooks refuses. Plugin hooks are
// not checked: a hook event ahead of init adds a note to the summary, and nothing more.
//
// `tools` is the session's built-in set, an array of tool names (code.claude.com/docs/en/agent-sdk/typescript).
// It is always stated: the default set is the full one, including a shell-capable PowerShell on
// Windows, and dontAsk still runs what needs no approval.
//
// The permission mode is always stated, and it is dontAsk (sdk.d.ts:2052): a call that would prompt
// is denied, so `allowedTools` is the whole list of approvals. No `canUseTool` is sent, so nothing
// can approve a call later. dontAsk still runs what needs no approval in default mode, including
// file reads inside the working directory (code.claude.com/docs/en/agent-sdk/permissions, read
// 2026-11-04).
//
// No `thinking` option is sent: adaptive thinking on Opus 5.5 is always on.
// No retry option is shown in sdk.d.ts, so none is set and the harness never retries a call. The
// binary's own retries (api_retry, sdk.d.ts:3687) are limited through the child's environment; see
// ENV_ALLOWLIST in guards.mjs.

import path from "node:path";
import { DISALLOWED_TOOLS, OBSERVED_WRITE_TOOLS, insideDir, resolveReal } from "./guards.mjs";

// For the check after a call: a file tool's target resolves, links followed, inside the root. Glob's
// pattern cannot climb out; Grep's pattern is a regular expression, so only its path counts. Input
// field names for these tools are not in sdk.d.ts: an input without the expected field is outside.
export function inScope(toolName, input, { root, fs }) {
  let target = input?.file_path;
  if (toolName === "Grep") target = input?.path ?? root;
  if (toolName === "Glob") {
    const pattern = input?.pattern;
    if (typeof pattern !== "string" || path.isAbsolute(pattern) || /(^|[\\/])\.\.([\\/]|$)/.test(pattern)) return false;
    target = input?.path ?? root;
  }
  if (typeof target !== "string" || !target) return false;
  return insideDir(resolveReal(path.resolve(root, target), fs), resolveReal(root, fs));
}

export function buildOptions({
  model, effort, sessionUsd, maxTurns, tools, allowedTools, resume, settingsPath, pluginDir,
  mcpServers, childEnv, cwd, noPlugin = false, observeWrites = false,
}) {
  const o = {
    settings: settingsPath, // flag-settings layer (sdk.d.ts:2271-2289), holds the web and browser deny rules
    settingSources: [], // nothing from user, project or local files; the settings given with --settings are the only layer from files this run controls
    env: childEnv,
    strictMcpConfig: true,
    tools,
    allowedTools,
    // An `observeWrites` row shows Write and Edit so a wrong save route can be seen; they stay off
    // `allowedTools`, so dontAsk denies each call. The Edit deny pattern for the SDK package stays.
    disallowedTools: DISALLOWED_TOOLS.filter((t) => !(observeWrites && OBSERVED_WRITE_TOOLS.includes(t))),
    permissionMode: "dontAsk",
    systemPrompt: { type: "preset", preset: "claude_code" },
  };
  // A connector-only row leaves both out: it measures the session without them.
  if (!noPlugin) {
    o.plugins = [{ type: "local", path: pluginDir }];
    // plugin:skill form (sdk.d.ts:2340-2362). The rows also keep 'Skill' in `allowedTools`: passing it
    // is deprecated but not removed, and the first T2 shows which of the two works.
    o.skills = ["quadron:quadron"];
  }
  if (model) o.model = model;
  if (effort) o.effort = effort;
  if (sessionUsd !== undefined) o.maxBudgetUsd = sessionUsd; // per call: a two-turn row can spend it on each turn, and each call reserves it first, against the run and total ceilings
  if (maxTurns !== undefined) o.maxTurns = maxTurns;
  if (cwd) o.cwd = cwd;
  if (mcpServers) o.mcpServers = mcpServers;
  if (resume) o.resume = resume;
  return o;
}
