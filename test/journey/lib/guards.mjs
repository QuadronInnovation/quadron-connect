// Guards: refusals, the child-environment allowlist, the web and browser tool restrictions,
// config-directory rules and the post-run hygiene check. Pure functions over injected env and fs,
// so every rule is tested with stubs. Nothing here spawns a process or reads a credential file.
//
// This is a guard with detection, not a security boundary: every process runs as the same OS user.

import path from "node:path";

export const EXIT = { OK: 0, ROWS_FAILED: 1, REFUSAL: 2, STOPPED: 3, AUTH: 4, INIT_GATE: 5, BLOCKED: 6 };

export class Refusal extends Error {
  constructor(message, code = EXIT.REFUSAL) {
    super(message);
    this.name = "Refusal";
    this.code = code;
  }
}

// Credential-related variable names backed by sdk.d.ts or the public docs (the only names a
// refusal list may use): CLAUDE_CODE_OAUTH_TOKEN :2866, CLAUDE_CODE_SESSION_ACCESS_TOKEN :2867,
// ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL :9009, CLAUDE_CODE_REMOTE (~:1246),
// CLAUDE_CODE_SIMPLE :4338, cloud-provider switches (agent-sdk quickstart).
export const REFUSED_ENV = [
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_REMOTE",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

export const KEY_VAR = "ANTHROPIC_API_KEY";
export const CONNECTOR_VARS = [
  "QUADRON_CONNECTOR_REFRESH_TOKEN",
  "QUADRON_CONNECTOR_CLIENT_ID",
  "QUADRON_CONNECTOR_ISSUER",
];

// The child env REPLACES the subprocess environment (sdk.d.ts:1706-1711), so it is built only
// from this list. Every entry carries its reason; anything not listed is not passed, which is
// also how fast-mode and region switches cannot be inherited. APPDATA and LOCALAPPDATA are out:
// no source shows they are needed.
export const ENV_ALLOWLIST = {
  PATH: "find the runtime and the bundled binary",
  SystemRoot: "Windows process start",
  windir: "Windows process start",
  COMSPEC: "Windows process start",
  PATHEXT: "Windows executable lookup",
  TEMP: "temporary files",
  TMP: "temporary files",
  TMPDIR: "temporary files on POSIX",
  HOME: "always the new empty directory the harness creates, never inherited",
  USERPROFILE: "same, on Windows",
  HOMEDRIVE: "same, on Windows, only when that directory has a drive",
  HOMEPATH: "same, on Windows, only when that directory has a drive",
  [KEY_VAR]: "the one credential the run may use",
  CLAUDE_CONFIG_DIR: "relocates the config directory, set by the harness",
  // code.claude.com/docs/en/agent-sdk/claude-code-features. With no bare mode, this is what keeps auto
  // memory out of a session.
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "docs: agent-sdk/claude-code-features, set by the harness to 1",
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "set by the harness to 1: no built-in sub-agents in a session",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "set by the harness to 1: nothing runs behind a turn",
  CLAUDE_CODE_DISABLE_AGENT_VIEW: "set by the harness to 1: no agent view",
  CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "set by the harness to 1: no plugin arrives from a marketplace",
  // Documented at code.claude.com/docs/en/env-vars, read 2026-11-04.
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: "caps a response, set by the harness. The docs say \"for most requests\", so not all",
  CLAUDE_CODE_MAX_RETRIES: "set by the harness to 1. Whether retries can be disabled fully is not stated",
  CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: "set by the harness to 0. Whether retries can be disabled fully is not stated",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "set by the harness to 1",
  // code.claude.com/docs/en/prompt-caching, read 2026-11-04: "forces five minutes for both buckets",
  // highest precedence. ENABLE_PROMPT_CACHING_1H and the two *_PROMPT_CACHE_TTL variables are not
  // listed, so a parent's values are dropped.
  FORCE_PROMPT_CACHING_5M: "set by the harness to 1: the worst case prices cache writes at the 5-minute rate",
};

const HOME_VARS = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];
// Set here and never inherited, so a parent environment cannot loosen them.
const FIXED_ON = ["CLAUDE_CODE_DISABLE_AUTO_MEMORY", "CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
  "CLAUDE_CODE_DISABLE_AGENT_VIEW", "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL"];
