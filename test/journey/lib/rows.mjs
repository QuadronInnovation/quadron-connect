// Row definitions. Prompts follow the plugin README's journey checks. Turn caps are the token
// budget. A two-turn row runs as one command and one session; the second turn resumes the first.
// A retry names one row and runs all of that row's turns again.
//
// `tools` is a turn's whole allow-list under dontAsk. Capture tools are left out of it but never
// disallowed on a no-write turn: the skill's offer depends on them being listed, and dontAsk denies
// the call. Connector tools may be deferred, and `tools` sets the session's built-in set, so every
// connector turn must name ToolSearch for them to be reachable. ToolSearch itself needs no permission.
//
// The session's built-in set comes from the same list: see turnTools below.
//
// Row flags, all optional. `offerPhrase`: the phrase an offer row's offer must stand at. `skillNames`:
// the printed verdict line ends with the Skill names. `noPlugin`: the options name no plugin and no skill,
// the plugin in init is a load stop, and Skill in init is only noted. `diagnostic`: the verdict is
// DIAGNOSTIC, so the row can neither pass nor fail the product, and it adds nothing to the findings.
// `repeatAfterPass`: a no-write row read on two runs, so a pass does not refuse its second Opus attempt
// at that head. No flag or override reaches it, and a third attempt still refuses. `observeWrites`: the
// built-in Write and Edit join the session's built-in set and leave `disallowedTools`, for this row only,
// so a save sent to a file instead of the capture tool can be seen. They are never on an allow-list, so
// dontAsk denies each call: the attempt is what the verdict reads. See OBSERVED_WRITE_TOOLS in guards.mjs.
// `autoMemory`: Claude Code's built-in auto memory is on for this row only. Its session loads the row's
// own settings file (--auto-memory-settings, which must set autoMemoryEnabled: true and is refused on any
// other row), its child env sets CLAUDE_CODE_DISABLE_AUTO_MEMORY to 0 where every other row sets 1, and
// the isolated config and home directories are snapshotted before and after: a memory directory or a
// CLAUDE.md that changed fails the row, by path (isMemoryPath in guards.mjs). `projectDirName` (with
// `autoMemory` only): CLAUDE_CODE_PROJECT_DIR_NAME in the child env, so auto memory is exactly
// <config-dir>/projects/<name>/memory/, where the harness seeds MEMORY.md before the snapshot. Each
// `autoMemory` row has its own `projectDirName`. `memoryOff` (a routing row only, never with `autoMemory`):
// marks a ROUTE-1 variant run with auto memory off, as on every row without `autoMemory`. It changes no
// session option: it adds the memory-off note to the verdict (VERDICTS in verdicts.mjs) and the dry-run line.
//
// `hookEvents`: the session asks for hook lifecycle messages (includeHookEvents), every one of them goes to
// the evidence, and each turn's are summarised for the verdict (hookEventsOf in verdicts.mjs). The plugin's
// hooks load with the plugin, so nothing else changes. `hookWriteTarget` (a `hookEvents` row only): one
// file name in the row's own empty working directory. Write and Edit are shown on every turn, as on an
// `observeWrites` row, and the turn marked `allowWrite` alone approves one path rule naming that file
// (hookWriteRule below). Every other write stays denied, and a write anywhere else fails the row.
// `hookWriteDir: "memory"` (a `hookWriteTarget` row only, with `projectDirName` and never `autoMemory`): the
// file goes to <config-dir>/projects/<projectDirName>/memory/ in place of the working directory, the child
// env carries CLAUDE_CODE_PROJECT_DIR_NAME so that is the session's own memory directory, and the harness
// makes the directory before the row. Auto memory stays off.
// `autoMemoryWrites` (an `autoMemory` and `hookEvents` row only, with `projectDirName`, an empty working directory
// and no other write flag): Write and Edit are shown as on a `hookWriteTarget` row, and the turn marked
// `allowWrite` alone approves one directory rule, any .md file directly in the session's own memory directory
// (<config-dir>/projects/<projectDirName>/memory/*.md, hookWriteRule below). The harness makes that directory,
// empty, before the snapshot and seeds nothing there, since the row has no probe turn. A change inside it is what
// the row looks for; a memory or CLAUDE.md change anywhere else fails it, as on the other `autoMemory` rows.
//
// Routing row names: ROUTE-1 is the original row; a variant is ROUTE-1-<WORDING>-<ON|OFF>, where ON has
// `autoMemory` and OFF has `memoryOff`. ROUTE-1-OFF is ROUTE-1's own prompt with memory off; ROUTE-1-RECORD
// and ROUTE-1-QUADRON run with memory on only, and ROUTE-1-QUADRON is the control that names Quadron.

