// Builds the SDK `options` object for one call. Pure; the SDK itself is imported only by sdk.mjs.
// Option names, all in sdk.d.ts (0.3.316): model :2023, effort :1974 ('low'|'medium'|'high'|
// 'xhigh'|'max'), maxBudgetUsd :1993, maxTurns :1988, settingSources :2339, env :1721,
// plugins :2096, mcpServers :2018, disallowedTools :1664, allowedTools :1644, cwd :1658,
// extraArgs :1738, permissionMode :2055, resume :2148, systemPrompt :2490.
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
import { DISALLOWED_TOOLS, insideDir, resolveReal } from "./guards.mjs";

// UNMEASURED until the first keyed run: how to enable bare mode for the SDK is not documented.
// This one function is the single place to change once the first run shows what works.
export function bareOptions() {
  return { extraArgs: { bare: null } }; // sdk.d.ts:1738 (general extraArgs); not confirmed for bare
}

// Whether bare is on: `bareMode` is on the get_hooks_listing response (sdk.d.ts:4207, :4340), and
// that request's type is not exported and has no method on Query (:2938-3342). So it is not
// reachable through the published types, and the harness can only say so.
export const BARE_CONFIRMATION = "not shown";

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
  model, effort, sessionUsd, maxTurns, tools, resume, settingsPath, pluginDir,
  mcpServers, childEnv, cwd,
}) {
  const o = {
    settings: settingsPath, // flag-settings layer (sdk.d.ts:2271-2289), holds the web and browser deny rules
    settingSources: [], // nothing from user or project files; the settings given with --settings are the only layer
    env: childEnv,
    plugins: [{ type: "local", path: pluginDir }],
    strictMcpConfig: true,
    allowedTools: tools,
    disallowedTools: [...DISALLOWED_TOOLS],
    permissionMode: "dontAsk",
    // plugin:skill form (sdk.d.ts:2340-2362). The rows also keep 'Skill' in `allowedTools`: passing it
    // is deprecated but not removed, and the first T2 shows which of the two works.
    skills: ["quadron:quadron"],
    systemPrompt: { type: "preset", preset: "claude_code" },
    ...bareOptions(),
  };
  if (model) o.model = model;
  if (effort) o.effort = effort;
  if (sessionUsd !== undefined) o.maxBudgetUsd = sessionUsd; // the session ceiling, on every call including each turn of a two-turn row
  if (maxTurns !== undefined) o.maxTurns = maxTurns;
  if (cwd) o.cwd = cwd;
  if (mcpServers) o.mcpServers = mcpServers;
  if (resume) o.resume = resume;
  return o;
}