const HARNESS_VARS = ["CLAUDE_CONFIG_DIR", ...FIXED_ON, "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_MAX_RETRIES",
  "CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "FORCE_PROMPT_CACHING_5M"];

// UNMEASURED until a keyed run: whether the binary and the session work with an empty home, and
// whether pointing these variables at it keeps every read and write away from the real home.
export function buildChildEnv(env, { configDir, homeDir, maxOutputTokens }) {
  if (!homeDir) throw new Refusal("no isolated home directory for the child");
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new Refusal("no output token limit for the child");
  const out = {};
  for (const k of Object.keys(ENV_ALLOWLIST)) {
    if (env[k] !== undefined && !HARNESS_VARS.includes(k) && !HOME_VARS.includes(k)) out[k] = env[k];
  }
  out.HOME = homeDir;
  out.USERPROFILE = homeDir;
  const win = /^[A-Za-z]:[\\/]/.test(homeDir) ? path.win32.parse(homeDir) : null;
  if (win) {
    out.HOMEDRIVE = win.root.slice(0, 2);
    out.HOMEPATH = path.win32.normalize(homeDir).slice(2);
  }
  if (configDir) out.CLAUDE_CONFIG_DIR = configDir;
  for (const k of FIXED_ON) out[k] = "1";
  out.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxOutputTokens);
  out.CLAUDE_CODE_MAX_RETRIES = "1";
  out.CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES = "0";
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  out.FORCE_PROMPT_CACHING_5M = "1";
  return out;
}

export function checkAuthEnv(env, { expectNoKey = false } = {}) {
  if (!expectNoKey && !env[KEY_VAR]) throw new Refusal(`${KEY_VAR} is not set (value never printed)`);
  const set = REFUSED_ENV.filter((v) => env[v]);
  if (set.length) throw new Refusal(`credential or routing variables set, refusing: ${set.join(", ")}`);
}

// Print mode is disallowed: no `claude -p`, and nothing in this harness spawns a process.
export function refusePrintMode(argv) {
  for (const a of argv) {
    if (a === "-p" || a === "--print" || a === "--output-format") {
      throw new Refusal("scripted claude -p is disallowed; this harness drives the SDK only");
    }
  }
}

// Fast mode: the settings key is `fastMode` (sdk.d.ts:9404). Init reports fast_mode_state
// 'off' | 'cooldown' | 'on' (sdk.d.ts:810, :4821, :6290) as an optional field. A stated value other
// than 'off' refuses: 'cooldown' is fast mode paused, not fast mode off. On initializationResult(),
// the check before any prompt, an absent value is unconfirmed and stops too: only a stated 'off'
// passes there. US-only inference and the environment names for fast mode are not shown in
// sdk.d.ts, so only the allowlist guards them.
export function checkFastModeSettings(settings) {
  if (settings && settings.fastMode === true) throw new Refusal("settings turn fast mode on; refusing");
}
export function fastModeOn(init) {
  const s = init?.fast_mode_state;
  return s !== undefined && s !== null && s !== "off";
}
export const fastModeStatedOff = (init) => init?.fast_mode_state === "off";

// The settings given with --settings may carry only deny rules: nothing that widens a session or
// changes its credential, environment, mode or cache pricing. So these are allowlists, and a key not
// named here refuses. No user, project or local settings load, so of the layers from files this run
// controls this is the only one a hook could come from, and it may not carry any. An allow rule would
// widen a turn's allow-list. Stated only by key: a value is never printed.
//
// No override reaches this: it takes the settings and nothing else. The `settings_deny` lift applies
// only to checkSettingsDeny below, the check that the required web and browser deny rules are present.
const SETTINGS_KEYS = ["$schema", "permissions", "fastMode"];
const SETTINGS_PERMISSION_KEYS = ["deny", "allow"];
const isPlainObject = (o) => Boolean(o) && typeof o === "object" && !Array.isArray(o);
export function checkSettingsDenyOnly(settings) {
  const refuse = (what) => new Refusal(`the settings file may carry only deny rules: ${what}; refusing`);
  if (!isPlainObject(settings)) throw refuse("it is not an object");
  for (const k of Object.keys(settings)) if (!SETTINGS_KEYS.includes(k)) throw refuse(`it contains ${k}`);
  if (!Object.prototype.hasOwnProperty.call(settings, "permissions")) return;
  const { permissions } = settings;
  if (!isPlainObject(permissions)) throw refuse("permissions is not an object");
  for (const k of Object.keys(permissions)) if (!SETTINGS_PERMISSION_KEYS.includes(k)) throw refuse(`it contains permissions.${k}`);
  const allow = Object.prototype.hasOwnProperty.call(permissions, "allow") ? permissions.allow : null;
  if (allow !== null && !(Array.isArray(allow) && allow.length === 0)) throw refuse("it has permissions.allow rules");
}