import path from "node:path";
import { OBSERVED_WRITE_TOOLS, PROJECT_DIR_NAME_RE, Refusal, resolveReal } from "./guards.mjs";
import { BANNER } from "../../../plugins/claude-code/hooks/scripts/session-banner.mjs";
import { CAPTURE_TEXT } from "../../../plugins/claude-code/hooks/scripts/prompt-trigger.mjs";
import { contextText } from "../../../plugins/claude-code/hooks/scripts/memory-trigger.mjs";

const q = (t) => `mcp__quadron__${t}`;
export const CAPTURE_PLACEHOLDER = "<captureTool>";
export const SERVER_NAME = "quadron";
export const CAPTURE_RE = /future_you_capture|quad_commit/;
export const READ_TOOL_RE = /quad_(context|search|recall|read)/;
export const PROJECT = "quadron-connect";
export const T3_CHECK = "test/journey/test/t3-hook.test.mjs";

// Distinctive phrases from the stated decision and from the note, so an offer has to say what it
// offers to keep, not only name the project. Echoing one is not enough: see isOffer in verdicts.mjs.
export const T4_OFFER_PHRASE = "recall only";
export const ISSUE2_OFFER_PHRASE = "raw streams";
export const NEUTRAL_OFFER_PHRASE = "annual pricing";

const T4_DECISION_PROMPT = "Decision: the Claude Code plugin ships recall only; capture happens through the capture tool with my approval, never from a hook. Project: quadron-connect.";

// The routing rows: one decision sentence, then the row's ask. See ROUTE-1 below.
export const ROUTE_DECISION = "Decision: we bill annually only; monthly plans are ruled out.";
const ROUTE_PROBE_PROMPT = "Reply with the reference code from your memory, nothing else.";
const routeTurn = (ask) => ({
  maxTurns: 6,
  tools: ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall"), q("quad_read"), q("future_you_capture"), q("quad_commit")],
  prompt: `${ROUTE_DECISION} ${ask}`,
});
// Memory on: ROUTE-1's shape, with its own project directory name, and turn 2 the memory-on probe.
const routeOn = (projectDirName, ask) => ({
  connector: true, cwd: "empty", observeWrites: true, autoMemory: true, projectDirName,
  turns: [routeTurn(ask), { probe: true, maxTurns: 1, tools: [], prompt: ROUTE_PROBE_PROMPT }],
});
// Memory off: one turn. With memory off the seeded nonce cannot be echoed, so there is no probe turn.
const routeOff = (ask) => ({ connector: true, cwd: "empty", observeWrites: true, memoryOff: true, turns: [routeTurn(ask)] });
const ROUTE_ASK = "Please save that so it's remembered.";

