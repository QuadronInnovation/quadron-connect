// The campaign spend record: an append-only JSON-lines file that outlives any ledger. Its path,
// workspace label and campaign id come only from the environment the launcher sets, never from a
// flag, so an agent starting a run cannot choose a fresh one. The file must already exist; the
// harness never creates it. An empty file is a total of zero. Dry never touches it, and neither
// does the confirmation record.
//
// Line kinds, each with {workspace, campaign, at}:
//   reserve: {type, call, row, turn, model, head, reservationUsd, sessionUsd, responseUsd,
//             contextTokens, contextSource, maxOutputTokens}
//   settle:  {type, call, actualUsd: number|null, chargedUsd, note?}
//   limit:   {type, maxTotalUsd}
// A reservation with no settle line stays charged at its reservation: that is what a kill mid-call
// leaves behind. A settle line with no reported cost carries actualUsd null and the reservation as
// its charge.
//
// A guard with detection, not a security boundary: anyone running as the same OS user can edit it.

import path from "node:path";
import { EXIT, Refusal, assertOutsideClone } from "./guards.mjs";

export const CAMPAIGN_VARS = ["QUADRON_CAMPAIGN_RECORD", "QUADRON_CAMPAIGN_WORKSPACE", "QUADRON_CAMPAIGN_ID"];
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const finite = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const corrupt = (why) => new Refusal(`the campaign record is corrupt (${why})`);

// Environment only. Refuses when any variable is absent, the path is relative or inside the clone,
// or the file is missing, unreadable or corrupt.
export function campaignFromEnv(env, repoRoot, fs) {
  const missing = CAMPAIGN_VARS.filter((v) => !env[v]);
  if (missing.length) throw new Refusal(`a live run needs the launcher's campaign variables: ${missing.join(", ")}`);
  const [file, workspace, id] = CAMPAIGN_VARS.map((v) => env[v]);
  if (!path.isAbsolute(file)) throw new Refusal("QUADRON_CAMPAIGN_RECORD must be an absolute path");
  if (!LABEL_RE.test(workspace)) throw new Refusal("QUADRON_CAMPAIGN_WORKSPACE has characters outside the allowed pattern");
  if (!LABEL_RE.test(id)) throw new Refusal("QUADRON_CAMPAIGN_ID has characters outside the allowed pattern");
  assertOutsideClone({ "the campaign record": file, "the campaign record lock": `${file}.lock` }, repoRoot, fs);
  const campaign = { file, workspace, id };
  readRecord(campaign, fs);
  return campaign;
}

// Validates every line of the file and returns this workspace and campaign's calls and limit.
export function readRecord(campaign, fs) {
  let raw;
  try { raw = fs.readFileSync(campaign.file, "utf8"); } catch { throw new Refusal("the campaign record is missing or unreadable"); }
  const seen = new Map(); // workspace, campaign and call -> its reservation, settled or not
  const calls = [];
  let limit = null;
  for (const text of raw.replace(/^﻿/, "").split(/\r?\n/)) {
    if (!text.trim()) continue;
    let l;
    try { l = JSON.parse(text); } catch { throw corrupt("a line is not JSON"); }
    if (!l || typeof l !== "object" || typeof l.workspace !== "string" || typeof l.campaign !== "string") throw corrupt("a line has no key");
    const mine = l.workspace === campaign.workspace && l.campaign === campaign.id;
    const key = JSON.stringify([l.workspace, l.campaign, l.call]);
    if (l.type === "reserve") {
      if (typeof l.call !== "string" || !l.call || typeof l.model !== "string" || !finite(l.reservationUsd)) throw corrupt("a bad reservation");
      if (seen.has(key)) throw corrupt("a call reserved twice");
      const call = { id: l.call, row: l.row, turn: l.turn, head: l.head, model: l.model, reservationUsd: l.reservationUsd, chargedUsd: l.reservationUsd, actualUsd: null, settled: false };
      seen.set(key, call);
      if (mine) calls.push(call);
    } else if (l.type === "settle") {
      const call = seen.get(key);
      if (!call) throw corrupt("a settlement with no reservation");
      if (call.settled) throw corrupt("a call settled twice");
      if (!finite(l.chargedUsd) || !(l.actualUsd === null || finite(l.actualUsd))) throw corrupt("a bad settlement");
      if (l.actualUsd === null && l.chargedUsd !== call.reservationUsd) throw corrupt("an unreported cost charged below its reservation");
      call.settled = true;
      call.actualUsd = l.actualUsd;
      call.chargedUsd = l.chargedUsd;
    } else if (l.type === "limit") {
      if (!finite(l.maxTotalUsd) || l.maxTotalUsd === 0) throw corrupt("a bad limit");
      if (mine) limit = limit === null ? l.maxTotalUsd : Math.min(limit, l.maxTotalUsd);
    } else {
      throw corrupt("an unknown line type");
    }
  }
  return { calls, limit };
}

export const recordTotal = (state) => state.calls.reduce((a, c) => a + c.chargedUsd, 0);
export const recordModelTotal = (state, model) => state.calls.filter((c) => c.model === model).reduce((a, c) => a + c.chargedUsd, 0);

// Opens without a create flag, so a record that has gone missing stays missing and stops the run.
function appendLine(campaign, fs, fields) {
  const line = `${JSON.stringify({ workspace: campaign.workspace, campaign: campaign.id, ...fields })}\n`;
  let fd;
  try {
    fd = fs.openSync(campaign.file, fs.constants.O_WRONLY | fs.constants.O_APPEND);
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } catch {
    throw new Refusal("the campaign record could not be written; the run stops", EXIT.STOPPED);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* the write already settled it */ } }
  }
}

export const appendReservation = (campaign, fs, fields) => appendLine(campaign, fs, { type: "reserve", ...fields });
export const appendSettlement = (campaign, fs, fields) => appendLine(campaign, fs, { type: "settle", ...fields });
export const appendLimit = (campaign, fs, fields) => appendLine(campaign, fs, { type: "limit", ...fields });
