// Row definitions. Prompts follow the plugin README's journey checks. Turn caps are the token
// budget. A two-turn row runs as one command and one session; the second turn resumes the first.
// A retry names one row and runs all of that row's turns again.
//
// `tools` is a turn's whole allow-list under dontAsk. Capture tools are left out of it but never
// disallowed on a no-write turn: the skill's offer depends on them being listed, and dontAsk denies
// the call. Connector tools may be deferred, and nothing can approve ToolSearch later, so every
// connector turn lists it.

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

export const ROWS = {
  T2: {
    connector: false,
    cwd: "empty",
    turns: [{
      maxTurns: 7,
      tools: ["Skill", "ToolSearch"],
      prompt: "What do I already think about pricing? Check my Quadron record and tell me what it says.",
    }],
  },
  // No session: the session-start hook never fires in bare mode. T3 is the unit-level check that
  // runs the hook script against an empty home, in the harness tests.
  T3: { noSession: true, connector: false, turns: [] },
  T4: {
    connector: true,
    cwd: "empty",
    turns: [
      {
        maxTurns: 5,
        tools: ["Skill", "ToolSearch", q("quad_context"), q("quad_search"), q("quad_recall")],
        prompt: "Decision: the Claude Code plugin ships recall only; capture happens through the capture tool with my approval, never from a hook. Project: quadron-connect.",
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
};

export const ROW_NAMES = Object.keys(ROWS);

export const pickCaptureTool = (tools) =>
  Array.isArray(tools) && tools.includes(q("future_you_capture")) ? q("future_you_capture") : q("quad_commit");
