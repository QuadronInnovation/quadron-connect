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
// CLAUDE.md that changed fails the row, by path (isMemoryPath in guards.mjs).

import { OBSERVED_WRITE_TOOLS } from "./guards.mjs";

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
  // Auto memory is on, so the built-in route is really there to take: see autoMemory.
  "ROUTE-1": {
    connector: true,
    cwd: "empty",
    observeWrites: true,
    autoMemory: true,
    turns: [{
      maxTurns: 6,
      tools: ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall"), q("quad_read"), q("future_you_capture"), q("quad_commit")],
      prompt: "Decision: we bill annually only; monthly plans are ruled out. Please save that so it's remembered.",
    }],
  },
};

export const ROW_NAMES = Object.keys(ROWS);

// A turn's `tools` option: the built-in names in its allow-list, plus the tools a row's outside check
// watches, plus Write and Edit on an `observeWrites` row. Connector names and the capture tool stay in
// `allowedTools` only, and the tools added here never reach it.
export const turnTools = (def, turn) => [...new Set([
  ...turn.tools.filter((t) => t !== CAPTURE_PLACEHOLDER && !t.startsWith("mcp__")),
  ...(def.outsideCheck ?? []),
  ...(def.observeWrites ? OBSERVED_WRITE_TOOLS : []),
])];

export const CAPTURE_TOOLS = [q("future_you_capture"), q("quad_commit")];

export const pickCaptureTool = (tools) =>
  Array.isArray(tools) && tools.includes(q("future_you_capture")) ? q("future_you_capture") : q("quad_commit");