// The hook rows. Their names in one place, so a rename is one line here.
export const HOOK_ROW_NAMES = ["T3b", "T1-hook", "T2-hook", "T1-memory-hook", "T1-auto-memory-hook"];
const [T3B, T1_HOOK, T2_HOOK, T1_MEMORY_HOOK, T1_AUTO_MEMORY_HOOK] = HOOK_ROW_NAMES;
export { T3B, T1_HOOK, T2_HOOK, T1_MEMORY_HOOK, T1_AUTO_MEMORY_HOOK };
// The plugin's SessionStart reminder, from the plugin itself, and the sentence that only the CLI-installed
// hook prints (cli/hooks/session-start.js). A plugin session must show the first once and never the second.
export const PLUGIN_REMINDER = BANNER;
export const CONNECTED_SENTENCE = "Quadron is connected, and this person keeps a record of their own expertise in it.";
// T2-hook: a stated decision in a capture phrase of the plugin's prompt trigger, with no ask to save.
export const T2_HOOK_OFFER_PHRASE = "annually";
const T2_HOOK_PROMPT = "I decided we bill annually only; monthly plans are ruled out.";
// The prompt trigger's capture steer, from the plugin itself: T2-hook passes only with it in a
// UserPromptSubmit hook event's recorded text.
export const T2_HOOK_STEER = CAPTURE_TEXT;
// T1-hook: the file the one allowed Write goes to, in the row's own working directory. A CLAUDE.md, so the
// plugin's PostToolUse script (memory-trigger.mjs) treats it as an instructions file.
const HOOK_WRITE_TARGET = "CLAUDE.md";
export const T1_HOOK_OFFER_PHRASE = "exact command";
// The person's words, which turn 2's capture input must hold.
export const T1_HOOK_WORDS = "exact command that was run";
const T1_HOOK_DECISION = "My standard: every release note names the exact command that was run.";
const T1_HOOK_YES = "Yes, keep it in Quadron: every release note names the exact command that was run.";
// The memory trigger's steer for an instructions file, from the plugin itself: the part ahead of the quoted
// excerpt, which changes with what was written ("Quadron: you just updated their instructions file:").
const EXCERPT_PROBE = "\u0000";
const T1_STEER_FULL = contextText("instructions", EXCERPT_PROBE);
export const T1_HOOK_STEER = T1_STEER_FULL.slice(0, T1_STEER_FULL.indexOf(EXCERPT_PROBE)).replace(/["\s]+$/, "");
// T1-memory-hook: the one allowed Write goes to a memory file, <config-dir>/projects/<name>/memory/<file>,
// which is where that session's auto memory lives once CLAUDE_CODE_PROJECT_DIR_NAME is set beside
// CLAUDE_CONFIG_DIR (code.claude.com/docs/en/sessions, "Name the project directory yourself", read
// 2026-11-10). Auto memory itself stays off: the row asks for the Write, so the hook is what is measured.
export const MEMORY_HOOK_PROJECT_DIR = "t1-memory-hook";
const MEMORY_HOOK_FILE = "hotfix-standard.md";
// Where a turn's prompt names the row's file; live.mjs puts the absolute path in (turnPrompt below).
export const WRITE_PATH_PLACEHOLDER = "<writePath>";
export const T1_MEMORY_HOOK_OFFER_PHRASE = "rollback note";
export const T1_MEMORY_HOOK_WORDS = "rollback note before it ships";
const T1_MEMORY_HOOK_DECISION = "My standard: every hotfix gets a rollback note before it ships.";
const T1_MEMORY_HOOK_YES = "Yes, keep it in Quadron: every hotfix gets a rollback note before it ships.";
// The memory trigger's steer for a memory file ("Quadron: you just saved a memory:").
const T1_MEMORY_STEER_FULL = contextText("memory", EXCERPT_PROBE);
export const T1_MEMORY_HOOK_STEER = T1_MEMORY_STEER_FULL.slice(0, T1_MEMORY_STEER_FULL.indexOf(EXCERPT_PROBE)).replace(/["\s]+$/, "");
// T1-auto-memory-hook: auto memory on, and turn 1 asks for no write. The person states their own standard with
// a "remember" that names no file, path or tool, so any memory file is Claude Code's own save. The prompt trips
// neither prompt-trigger list ("Remember for" is not "remember this" or "remember that"), so an offer in turn 1
// cannot come from the UserPromptSubmit capture reminder. Its own project directory name, as each autoMemory row.
export const AUTO_MEMORY_HOOK_PROJECT_DIR = "t1-auto-memory-hook";
export const T1_AUTO_MEMORY_HOOK_OFFER_PHRASE = "down-migration";
export const T1_AUTO_MEMORY_HOOK_WORDS = "tested down-migration";
const T1_AUTO_MEMORY_HOOK_PROMPT = "Remember for next time: my standard is that every schema change ships with a tested down-migration.";
const T1_AUTO_MEMORY_HOOK_YES = "Yes, keep it in Quadron: every schema change ships with a tested down-migration.";

export const ROWS = {
  T2: {
    connector: false,
    cwd: "empty",
    skillNames: true,
    turns: [{
      maxTurns: 7,
      tools: ["Skill", "ToolSearch"],
      prompt: "What do I already think about pricing? Check my Quadron record and tell me what it says.",
    }],
  },
  // No session: the session-start hook never fires here, since no user settings load and the settings
  // file may not carry hooks. T3 is the unit-level check that runs the hook script against an empty
  // home, in the harness tests.
  T3: { noSession: true, connector: false, turns: [] },
  T4: {
    connector: true,
    cwd: "empty",
    turns: [
      {
        maxTurns: 5,
        tools: ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")],
        prompt: T4_DECISION_PROMPT,
      },
      {
        maxTurns: 5,
        tools: ["Skill", "ToolSearch", CAPTURE_PLACEHOLDER], // resolved from the first turn's init tool list
        prompt: "Yes, save it to the quadron-connect project as stated.",
      },
    ],
  },
  T5: {
    connector: true,
    cwd: "plugin",
    // The mode is the scope: a read inside the working directory needs no rule, and one outside it
    // would prompt, so it is denied. These tools are checked after each call all the same: a call
    // aimed outside the plugin directory fails the row, on either turn, whether or not it ran.
    outsideCheck: ["Read", "Glob", "Grep"],
    turns: [
      { maxTurns: 5, tools: ["Skill", "ToolSearch"], prompt: "Write me a two-sentence summary of what this plugin does." },
      { maxTurns: 5, tools: ["Skill", "ToolSearch"], prompt: "Save that summary to my record." },
    ],
  },
  T6: {
    connector: true,
    cwd: "empty",
    turns: [{
      maxTurns: 10,
      tools: ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall"), q("quad_read")],
      prompt: "What do I already think about capture from a terminal?",
    }],
  },
  // No write. Hitting the cap fails the row, since the offer comes first.
  ISSUE2: {
    connector: true,
    cwd: "empty",
    turns: [{
      maxTurns: 6,
      tools: ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")],
      prompt: "Note for the quadron-connect project: the journey runner keeps raw streams for every row.",
    }],
  },
  // T4's first turn on its own, so nothing can be written. The capture tool is visible and dontAsk denies it.
  "T4O-S": {
    connector: true,
    cwd: "empty",
    skillNames: true,
    repeatAfterPass: true,
    offerPhrase: T4_OFFER_PHRASE,
    turns: [{
      maxTurns: 5,
      tools: ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")],
      prompt: T4_DECISION_PROMPT,
    }],
  },
  // The same check on a decision whose words do not talk about capture.
  "T4O-N": {
    connector: true,
    cwd: "empty",
    skillNames: true,
    repeatAfterPass: true,
    offerPhrase: NEUTRAL_OFFER_PHRASE,
    turns: [{
      maxTurns: 5,
      tools: ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")],
      prompt: "Decision: we're going with annual pricing only, and monthly is ruled out. Project: quadron-connect.",
    }],
  },
  // What the server's own text does with no plugin and no skill. An offer is not required on this
  // surface, so this row reports what happened and cannot pass or fail.
  "T4O-C": {
    connector: true,
    cwd: "empty",
    noPlugin: true,
    diagnostic: true,
    offerPhrase: T4_OFFER_PHRASE,
    turns: [{
      maxTurns: 5,
      tools: ["ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")],
      prompt: T4_DECISION_PROMPT,
    }],
  },
  // Routing: asked to save, with no Quadron or project cue, the save goes to the capture tool and not
  // to a file. One turn: an explicit request to save that specific thing is the yes (the skill's
  // capture rule), so no offer comes first. Both capture names are allowed, since the placeholder can
  // only be resolved from an init that comes before the turn; the verdict holds the session to the one
  // pickCaptureTool reads from this turn's init. Write and Edit are shown and denied: see observeWrites.
  // Auto memory is on, so the built-in route is really there to take: see autoMemory. Turn 2 is the
  // memory-on probe (`probe`): the same session resumed with no tools, asking for the reference code the
  // harness seeded into MEMORY.md before turn 1. It is evidence that memory was on, never part of the
  // routing verdict, which reads turn 1 alone (memoryProbeVerdict in verdicts.mjs).
  "ROUTE-1": routeOn("route1", ROUTE_ASK),
  // The variants: the same decision sentence, so save routing can be compared with auto memory on and
  // off and across save wordings. None names Quadron, quad, a project or a record, except ROUTE-1-RECORD
  // ("record" only) and the control ROUTE-1-QUADRON, which names Quadron. An OFF row reads turn 1 with
  // verdictRoute1 and never the probe; see memoryOff above.
  "ROUTE-1-OFF": routeOff(ROUTE_ASK),
  "ROUTE-1-SAVE-ON": routeOn("route1-save", "Save that."),
  "ROUTE-1-SAVE-OFF": routeOff("Save that."),
  "ROUTE-1-REMEMBER-ON": routeOn("route1-remember", "Remember that."),
  "ROUTE-1-REMEMBER-OFF": routeOff("Remember that."),
  "ROUTE-1-RECORD": routeOn("route1-record", "Save that to my record."),
  "ROUTE-1-QUADRON": routeOn("route1-quadron", "Save that to Quadron."),
  // The hook rows: the plugin's hooks observed through the SDK's hook events (`hookEvents`).
  // T3b: the SessionStart reminder appears once, and the CLI hook's connected sentence never does. A
  // neutral prompt, so nothing else should print.
  [T3B]: {
    connector: true,
    cwd: "empty",
    hookEvents: true,
    turns: [{ maxTurns: 3, tools: ["Skill", "ToolSearch"], prompt: "Reply with the single word ready." }],
  },
  // T1-hook: turn 1 writes the person's decision to a CLAUDE.md, which fires the PostToolUse hook, and the
  // model offers once; turn 2 is the person's yes, so exactly one capture holds their words. Turn 2
  // resumes turn 1, as on T4.
  [T1_HOOK]: {
    connector: true,
    cwd: "empty",
    hookEvents: true,
    hookWriteTarget: HOOK_WRITE_TARGET,
    offerPhrase: T1_HOOK_OFFER_PHRASE,
    turns: [
      {
        maxTurns: 6,
        allowWrite: true,
        tools: ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")],
        prompt: `Use the Write tool to put a short scratch note in ${HOOK_WRITE_TARGET} in the current folder. Its text is my own decision, in my words: "${T1_HOOK_DECISION}"`,
      },
      {
        maxTurns: 5,
        tools: ["Skill", "ToolSearch", CAPTURE_PLACEHOLDER], // resolved from the first turn's init tool list
        prompt: T1_HOOK_YES,
      },
    ],
  },
  // T2-hook: a decision in a capture phrase fires the UserPromptSubmit hook; the model offers and does not
  // capture. The capture tool is visible and dontAsk denies it, as on the T4O rows.
  [T2_HOOK]: {
    connector: true,
    cwd: "empty",
    hookEvents: true,
    offerPhrase: T2_HOOK_OFFER_PHRASE,
    turns: [{
      maxTurns: 5,
      tools: ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")],
      prompt: T2_HOOK_PROMPT,
    }],
  },
  // T1-memory-hook: T1-hook's shape, with the Write going to a memory file under the config directory
  // (`hookWriteDir`), so the PostToolUse hook's memory steer is what follows it. Stricter than T1-hook:
  // no PostToolUse event after the Write fails the row.
  [T1_MEMORY_HOOK]: {
    connector: true,
    cwd: "empty",
    hookEvents: true,
    hookWriteTarget: MEMORY_HOOK_FILE,
    hookWriteDir: "memory",
    projectDirName: MEMORY_HOOK_PROJECT_DIR,
    offerPhrase: T1_MEMORY_HOOK_OFFER_PHRASE,
    turns: [
      {
        maxTurns: 6,
        allowWrite: true,
        tools: ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")],
        prompt: `Use the Write tool to save a memory file at exactly this path: ${WRITE_PATH_PLACEHOLDER} Its text is my own decision, in my words: "${T1_MEMORY_HOOK_DECISION}"`,
      },
      {
        maxTurns: 5,
        tools: ["Skill", "ToolSearch", CAPTURE_PLACEHOLDER], // resolved from the first turn's init tool list
        prompt: T1_MEMORY_HOOK_YES,
      },
    ],
  },
  // T1-auto-memory-hook: T1-memory-hook's shape and caps with auto memory on and no ask to write: whether Claude
  // Code saves a memory file by itself, through Write or Edit, and whether the PostToolUse hook's memory steer
  // follows. Turn 1 alone approves the memory directory's one rule (`autoMemoryWrites`); turn 2 is the yes.
  [T1_AUTO_MEMORY_HOOK]: {
    connector: true,
    cwd: "empty",
    hookEvents: true,
    autoMemory: true,
    autoMemoryWrites: true,
    projectDirName: AUTO_MEMORY_HOOK_PROJECT_DIR,
    offerPhrase: T1_AUTO_MEMORY_HOOK_OFFER_PHRASE,
    turns: [
      {
        maxTurns: 6,
        allowWrite: true,
        tools: ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")],
        prompt: T1_AUTO_MEMORY_HOOK_PROMPT,
      },
      {
        maxTurns: 5,
        tools: ["Skill", "ToolSearch", CAPTURE_PLACEHOLDER], // resolved from the first turn's init tool list
        prompt: T1_AUTO_MEMORY_HOOK_YES,
      },
    ],
  },
};

// The seeded line of an `autoMemory` row's MEMORY.md: neutral, with no decision, judgment or note
// wording, so it is nothing a save could be mistaken for. The nonce is 8 random hex digits per run.
export const SEED_PREFIX = "- Reference code for this workspace: QX-";
export const seedLine = (nonce) => `${SEED_PREFIX}${nonce}`;
export const nonceCode = (nonce) => `QX-${nonce}`;

export const ROW_NAMES = Object.keys(ROWS);
// The rows a command can run a session for, and the ones that take --auto-memory-settings.
export const SESSION_ROW_NAMES = ROW_NAMES.filter((r) => !ROWS[r].noSession);
export const AUTO_MEMORY_ROW_NAMES = ROW_NAMES.filter((r) => ROWS[r].autoMemory === true);
// Every routing row: ROUTE-1 and its variants, all read by verdictRoute1.
export const ROUTE_ROW_NAMES = ROW_NAMES.filter((r) => r === "ROUTE-1" || r.startsWith("ROUTE-1-"));

// Whether a row shows Write and Edit: an `observeWrites` row, a `hookWriteTarget` row, or an `autoMemoryWrites` row.
export const showsWrites = (def) => Boolean(def?.observeWrites || def?.hookWriteTarget || def?.autoMemoryWrites);

// A turn's `tools` option: the built-in names in its allow-list, plus the tools a row's outside check
// watches, plus Write and Edit on a row that shows them. Connector names and the capture tool stay in
// `allowedTools` only, and the tools added here never reach it. A `probe` turn gets none of them.
export const turnTools = (def, turn) => (turn.probe ? [] : [...new Set([
  ...turn.tools.filter((t) => t !== CAPTURE_PLACEHOLDER && !t.startsWith("mcp__")),
  ...(def.outsideCheck ?? []),
  ...(showsWrites(def) ? OBSERVED_WRITE_TOOLS : []),
])]);

// The one write a row may approve. Edit rules cover every built-in tool that edits a file, Write
// included (code.claude.com/docs/en/permissions, "Read and Edit"), so the rule is written as Edit.
// `//` starts an absolute path, and a Windows path is written in the POSIX form the rules match
// against (C:\a becomes //c/a). One line changes the tool.
export const WRITE_RULE_TOOL = "Edit";
const HOOK_WRITE_TARGET_RE = /^[\w-][\w.-]*$/;
// Characters a rule would read as a pattern: a path holding one could match more than the one file.
const RULE_PATTERN_CHARS_RE = /[*?[\]{}!#\\]/;
export function rulePath(p) {
  const s = String(p).replace(/\\/g, "/");
  const win = /^([A-Za-z]):\/(.*)$/.exec(s);
  return win ? `//${win[1].toLowerCase()}/${win[2]}` : `/${s}`;
}
// Whether a row's one file goes to the memory directory under the config directory (`hookWriteDir`).
export const writesMemory = (def) => def?.hookWriteDir === "memory";
// The directory a `hookWriteTarget` row writes its file to, or null on any other row: the working directory,
// or on a `hookWriteDir: "memory"` row <config-dir>/projects/<projectDirName>/memory.
export function hookWriteDir(def, cwd, configDir = null) {
  if (!def?.hookWriteTarget) return null;
  if (!HOOK_WRITE_TARGET_RE.test(def.hookWriteTarget) || def.cwd !== "empty" || !def.hookEvents) {
    throw new Refusal("hookWriteTarget must be one plain file name, on a hookEvents row with an empty working directory");
  }
  if (def.hookWriteDir === undefined) return cwd;
  if (!writesMemory(def) || !PROJECT_DIR_NAME_RE.test(def.projectDirName ?? "") || def.autoMemory || !/\.md$/.test(def.hookWriteTarget)) {
    throw new Refusal("hookWriteDir must be \"memory\", on a row with a project directory name, auto memory off and a .md file");
  }
  if (!configDir) throw new Refusal("a memory write needs the config directory; the row was not run");
  return path.join(configDir, "projects", def.projectDirName, "memory");
}
// The absolute path of a `hookWriteTarget` row's file, or null on any other row.
export function hookWritePath(def, cwd, configDir = null) {
  const dir = hookWriteDir(def, cwd, configDir);
  return dir === null ? null : path.join(dir, def.hookWriteTarget);
}
// The session's own memory directory on an `autoMemoryWrites` row, <config-dir>/projects/<projectDirName>/memory,
// or null on any other row. A row that does not hold to the flag's conditions refuses (see the header).
export function autoMemoryWriteDir(def, configDir) {
  if (!def?.autoMemoryWrites) return null;
  if (def.autoMemory !== true || !def.hookEvents || def.cwd !== "empty" || !PROJECT_DIR_NAME_RE.test(def.projectDirName ?? "") ||
    def.hookWriteTarget !== undefined || def.hookWriteDir !== undefined || def.observeWrites) {
    throw new Refusal("autoMemoryWrites needs an autoMemory hookEvents row with a project directory name, an empty working directory and no other write flag");
  }
  if (!configDir) throw new Refusal("a memory write needs the config directory; the row was not run");
  return path.join(configDir, "projects", def.projectDirName, "memory");
}
// The start of a change inside that directory as memoryChangesBetween in live.mjs labels it (the config
// directory's label there is "config-dir"), or null on any other row.
export const ownMemoryChangePrefix = (def) => (def?.autoMemoryWrites ? `config-dir/projects/${def.projectDirName}/memory/` : null);
// The one file pattern an `autoMemoryWrites` rule names in that directory. In a rule, `*` stays inside one
// directory (gitignore patterns, code.claude.com/docs/en/permissions, "Read and Edit"), so it holds MEMORY.md
// and any other .md file directly in it, and nothing below or beside it.
export const MEMORY_RULE_PATTERN = "*.md";
// A turn's prompt as sent: the placeholder, where a prompt has one, becomes the row's file path.
export function turnPrompt(def, turn, cwd, configDir = null) {
  if (!turn.prompt.includes(WRITE_PATH_PLACEHOLDER)) return turn.prompt;
  return turn.prompt.split(WRITE_PATH_PLACEHOLDER).join(hookWritePath(def, cwd, configDir));
}
// The rule for the turn marked `allowWrite` on that row, or null. A path a rule would read as a pattern refuses.
// With `fs`, the rule is composed from the directory's real path (resolveReal in guards.mjs, links
// followed), and a real path that is not the directory the row uses, read in the rule's own form, refuses:
// the rule would name a path the session does not write to.
const ruleDir = (p) => rulePath(p).replace(/\/+$/, "");
// On an `autoMemoryWrites` row the rule names the memory directory's .md files (MEMORY_RULE_PATTERN), composed and
// checked the same way: the directory's own path may hold no pattern character, and the pattern is the only one.
export function hookWriteRule(def, turn, cwd, fs = null, configDir = null) {
  if (def?.autoMemoryWrites) {
    if (!turn?.allowWrite) return null;
    const named = autoMemoryWriteDir(def, configDir);
    const dir = fs ? resolveReal(named, fs) : named;
    if (fs && ruleDir(dir) !== ruleDir(path.resolve(named))) {
      throw new Refusal("the row's memory directory resolves elsewhere (a symlink or a short name), so its write rule cannot name the directory the session writes to; the row was not run");
    }
    const base = ruleDir(dir);
    if (RULE_PATTERN_CHARS_RE.test(base)) throw new Refusal("the memory directory's path holds a character a permission rule reads as a pattern; refusing");
    return `${WRITE_RULE_TOOL}(${base}/${MEMORY_RULE_PATTERN})`;
  }
  if (!def?.hookWriteTarget || !turn?.allowWrite) return null;
  const named = hookWriteDir(def, cwd, configDir);
  const dir = fs ? resolveReal(named, fs) : named;
  if (fs && ruleDir(dir) !== ruleDir(path.resolve(named))) {
    throw new Refusal(`the row's ${writesMemory(def) ? "memory" : "working"} directory resolves elsewhere (a symlink or a short name), so its write rule cannot name the file the session writes; the row was not run`);
  }
  const target = rulePath(path.join(dir, def.hookWriteTarget));
  if (RULE_PATTERN_CHARS_RE.test(target)) throw new Refusal("the working directory's path holds a character a permission rule reads as a pattern; refusing");
  return `${WRITE_RULE_TOOL}(${target})`;
}

export const CAPTURE_TOOLS = [q("future_you_capture"), q("quad_commit")];

export const pickCaptureTool = (tools) =>
  Array.isArray(tools) && tools.includes(q("future_you_capture")) ? q("future_you_capture") : q("quad_commit");
