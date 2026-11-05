// Findings log: observations about the plugin or server that are recorded, never retried.
// `findings.jsonl` under --out is append-only: one redacted JSON object per line. A failed append
// is remembered in `writeFailed`, and the run treats it like any other failed evidence write.

import path from "node:path";

export const OWNER_UNAVAILABLE_RE = /capture_owner_unavailable/;
// An MCP 401 as it reaches a tool result or a result message. A bare "401" is not enough: a number
// in an answer must not read as an auth failure.
export const MCP_401_RE = /\bHTTP(?:\/\d(?:\.\d)?)?[\s:]+401\b|\bstatus(?:[\s_]*code)?["']?\s*[:=]?\s*401\b|\b401\s+Unauthorized\b|\bMCP\b[^\n]{0,60}\b401\b/i;
// Wider, and only on text that is already an error: an errored tool result or a result's errors list.
// The real wording is unmeasured until a keyed run.
export const ERROR_AUTH_RE = /\b401\b|unauthori[sz]ed|invalid[_ -]token|token (?:has |is )?expired|expired token|authentication (?:required|failed|error)|not authenticated|needs-auth|www-authenticate/i;
const STATUS_KEY_RE = /^(?:status|status_?code|http_?status|code)$/i;

export class FindingsLog {
  constructor({ dir, fs, red, now = () => Date.now() }) {
    this.items = [];
    this.file = path.join(dir, "findings.jsonl");
    this.fs = fs;
    this.red = red;
    this.now = now;
    this.writeFailed = false;
  }

  add(f) {
    const item = this.red.deep({ at: new Date(this.now()).toISOString(), ...f });
    this.items.push(item);
    try { this.fs.appendFileSync(this.file, `${JSON.stringify(item)}\n`); } catch { this.writeFailed = true; }
    return item;
  }
}

const resultTexts = (s) => [
  ...s.tool_results.map((r) => r.text ?? ""),
  ...s.tool_results.map((r) => (r.structured === undefined ? "" : JSON.stringify(r.structured))),
  typeof s.result?.result === "string" ? s.result.result : "",
  ...(Array.isArray(s.result?.errors) ? s.result.errors.map(String) : []),
];

// A status field of 401 at any depth of a structured tool result, or of a JSON tool result.
function hasStatus401(v) {
  if (Array.isArray(v)) return v.some(hasStatus401);
  if (!v || typeof v !== "object") return false;
  return Object.entries(v).some(([k, x]) => (STATUS_KEY_RE.test(k) && (x === 401 || x === "401")) || hasStatus401(x));
}
const parsed = (text) => { try { return JSON.parse(text); } catch { return null; } };

// Read from every tool output and result, error or not, whatever else stopped the call.
export function scanSignals(s, extraText = "") {
  const texts = [...resultTexts(s), extraText];
  const errorTexts = [...s.tool_results.filter((r) => r.is_error).map((r) => r.text ?? ""), ...(Array.isArray(s.result?.errors) ? s.result.errors.map(String) : [])];
  return {
    auth401: texts.some((t) => MCP_401_RE.test(t)) ||
      errorTexts.some((t) => ERROR_AUTH_RE.test(t)) ||
      s.tool_results.some((r) => hasStatus401(r.structured) || hasStatus401(parsed(r.text ?? ""))) ||
      s.result?.api_error_status === 401, // sdk.d.ts:6093
    ownerUnavailable: texts.some((t) => OWNER_UNAVAILABLE_RE.test(t)),
  };
}

// A Haiku failure on a row that already passed on Opus (per the ledger) is a finding about the
// plugin's instructions. It triggers no retry. A budget stop, a partial or WITHHELD is not one.
export function haikuFailureFinding({ row, model, head, verdict, ledger, log }) {
  if (!/haiku/i.test(model) || verdict !== "FAIL") return false;
  const opusPassed = ledger.entries.some((e) => e.kind === "row" && e.row === row && e.head === head && /opus/i.test(e.model) && /^PASS/.test(e.verdict));
  if (opusPassed) log.add({ kind: "haiku_failure_after_opus_pass", row, model, head, detail: "no retry" });
  return opusPassed;
}