// What every session must carry. Refused at the one place a query starts, and before anything is
// reserved. No flag, override or environment name reaches this: it reads the options and nothing else.
function sessionOptionFault(o) {
  if (o?.permissionMode !== "dontAsk") return "permissionMode must be dontAsk";
  if (!Array.isArray(o?.settingSources) || o.settingSources.length !== 0) return "settingSources must be an empty array";
  if (o?.strictMcpConfig !== true) return "strictMcpConfig must be true";
  if (typeof o?.settings !== "string" || !o.settings) return "settings must be a non-empty string";
  if (!Array.isArray(o?.tools)) return "tools must be an array";
  if (o?.extraArgs !== undefined && o?.extraArgs !== null && "bare" in Object(o.extraArgs)) return "extraArgs must not carry bare";
  return null;
}
export function assertSessionOptions(options) {
  const fault = sessionOptionFault(options);
  if (fault) throw new Refusal(`session options refused: ${fault}; nothing started`);
}

// -------------------------------------------------------------- web and browser tool restrictions

export const REQUIRED_DENY = ["WebFetch", "WebSearch", "Bash(*playwright*)"];
export const BROWSER_PACKAGES = ["playwright", "playwright-core", "@playwright/test", "puppeteer", "selenium-webdriver", "cypress"];
export const BROWSER_TOOL_RE = /playwright|puppeteer|browser|chrome|selenium/i;
// Sub-agent tool: sdk.d.ts names it both "the Agent tool" (:36, :1622) and "the Task tool"
// (:111, :6369). Both are disallowed and both are scanned.
export const SUBAGENT_TOOLS = ["Agent", "Task"];
// A bare name removes the tool. A pattern keeps the tool and denies matching calls in every mode;
// `//` starts an absolute path, and `//**/` matches on any drive (agent-sdk/permissions, read 2026-11-04).
export const SDK_PACKAGE_DENY = ["Read(//**/node_modules/@anthropic-ai/**)", "Edit(//**/node_modules/@anthropic-ai/**)"];
// Tools that run commands or reach out, per code.claude.com/docs/en/tools-reference: Bash, PowerShell,
// Monitor, WebFetch, WebSearch, RemoteTrigger, Workflow. The fixed `tools` list and the load check
// on init cover the rest of that table.
export const DISALLOWED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "Monitor", "RemoteTrigger", "Workflow", "WebFetch", "WebSearch", ...SUBAGENT_TOOLS, ...SDK_PACKAGE_DENY];
export const LIFTABLE = ["settings_deny", "init_scan", "tool_use_scan"]; // never "library"
export const OVERRIDE_MAX_MINUTES = 240;

export function checkSettingsDeny(settings, lifted = []) {
  if (lifted.includes("settings_deny")) return;
  const deny = settings?.permissions?.deny;
  const missing = REQUIRED_DENY.filter((r) => !Array.isArray(deny) || !deny.includes(r));
  if (missing.length) throw new Refusal(`the settings file lacks the required web and browser deny rules: ${missing.join(", ")}`);
}

// resolve(name) returns truthy when the module resolves from the runner's directory.
export function checkBrowserLibraries(resolve) {
  const found = BROWSER_PACKAGES.filter((n) => {
    try { return Boolean(resolve(n)); } catch { return false; }
  });
  if (found.length) throw new Refusal("browser or web tooling present");
}

export function checkBrowserArgsEnv(argv, env) {
  const hit = argv.some((a) => /playwright-cli/.test(a)) ||
    Object.keys(env).some((k) => /^(PLAYWRIGHT|PUPPETEER|SELENIUM|CYPRESS)_/.test(k)) ||
    Object.entries(env).some(([k, v]) => k !== KEY_VAR && !CONNECTOR_VARS.includes(k) && typeof v === "string" && /playwright-cli/.test(v));
  if (hit) throw new Refusal("browser or web tooling present");
}

