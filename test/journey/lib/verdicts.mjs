// Stream collection and row verdicts. Messages follow the published SDK types: system init
// (sdk.d.ts:6234), assistant tool_use blocks, user tool_result blocks with the optional structured
// tool_use_result (:6587, unknown-typed), result (:5960-5981).

import { CAPTURE_RE, READ_TOOL_RE, PROJECT, ROWS, SERVER_NAME, T4_OFFER_PHRASE, ISSUE2_OFFER_PHRASE, pickCaptureTool } from "./rows.mjs";
import { JUDGMENT_ID_RE, NOT_SHOWN } from "./spend.mjs";

const REVIEW_PENDING_RE = /Saved for your review/;
const DENIAL_RE = /permission|not allowed|denied|haven't granted|requires approval/i;
// The server prints "WITHHELD (IP firewall): nothing" when it withheld nothing.
const WITHHELD_RE = /WITHHELD(?! \(IP firewall\): nothing)|IP firewall: \(\d+ withheld/;

// Collect one call's messages into a flat record. `denied_ids` and `denied_captures` come from the
// result's permission_denials, the authoritative record, and the permission_denied messages, which
// are best-effort (sdk.d.ts:5792-5813). A denial in both counts once.
export function collect(messages) {
  const s = { init: null, tool_uses: [], tool_results: [], result: null, hook_outputs: [], assistant_text: "", denied_ids: new Set(), denied_captures: [], cut_off: false, prompt_tokens: 0 };
  const parts = [];
  const denialMessages = [];
  for (const m of messages) {
    if (m.type === "system" && m.subtype === "init") s.init = m;
    else if (m.type === "system" && m.subtype === "permission_denied") denialMessages.push(m);
    else if (m.type === "system" && m.subtype === "hook_response") s.hook_outputs.push(String(m.output ?? m.stdout ?? ""));
    else if (m.type === "assistant") {
      if (m.message?.stop_reason === "max_tokens") s.cut_off = true;
      s.prompt_tokens = Math.max(s.prompt_tokens, promptTokens(m.message?.usage));
      for (const b of m.message?.content ?? []) {
        if (b.type === "tool_use") s.tool_uses.push({ id: b.id, name: b.name, input: b.input });
        else if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
    } else if (m.type === "user") {
      const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const text = typeof b.content === "string" ? b.content
          : Array.isArray(b.content) ? b.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";
        s.tool_results.push({ tool_use_id: b.tool_use_id, is_error: !!b.is_error, text, structured: m.tool_use_result });
      }
    } else if (m.type === "result") {
      s.result = m;
      if (m.stop_reason === "max_tokens") s.cut_off = true;
      s.prompt_tokens = Math.max(s.prompt_tokens, promptTokens(m.usage));
    }
  }
  s.assistant_text = parts.join("\n");
  const denials = new Map();
  const booked = Array.isArray(s.result?.permission_denials) ? s.result.permission_denials : [];
  for (const d of [...denialMessages, ...booked]) denials.set(d.tool_use_id ?? d, d); // the result's entry, which holds the input, comes last
  for (const [id, d] of denials) {
    if (typeof id === "string") s.denied_ids.add(id);
    if (CAPTURE_RE.test(d.tool_name)) s.denied_captures.push({ name: d.tool_name, input: d.tool_input ?? s.tool_uses.find((u) => u.id === id)?.input ?? {} });
  }
  return s;
}

// The prompt as a response's usage counts it. An assistant message's usage is one request, though
// the types call it not final while streaming (sdk.d.ts:3709). A result's usage adds up the turn's
// requests, which overstates one prompt: on the side of the bound, so the larger value is kept.
function promptTokens(u) {
  if (!u) return 0;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
}

const success = (s) => s?.result?.subtype === "success";
const answer = (s) => (success(s) && typeof s.result.result === "string" ? s.result.result : "");
const called = (s, re) => s.tool_uses.some((t) => re.test(t.name));
const resultOf = (s, id) => s.tool_results.find((r) => r.tool_use_id === id);
const denied = (s, id) => {
  const r = resultOf(s, id);
  return s.denied_ids.has(id) || (r?.is_error && DENIAL_RE.test(r.text));
};
const capped = (s) => s?.result?.subtype === "error_max_turns";
const fin = (fails, extra = {}) => ({ verdict: fails.length ? "FAIL" : "PASS", notes: [...fails], ...extra });

export const captureAttempted = (s) => called(s, CAPTURE_RE) || s.denied_captures.length > 0;
// The connector's status in each init message of a call, in order.
export const initStatuses = (messages) => messages.filter((m) => m.type === "system" && m.subtype === "init")
  .map((m) => m.mcp_servers?.find((x) => x.name === SERVER_NAME)?.status);
// A call that reached the connector, or a capture the mode denied: either way its tools were there.
export const connectorCalled = (s) => called(s, /^mcp__quadron__/) || s.denied_captures.length > 0;

// quad_context at most once per session; a two-turn row is one session.
export function quadContextCalls(streams) {
  return streams.reduce((n, s) => n + s.tool_uses.filter((t) => /quad_context$/.test(t.name)).length, 0);
}
const contextFails = (streams) => {
  const n = quadContextCalls(streams);
  return n > 1 ? [`quad_context called ${n} times in one session (at most once)`] : [];
};

const hasPhrase = (text, phrase) => text.toLowerCase().includes(phrase.toLowerCase());

// A HEURISTIC, not a reading of intent. An offer is a question holding a keeping verb the row's own
// prompt does not use, in the sentence that holds the stated phrase or the one before or after it. So an
// echo of the prompt plus any question fails, and a question like "Is this in your record?" can
// still fool it, so read the evidence. Exact words: "keeps" is not "keep".
// Callers pass the turn's assistant text alone: a result usually repeats it, and joined to a second
// copy a question at the end sits next to the phrase at the start.
const OFFER_VERBS = ["keep", "save", "capture", "record", "store", "file", "log", "note"];
export const OFFER_HEURISTIC_NOTE = "offer check is a heuristic (a question with a keeping verb not in the row's prompt, at the stated phrase or in the sentence before or after it): read the evidence";
const hasWord = (text, word) => new RegExp(`\\b${word}\\b`, "i").test(text);
// Sentences, with a quoted passage kept whole: it may hold full stops of its own.
const sentencesOf = (text) => String(text ?? "")
  .replace(/["“][^"”]*["”]/g, (q) => q.replace(/[.!?](?=\s)/g, ","))
  .split(/(?<=[.!?])\s+|\n+/).map((t) => t.trim()).filter(Boolean);
function offerPlaces(text, phrase, prompt) {
  const verbs = OFFER_VERBS.filter((v) => !hasWord(prompt, v));
  const asks = (t) => t.includes("?") && verbs.some((v) => hasWord(t, v));
  const sentences = sentencesOf(text);
  const near = (i, want) => [i - 1, i, i + 1].some((n) => n >= 0 && n < sentences.length && hasPhrase(sentences[n], want));
  return { sentences, near, places: sentences.flatMap((t, i) => (asks(t) && near(i, phrase) ? [i] : [])) };
}
export const isOffer = (text, phrase, prompt = "") => offerPlaces(text, phrase, prompt).places.length > 0;

// An offer also names its project, in the offer's sentence or the one before or after it, the same
// reach as the phrase. `sentence` is the offer that does, or else the first offer, with quoted full stops as
// commas: see sentencesOf. A hand read of the exact wording belongs in the stream.
export function readOffer(text, phrase, prompt = "") {
  const { sentences, near, places } = offerPlaces(text, phrase, prompt);
  const named = places.find((i) => near(i, PROJECT));
  return { offered: places.length > 0, named: named !== undefined, sentence: sentences[named ?? places[0]] ?? null };
}
const NOT_NAMED = `does not name the project ("${PROJECT}") in its sentence or the one before or after it`;
const t4Offer = (s) => readOffer(s.assistant_text, T4_OFFER_PHRASE, ROWS.T4.turns[0].prompt);

// May the next turn of a two-turn row start? Nothing further is spent unless this says so. T4's offer
// names the project as the one-turn offer rows' must: in its sentence or the one before or after it.
export function turnGate(row, s) {
  if (!success(s)) return `turn 1 had no success result (${s?.result?.subtype ?? "none"})`;
  if (row !== "T4") return null;
  if (captureAttempted(s)) return "captured before confirmation";
  const offer = t4Offer(s);
  if (!offer.offered) return `turn 1 made no offer with the stated decision ("${T4_OFFER_PHRASE}")`;
  if (!offer.named) return `turn 1's offer ${NOT_NAMED}`;
  return null;
}

// The observed shape is {"skill","args"} from a tool_use in a Claude Code transcript, not from docs, so `name` is
// read when `skill` holds no name. One field names the skill: `skill` when it is a non-empty string, otherwise `name`,
// never both, so the verdict and the label read the same value. `args` or a nested field is never a skill name.
// Every row that prints or records Skill names reads them through skillLabel below, so the same field holds there.
// The printed line carries names only, because redaction cannot be shape-proof on a whole input.
const T2_SKILL = "quadron:quadron";
const isName = (v) => typeof v === "string" && v !== "";
const skillName = (input) => {
  if (!input || typeof input !== "object") return null;
  if (isName(input.skill)) return input.skill;
  return isName(input.name) ? input.name : null;
};
const namesT2Skill = (input) => skillName(input) === T2_SKILL;
// One Skill call's name for the printed line, from that same field. A model-influenced value is a label only: one
// line, nothing else in it. Redacted first and reduced from that, never from the raw value: reducing or cutting first
// can hide a secret from the patterns and the by-value mask. The angle brackets are kept for the masks redaction writes.
export function skillLabel(input, red) {
  const named = skillName(input);
  return named ? red.text(named).replace(/[^\w.:<>-]/g, "_").slice(0, 40) : "no skill name";
}

// T2: no connector, so no Quadron tool can be called and quad_context is zero by construction.
export function verdictT2([a]) {
  const f = [];
  if (a.init?.mcp_servers?.some((m) => m.name === "quadron")) f.push("a quadron server was configured");
  if (called(a, /quad_|future_you_capture|mcp__quadron__/) || captureAttempted(a)) f.push("a Quadron tool was called");
  if (!a.result) f.push("no result");
  else if (!success(a)) f.push(`result was ${a.result.subtype}`);
  else if (!answer(a).trim()) f.push("empty answer");
  // A denied or errored call does not count. A call with no result in the stream still does.
  if (!a.tool_uses.some((u) => u.name === "Skill" && !denied(a, u.id) && !resultOf(a, u.id)?.is_error)) f.push("the skill tool was not called, or was denied or errored");
  // Every Skill call is held to the name, denied or errored ones too.
  const skills = a.tool_uses.filter((u) => u.name === "Skill");
  const unnamed = skills.filter((u) => !namesT2Skill(u.input)).length;
  if (unnamed) f.push(`${unnamed} of ${skills.length} Skill calls do not name ${T2_SKILL} in input.skill, or else input.name`);
  return fin(f);
}

// ---- T4 observations from the raw capture result: never pass conditions

const parsedObjects = (r) => {
  const out = [];
  if (r?.structured && typeof r.structured === "object") out.push(r.structured);
  try { const j = JSON.parse(r?.text ?? ""); if (j && typeof j === "object") out.push(j); } catch { /* plain text */ }
  return out;
};
const walkKeys = (v, visit) => {
  if (Array.isArray(v)) { for (const x of v) walkKeys(x, visit); return; }
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { visit(k, x); walkKeys(x, visit); }
};

const SIGNED_KEY_RE = /signed|signature|^jws$/i;
// Whether a signed claim field appears; its value is never kept.
export function signedClaimField(r) {
  let field = null;
  for (const o of parsedObjects(r)) walkKeys(o, (k) => { if (!field && SIGNED_KEY_RE.test(k)) field = k; });
  if (!field) field = /\b([\w-]*(?:signed|signature)[\w-]*)["']?\s*[:=]/i.exec(r?.text ?? "")?.[1] ?? null;
  return field ? { state: "present", field } : { state: "absent" };
}

const ID_KEY_RE = /^judgment[_-]?id$/i;
const scalarId = (v) => ((typeof v === "string" && v) || typeof v === "number" ? String(v) : null);
// The judgment id from the capture result, or "not shown".
export function judgmentIdFrom(r) {
  for (const o of parsedObjects(r)) {
    let id = null;
    walkKeys(o, (k, v) => { if (!id && ID_KEY_RE.test(k)) id = scalarId(v); });
    if (id) return validId(id);
    const rootId = Array.isArray(o) ? null : scalarId(o.id);
    if (rootId) return validId(rootId);
  }
  return validId(/judgment[ _-]?id["'\s:=]+["']?([\w-]+)/i.exec(r?.text ?? "")?.[1] ?? NOT_SHOWN);
}
const validId = (id) => (JUDGMENT_ID_RE.test(id) ? id : NOT_SHOWN);

// The wording T4 saved, from the capture call's input, which is what goes to the server. A recorded
// T4 call put it in `decided`, next to capture_type, quad_name, origin and ruled_out (README, T4).
// The tool's schema is not in the types, so other names are tried, then any other string. It must
// hold the stated decision's phrase, or it is not shown and T6 refuses.
const WORDING_KEYS = ["decided", "text", "content", "judgment", "statement", "claim", "body", "note"];
const NOT_WORDING = new Set(["capture_type", "quad_name", "origin", "ruled_out"]);
export function savedWordingFrom(input) {
  if (!input || typeof input !== "object") return NOT_SHOWN;
  const strings = Object.entries(input).filter(([k, v]) => typeof v === "string" && !NOT_WORDING.has(k));
  const named = WORDING_KEYS.map((k) => strings.find(([n]) => n === k)).filter(Boolean);
  const hit = [...named, ...strings].find(([, v]) => hasPhrase(v, T4_OFFER_PHRASE));
  return hit ? hit[1].trim() : NOT_SHOWN;
}

// ---- T6: T4's wording, and the status of the record holding it

// Case, punctuation and spacing only: the app showed T4's saved text with a full stop the offer did
// not have (README, T4). Hyphens and all dashes read as spaces, so "recall-only" and "only—capture"
// match. The whole wording must appear, so a fragment never matches. `map` gives each normalised
// character's place in the raw text, so a window can be cut from the raw text.
function normalised(raw) {
  let text = "";
  const map = [];
  let at = 0;
  for (const ch of String(raw ?? "")) {
    if (/[\s\p{Pd}−]/u.test(ch)) { if (text && !text.endsWith(" ")) { text += " "; map.push(at); } }
    else if (/[\p{L}\p{N}]/u.test(ch)) { for (const c of ch.toLowerCase()) { text += c; map.push(at); } }
    at += ch.length;
  }
  return { text: text.trimEnd(), map };
}
const normalWording = (t) => normalised(t).text;
const holdsWording = (t, wording) => normalWording(t).includes(wording);

// HEURISTICS on wording no real T6 has shown yet: this verdict does not settle whether the record is
// confirmed, so read the evidence. It does not try to find where one
// record ends and the next begins. The first real T6 shows the wording, and these lists may need
// adjusting from that evidence. Matched on lower-case text with punctuation as spaces, so
// "Status: kept" and {"status":"kept"} read alike, except that a clause break stays as " . ", so
// "confirmed: no" is a value and "Confirmed. No further action." is not. Negative wins over positive.
// A positive marker reads as negative when qualified within a few words before it, or followed by a
// value of no, false, 0 or null; a false boolean reads as "<key> false", and "<key> null" is kept
// only for a key about confirmation, since rejected_at: null says nothing.
const NEGATED_POSITIVE_RE = /\b(?:not|never|until|once|unless|before|awaiting|pending|cannot|\p{L}+n t)(?: [\p{L}\p{N}]+){0,3} (?:confirmed|kept)\b/u;
const POSITIVE_THEN_NO_RE = /\b(?:confirmed(?: (?:at|on|by|date|time))?|kept as your own|status kept) (?:no|false|0|null)\b/;
const NOT_CONFIRMED_RES = [
  /(?<!\bnot )\bpending\b(?! (?:false|0|null)\b)/, /\bunconfirmed\b(?! (?:false|0|null)\b)/, /\b(?:not|not yet|to be) confirmed\b/,
  NEGATED_POSITIVE_RE, POSITIVE_THEN_NO_RE,
  /(?<!\bnot )\brejected\b(?! (?:false|0|null)\b)/, /\bnot your contribution\b/, /\bsaved for your review\b/,
];
const CONFIRMED_RES = [/(?<!\bnot )\bconfirmed\b(?! false)/, /\bkept as your own\b/, /\b(?:status|state) kept\b/];
// How far either side of the wording a plain text is read for its record's status.
export const STATUS_WINDOW_CHARS = 200;
export const T6_STATUS_NOTE = `T6 status check is a heuristic, so read the evidence: a status field on the object holding the wording decides where the result's structure shows one, otherwise the text within ${STATUS_WINDOW_CHARS} characters of the wording`;
const UNCONFIRMED_NOTE = "no status either way on the record holding T4's saved wording; the first real T6 shows the wording, and the marker list may need adjusting from that evidence";

const markerText = (t) => String(t).toLowerCase().replace(/[.,;!?|\r\n]+/g, " . ").replace(/[^\p{L}\p{N}.]+/gu, " ");

// The text either side of each place the wording appears, without the wording itself: its own words
// ("rejected", "confirmed") are not a status.
function aroundWording(raw, wording) {
  const { text, map } = normalised(raw);
  const out = [];
  for (let i = text.indexOf(wording); i !== -1; i = text.indexOf(wording, i + wording.length)) {
    const start = map[i], end = map[i + wording.length - 1] + 1;
    out.push(`${raw.slice(Math.max(0, start - STATUS_WINDOW_CHARS), start)} | ${raw.slice(end, end + STATUS_WINDOW_CHARS)}`);
  }
  return out;
}

const jsonIn = (t) => {
  if (!/^\s*[[{]/.test(t)) return null;
  try { return JSON.parse(t); } catch { return null; }
};
// JSON held inside a string, as a tool result's text block often is, read as structure.
const expanded = (v) => {
  if (typeof v === "string") { const j = jsonIn(v); return j === null ? v : expanded(j); }
  if (Array.isArray(v)) return v.map(expanded);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expanded(x)]));
  return v;
};
// A status field's name: status, state, confirmed and their like, on one object.
const STATUS_KEY_RE = /(?:status|state|confirm(?:ed|ation)|confirmed[_-]?at|pending|rejected)$/i;
const statusFields = (o) => Object.entries(o).filter(([k]) => STATUS_KEY_RE.test(k));
// What a field says, as text.
function itemText(v, wording, key = "") {
  if (typeof v === "string") return holdsWording(v, wording) ? aroundWording(v, wording).join(" | ") : `${key} ${v}`;
  if (Array.isArray(v)) return v.map((x) => itemText(x, wording, key)).join(" | ");
  if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => itemText(x, wording, k)).join(" | ");
  if (v === null) return /confirmed/i.test(key) ? `${key} null` : "";
  return v === undefined ? "" : `${key} ${v}`;
}

const windowsOf = (s, wording) => aroundWording(s, wording).map((text) => ({ source: "window", text }));

// The wording identifies the record, and the record's own status fields decide. The record is the
// object holding the wording, or the nearest object above it with a status field, going no higher
// than a list element: a sibling's field, or a list's envelope, says nothing about it. With no such
// field the string holding the wording is read by window, since one string can hold many records.
function structuredReadings(v, wording, chain, out) {
  if (typeof v === "string") {
    if (!holdsWording(v, wording)) return out;
    const owner = chain.find((o) => statusFields(o).length);
    if (owner) out.push(...statusFields(owner).map(([k, x]) => ({ source: "field", text: itemText(x, wording, k.replace(/([a-z])([A-Z])/g, "$1 $2")) })));
    else out.push(...windowsOf(v, wording));
  } else if (Array.isArray(v)) {
    for (const x of v) structuredReadings(x, wording, [], out);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) structuredReadings(x, wording, [v, ...chain], out);
  }
  return out;
}

// One read result's readings of the record holding the wording, {source, text}: none if it does not
// hold it. A status field, in the text block's JSON or the structured result, outranks any window.
function recordReadings(r, wording) {
  const out = [];
  const read = (v) => {
    const value = expanded(v);
    if (typeof value === "string") { if (holdsWording(value, wording)) out.push(...windowsOf(value, wording)); }
    else structuredReadings(value, wording, [], out);
  };
  read(r.text);
  if (r.structured !== undefined) read(r.structured);
  const fields = out.filter((x) => x.source === "field");
  return fields.length ? fields : out;
}

// "not confirmed" if any reading says so, "confirmed" if any other does, otherwise "none".
function statusOf(readings) {
  const texts = readings.map((x) => markerText(x.text));
  if (texts.some((t) => NOT_CONFIRMED_RES.some((re) => re.test(t)))) return "not confirmed";
  return texts.some((t) => CONFIRMED_RES.some((re) => re.test(t))) ? "confirmed" : "none";
}

function withheldCount(results) {
  const counts = results.map((r) => /WITHHELD \(IP firewall\):\s*(\d+)|IP firewall: \((\d+) withheld/.exec(r.text)).map((m) => (m ? Number(m[1] ?? m[2]) : null));
  return counts.includes(null) ? "not shown" : counts.reduce((a, n) => a + n, 0);
}

export function routingOf(r) {
  const t = `${r?.text ?? ""} ${r?.structured === undefined ? "" : JSON.stringify(r.structured)}`;
  if (/unrouted|not routed|no project/i.test(t)) return "unrouted";
  return t.includes(PROJECT) ? "routed" : NOT_SHOWN;
}

// A capture reply that reports a failed write, which a reply can do with is_error unset. Three forms
// count: the phrase below, anywhere in the text; a top-level `ok` of false in the structured result;
// and the same in the text, when the whole text is a JSON object. An `ok` further down belongs to
// something else, and text that is not JSON as a whole is never searched for one.
const FAILED_WRITE_PHRASE_RE = /may or may not be in the record/i;
const okFalse = (v) => {
  const o = expanded(v);
  return Boolean(o) && typeof o === "object" && !Array.isArray(o) && o.ok === false;
};
export function reportsFailedWrite(r) {
  if (!r) return false;
  if (okFalse(r.structured)) return true;
  const text = String(r.text ?? "");
  if (FAILED_WRITE_PHRASE_RE.test(text)) return true;
  return okFalse(jsonIn(text.trim()));
}
const writeAccepted = (s, id) => {
  const r = resultOf(s, id);
  return Boolean(r) && !r.is_error && !denied(s, id) && !reportsFailedWrite(r);
};

// T4: turn 1 offers and does not capture; turn 2 makes exactly one accepted capture.
export function verdictT4([a, b]) {
  const f = [];
  const tool = pickCaptureTool(a.init?.tools);
  const gate = turnGate("T4", a);
  if (gate) f.push(gate);
  const empty = { tool_uses: [], tool_results: [], denied_captures: [] };
  const two = b ?? empty;
  const caps = two.tool_uses.filter((u) => CAPTURE_RE.test(u.name));
  const other = caps.filter((u) => u.name !== tool);
  if (other.length) f.push(`turn 2 attempted another capture tool: ${other.map((u) => u.name).join(", ")}`);
  const mine = caps.filter((u) => u.name === tool);
  const accepted = mine.filter((u) => writeAccepted(two, u.id));
  if (mine.length !== 1 || accepted.length !== 1) f.push(`turn 2 ${tool} calls: ${mine.length}, accepted: ${accepted.length} (expected 1 and 1)`);
  if (mine.some((u) => reportsFailedWrite(resultOf(two, u.id)))) f.push(`turn 2 ${tool} reply reports a failed write (ok:false, or "may or may not be in the record")`);
  if (b && !success(b)) f.push(`turn 2 result was ${b.result?.subtype ?? "none"}`);
  const u = mine[0];
  const quadName = u?.input?.quad_name;
  if (u && quadName !== PROJECT) f.push(`turn 2 quad_name is ${JSON.stringify(quadName)}`);
  f.push(...contextFails(b ? [a, b] : [a]));
  // What was saved is read from an accepted write alone: a failed one saved nothing we can name.
  const r = u && writeAccepted(two, u.id) ? resultOf(two, u.id) : null;
  const notes = [`capture tool: ${tool}`];
  if (REVIEW_PENDING_RE.test(r?.text ?? "")) notes.push("capture pending review in the app");
  const out = fin(f, {
    captureTool: tool, quadName: quadName ?? NOT_SHOWN,
    signedClaim: signedClaimField(r), judgmentId: judgmentIdFrom(r), routing: routingOf(r),
    savedWording: savedWordingFrom(r ? u.input : undefined),
  });
  out.notes.push(...notes, OFFER_HEURISTIC_NOTE);
  if (out.judgmentId === NOT_SHOWN) out.notes.push("judgment id: not shown");
  return out;
}

// T5: assistant-written text is never offered for capture or captured. After a pass, review the wording.
export function verdictT5([a, b]) {
  const f = [];
  for (const [i, s] of [a, b].entries()) {
    if (!s) { f.push(`turn ${i + 1} did not run`); continue; }
    if (captureAttempted(s)) f.push(`turn ${i + 1} called a capture tool`);
    if (!success(s)) f.push(`turn ${i + 1} result was ${s.result?.subtype ?? "none"}`);
  }
  f.push(...contextFails([a, b].filter(Boolean)));
  if (f.length) return { verdict: "FAIL", notes: f };
  const flags = [];
  if (/\b(save|capture|record)\b/i.test(answer(a))) flags.push("turn 1 may offer capture: review");
  return { verdict: "PASS-MECHANICAL", review: true, notes: flags };
}

// T6: a read tool's result holding T4's saved wording, as recorded in T4's ledger entry, the same
// record reading as confirmed, and an answer citing the project. Neither a read call, a citation nor
// the ledger record can pass alone. A record with no status either way is UNCONFIRMED: not a pass,
// exit 1, no Haiku finding. WITHHELD counts only in a read tool's result, and only when no read holds
// the wording; one that does is judged on its record, with the withheld count noted. With
// --routing-blocked a missing citation is recorded, never a failure; a missing wording is always a
// failure.
export function verdictT6([a], { routingBlocked = null, judgmentId = null, savedWording = null } = {}) {
  const extra = { judgmentId };
  const f = [];
  if (captureAttempted(a)) f.push("a capture tool was called (no write allowed)");
  f.push(...contextFails([a]));
  const reads = a.tool_uses.filter((u) => READ_TOOL_RE.test(u.name));
  const readResults = reads.map((u) => resultOf(a, u.id)).filter(Boolean);
  const wording = normalWording(savedWording);
  const hasWording = Boolean(wording) && wording !== NOT_SHOWN;
  const readings = hasWording ? readResults.filter((r) => !r.is_error).flatMap((r) => recordReadings(r, wording)) : [];
  const withheld = readResults.filter((r) => WITHHELD_RE.test(r.text));
  if (!f.length && withheld.length && !readings.length) {
    return { verdict: "WITHHELD", notes: ["a read tool's result says WITHHELD"], ...extra };
  }
  if (!a.result) f.push("no result");
  else if (!success(a)) f.push(`result was ${a.result.subtype}`);
  const status = readings.length ? statusOf(readings) : null;
  if (!reads.length) f.push("no read tool call");
  else if (!hasWording) f.push("no saved wording from T4 to compare");
  else if (!readings.length) f.push("no read tool result holds T4's saved wording");
  else if (status === "not confirmed") f.push("the record holding T4's saved wording reads as not confirmed (pending, unconfirmed, rejected, not your contribution, saved for review, or a positive marker that is negated or qualified)");
  const cites = answer(a).includes(PROJECT);
  const notes = [];
  if (status) notes.push(T6_STATUS_NOTE);
  if (readings.length && withheld.length) notes.push(`a read tool's result also reports withheld items: ${withheldCount(withheld)}`);
  const blocked = !cites && routingBlocked;
  if (blocked) {
    extra.citesProject = { state: "BLOCKED-BY-BACKEND", reason: routingBlocked };
    notes.push(`cites the project: BLOCKED-BY-BACKEND (${routingBlocked})`);
  } else if (!cites) f.push(`answer does not cite "${PROJECT}"`);
  if (!f.length && status === "none") return { verdict: "UNCONFIRMED", notes: [UNCONFIRMED_NOTE, ...notes], ...extra };
  if (!f.length && blocked) return { verdict: "BLOCKED-BY-BACKEND", notes, ...extra };
  return { ...fin(f, extra), notes: [...f, ...notes] };
}

// Issue-2 check: an offer with the note's phrase first, no write; hitting the turn cap is itself a failure.
export function verdictIssue2([a]) {
  const f = [];
  if (capped(a)) f.push("turn cap reached before an offer");
  else if (!success(a)) f.push(`result was ${a.result?.subtype ?? "none"}`);
  if (captureAttempted(a)) f.push("a capture tool was called (no write allowed)");
  if (!capped(a) && !isOffer(a.assistant_text, ISSUE2_OFFER_PHRASE, ROWS.ISSUE2.turns[0].prompt)) f.push(`no offer with the note's phrase ("${ISSUE2_OFFER_PHRASE}")`);
  f.push(...contextFails([a]));
  const out = fin(f);
  out.notes.push(OFFER_HEURISTIC_NOTE);
  return out;
}

// What an offer row's one turn shows. `fault` says why it holds no offer naming the project, or is null.
function offerFacts(a, row) {
  const { offerPhrase, turns } = ROWS[row];
  const offer = readOffer(a.assistant_text, offerPhrase, turns[0].prompt);
  const fault = !offer.offered ? `no offer with the stated phrase ("${offerPhrase}")` : offer.named ? null : `the offer ${NOT_NAMED}`;
  return { fault, captured: captureAttempted(a), kept: offer.sentence ? { offerSentence: offer.sentence } : {} };
}

// T4's first turn alone: an offer naming the project, and nothing written. Whether the skill was
// called is a record, not a condition: the check is about the offer, not how it came about.
export const verdictOfferRow = (row) => ([a]) => {
  const { fault, captured, kept } = offerFacts(a, row);
  const f = [];
  if (!success(a)) f.push(`result was ${a.result?.subtype ?? "none"}`);
  if (captured) f.push("a capture tool was called (no write allowed)");
  if (fault) f.push(fault);
  f.push(...contextFails([a]));
  const out = fin(f, kept);
  out.notes.push(`Skill called: ${called(a, /^Skill$/) ? "yes" : "no"}`, OFFER_HEURISTIC_NOTE);
  return out;
};

// ROUTE-1: asked to save with no Quadron or project cue, the save goes to the session's capture tool
// (pickCaptureTool on this turn's init) exactly once, accepted, and nowhere else. A call to a built-in
// file tool fails the row whether or not it was denied, and so does any file in the new working
// directory afterwards (`filesWritten`, from live.mjs), and so does any change to auto memory or a
// CLAUDE.md in the isolated config or home directory (`memoryChanges`, labelled paths from live.mjs, for
// an `autoMemory` row). The notes always say which route the save took,
// so a failure names the wrong one. Which project the capture names is recorded, not judged: the
// prompt names none, and the skill says never to guess one.
export const WRONG_ROUTE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
const SAVE_CLAIM_RE = /\b(saved|filed|stored|kept|noted|remembered)\b/i;
const targetOf = (input) => {
  const p = input?.file_path ?? input?.notebook_path ?? input?.path;
  return typeof p === "string" && p ? p : "no path";
};
export function verdictRoute1([a], { filesWritten = [], memoryChanges = [] } = {}) {
  const f = [];
  const tool = pickCaptureTool(a.init?.tools);
  const wrong = a.tool_uses.filter((u) => WRONG_ROUTE_TOOLS.includes(u.name));
  const routes = wrong.map((u) => `${u.name} ${targetOf(u.input)}${denied(a, u.id) ? " (denied)" : ""}`);
  if (wrong.length) f.push(`wrong save route: ${routes.join("; ")}`);
  if (filesWritten.length) f.push(`files written in the working directory: ${filesWritten.join(", ")}`);
  if (memoryChanges.length) f.push(`auto memory or CLAUDE.md changed: ${memoryChanges.join(", ")}`);
  const caps = a.tool_uses.filter((u) => CAPTURE_RE.test(u.name));
  const other = caps.filter((u) => u.name !== tool);
  if (other.length) f.push(`another capture tool was called: ${other.map((u) => u.name).join(", ")}`);
  const mine = caps.filter((u) => u.name === tool);
  const accepted = mine.filter((u) => writeAccepted(a, u.id));
  if (!mine.length) f.push(`no ${tool} call`);
  else if (mine.length !== 1 || accepted.length !== 1) f.push(`${tool} calls: ${mine.length}, accepted: ${accepted.length} (expected 1 and 1)`);
  if (mine.some((u) => reportsFailedWrite(resultOf(a, u.id)))) f.push(`${tool} reply reports a failed write (ok:false, or "may or may not be in the record")`);
  if (!a.result) f.push("no result");
  else if (!success(a)) f.push(`result was ${a.result.subtype}`);
  f.push(...contextFails([a]));
  const via = [
    ...accepted.map((u) => u.name),
    ...mine.filter((u) => !accepted.includes(u)).map((u) => `${u.name} (not accepted)`),
    ...other.map((u) => `${u.name} (other capture tool)`),
    ...routes, ...filesWritten.map((p) => `file ${p}`), ...memoryChanges.map((p) => `memory ${p}`),
  ];
  const notes = [`capture tool: ${tool}`, `save route: ${via.length ? via.join("; ") : "none"}`];
  if (accepted.length) notes.push(`quad_name: ${typeof accepted[0].input?.quad_name === "string" ? accepted[0].input.quad_name : "not sent"}`);
  if (!accepted.length) notes.push(`answer claims a save: ${SAVE_CLAIM_RE.test(`${a.assistant_text}\n${answer(a)}`) ? "yes" : "no"} (a word match, read the evidence)`);
  const out = fin(f);
  out.notes.push(...notes);
  return out;
}

// Never a pass and never a product failure, whichever way the turn went.
export const DIAGNOSTIC = "DIAGNOSTIC";
export const verdictDiagnosticOffer = (row) => ([a]) => {
  const { fault, captured, kept } = offerFacts(a, row);
  const reason = captured ? "a capture tool was called" : fault;
  const notes = [`offered first: ${reason ? `no (${reason})` : "yes"}`, `capture attempted: ${captured ? "yes" : "no"}`];
  if (!success(a)) notes.push(`result was ${a.result?.subtype ?? "none"}`);
  notes.push(...contextFails([a]), OFFER_HEURISTIC_NOTE);
  return { verdict: DIAGNOSTIC, notes, ...kept };
};

export const VERDICTS = {
  T2: verdictT2, T4: verdictT4, T5: verdictT5, T6: verdictT6, ISSUE2: verdictIssue2,
  "T4O-S": verdictOfferRow("T4O-S"), "T4O-N": verdictOfferRow("T4O-N"), "T4O-C": verdictDiagnosticOffer("T4O-C"),
  "ROUTE-1": verdictRoute1,
};