export function scanInitTools(tools, lifted = []) {
  if (lifted.includes("init_scan")) return [];
  return (tools ?? []).filter((t) => t === "WebFetch" || t === "WebSearch" || SUBAGENT_TOOLS.includes(t) || BROWSER_TOOL_RE.test(t));
}

// The only tools outside a turn's `tools` that init may list and pass: not refused, and recorded where a
// summary exists, which an init form does not have. The three connector names on a connector row, and
// Skill on an init form. A row with no connector gets none, so T2 stays strict.
//
// Passing here grants nothing, but the two resource tools need no permission
// (code.claude.com/docs/en/tools-reference), so a row could call them though they are on no allow-list.
// Such a call is neither refused nor judged: a plain note in the summary names it.
export const CONNECTOR_INIT_TOOLS = ["ListMcpResourcesTool", "ReadMcpResourceTool", "WaitForMcpServers"];
export const MCP_RESOURCE_TOOLS = ["ListMcpResourcesTool", "ReadMcpResourceTool"];
export function toleratedInitTools(listed, { connector = false, initForm = false } = {}) {
  const names = [...(connector ? CONNECTOR_INIT_TOOLS : []), ...(initForm ? ["Skill"] : [])];
  return (listed ?? []).filter((t) => names.includes(t));
}

// Init tools to refuse: everything outside the turn's `tools`, the connector's names and the tolerated
// list, and any disallowed name even if a turn's `tools` held it. The init_scan lift excuses only what
// scanInitTools catches, so a shell tool is never excused.
export function unexpectedInitTools(listed, turnTools, lifted = [], tolerated = []) {
  const excused = (t) => lifted.includes("init_scan") && scanInitTools([t]).length > 0;
  const allowed = (t) => (turnTools.includes(t) && !DISALLOWED_TOOLS.includes(t)) || (typeof t === "string" && t.startsWith("mcp__quadron__")) || tolerated.includes(t);
  return (listed ?? []).filter((t) => !allowed(t) && !excused(t));
}

export function scanToolUses(toolUses, lifted = []) {
  if (lifted.includes("tool_use_scan")) return [];
  return toolUses
    .map((u) => u.name)
    .filter((n) => n === "WebFetch" || n === "WebSearch" || SUBAGENT_TOOLS.includes(n) || BROWSER_TOOL_RE.test(n) ||
      (n.startsWith("mcp__") && !n.startsWith("mcp__quadron__")));
}

// Override file: {"reason","expires","lifts":[...]}. Time-boxed, lifts only what it names.
export function loadOverride(raw, now) {
  let o;
  try { o = JSON.parse(raw); } catch { throw new Refusal("override file is not valid JSON"); }
  const exp = Date.parse(o?.expires);
  if (!o?.reason || !Array.isArray(o.lifts) || Number.isNaN(exp)) throw new Refusal("override file needs reason, expires and lifts");
  if (exp <= now) throw new Refusal("override has expired");
  if (exp - now > OVERRIDE_MAX_MINUTES * 60_000) throw new Refusal(`override expires more than ${OVERRIDE_MAX_MINUTES} minutes ahead`);
  if (o.lifts.includes("library")) throw new Refusal("the library check cannot be lifted by an override");
  const unknown = o.lifts.filter((l) => !LIFTABLE.includes(l));
  if (unknown.length) throw new Refusal(`override names checks that do not exist: ${unknown.join(", ")}`);
  return { reason: o.reason, expires: o.expires, lifts: o.lifts };
}

// -------------------------------------------------------------- config directory and hygiene

// Accept an existing empty directory, refuse a non-empty one; deletes nothing.
export function checkConfigDir(dir, fs) {
  if (!dir) throw new Refusal("--config-dir is required");
  let names;
  try { names = fs.readdirSync(dir); } catch { throw new Refusal("config directory does not exist or is unreadable"); }
  if (names.length) throw new Refusal("config directory is not empty");
}

export function insideDir(child, parent, sep = "/") {
  const n = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const c = n(child), p = n(parent);
  return c === p || c.startsWith(p + sep);
}

// The real path of `p`, following links through the part of it that exists, so a link placed
// outside the clone that points into it is still caught. Paths that do not exist yet are resolved
// through their nearest existing parent.
export function resolveReal(p, fs) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest); } catch { /* not there yet: go up */ }
    const up = path.dirname(cur);
    if (up === cur) return path.join(cur, ...rest);
    rest.unshift(path.basename(cur));
    cur = up;
  }
}

// Runs come from a clone that must stay clean, so everything the harness or the child writes has
// to resolve outside it. `paths` maps a label to a path. With no fs (the dry path touches none)
// the check is by path text alone.
export function assertOutsideClone(paths, repoRoot, fs = null) {
  const real = (p) => (fs ? resolveReal(p, fs) : path.resolve(p));
  const root = real(repoRoot);
  for (const [label, p] of Object.entries(paths)) {
    if (p && insideDir(real(p), root)) throw new Refusal(`${label} must be outside the clone`);
  }
}

// Existence by name only; contents are never read.
export function credentialFilesIn(dir, fs) {
  const hits = [];
  const walk = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const name = typeof e === "string" ? e : e.name;
      if (/credential|token/i.test(name)) hits.push(name);
      if (depth < 4 && typeof e !== "string" && e.isDirectory()) walk(`${d}/${name}`, depth + 1);
    }
  };
  walk(dir, 0);
  return hits;
}

// Names, sizes and modification times of a tree, for T5's working directory. It shows that
// nothing changed there; it cannot stop a change. node_modules and .git are not walked.
export function snapshotTree(dir, fs) {
  const out = [];
  const walk = (d, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(`${r}/`); walk(p, r); continue; }
      try { const st = fs.statSync(p); out.push(`${r}|${st.size}|${st.mtimeMs}`); } catch { out.push(`${r}|gone`); }
    }
  };
  walk(dir, "");
  return out.sort();
}

// -------------------------------------------------------------- head of the clone

// The commit the clone is at, read from git's own files, since nothing here spawns a process.
export function readHead(repoRoot, fs) {
  const fail = () => new Refusal("cannot read the clone's head commit");
  const SHA = /^[0-9a-f]{40}$/;
  const read = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return null; } };
  let gitDir = path.join(repoRoot, ".git");
  const asFile = read(gitDir); // a linked worktree holds a file naming its git directory
  if (asFile) {
    const m = /^gitdir:\s*(.+)$/m.exec(asFile);
    if (!m) throw fail();
    gitDir = path.resolve(repoRoot, m[1]);
  }
  const head = read(path.join(gitDir, "HEAD"));
  if (!head) throw fail();
  if (SHA.test(head)) return head;
  const ref = /^ref:\s*(.+)$/.exec(head)?.[1];
  if (!ref) throw fail();
  const common = read(path.join(gitDir, "commondir"));
  const base = common ? path.resolve(gitDir, common) : gitDir;
  for (const dir of [gitDir, base]) {
    const v = read(path.join(dir, ref));
    if (v && SHA.test(v)) return v;
  }
  const packed = read(path.join(base, "packed-refs")) ?? "";
  for (const line of packed.split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && SHA.test(sha)) return sha;
  }
  throw fail();
}

// -------------------------------------------------------------- pinned package

// Installed-version check against the pin, reading only the two package.json files.
export function checkInstalledSdk(journeyDir, fs) {
  const NAME = "@anthropic-ai/claude-agent-sdk";
  let pin, installed;
  try { pin = JSON.parse(fs.readFileSync(path.join(journeyDir, "package.json"), "utf8")).dependencies[NAME]; } catch { throw new Refusal("cannot read the SDK pin"); }
  try { installed = JSON.parse(fs.readFileSync(path.join(journeyDir, "node_modules", ...NAME.split("/"), "package.json"), "utf8")).version; } catch { throw new Refusal("the pinned SDK is not installed"); }
  if (!pin || installed !== pin) throw new Refusal(`installed SDK version ${installed} does not match the pin ${pin}`);
  return installed;
}

// -------------------------------------------------------------- dry-run environment

export function isLoopbackUrl(value) {
  let u;
  try { u = new URL(value); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
}

// Claude Code version floor. The value came from the docs' note on what older versions enforced
// ("Before v2.1.286, these limits held only partly"), and it stays as the oldest version accepted.
export function versionAtLeast(v, min = "2.1.286") {
  const a = String(v ?? "").split(".").map(Number), b = min.split(".").map(Number);
  if (a.length < 3 || a.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
