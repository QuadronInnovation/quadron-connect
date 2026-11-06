// Library entry. `main` takes injected dependencies so tests drive it with a fake client.
//
// Dry is the default. The live path runs only with an explicit --live. The dry path never loads
// lib/sdk.mjs, never reads the key or connector variables, replaces globalThis.fetch with a
// function that throws, and spawns nothing. The SDK is loaded by the one dynamic import below,
// inside the live branch.
//
// Exit codes: 0 success; 1 row failures; 2 refusal; 3 init timeout or run stopped; 4 auth failure;
// 5 an init-only gate failure other than a timeout; 6 BLOCKED-BY-BACKEND (T6 only, not a pass).
//
// Runs come from a clone that must stay clean, so --out, the ledger and its lock, the campaign
// record and its lock, the findings, the temporary home and the config directory must all resolve
// outside it. The clone root is taken from this file's own location.

import * as nodefs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

import {
  EXIT, Refusal, KEY_VAR, assertOutsideClone, checkAuthEnv, refusePrintMode, checkFastModeSettings, checkSettingsDenyOnly,
  checkSettingsDeny, checkBrowserLibraries, checkBrowserArgsEnv, checkInstalledSdk, loadOverride, checkConfigDir, isLoopbackUrl,
} from "./guards.mjs";
import { AuthError } from "./connector.mjs";
import { Redactor } from "./redact.mjs";
import { ROWS, ROW_NAMES, T3_CHECK } from "./rows.mjs";
import { CAMPAIGN_CEILING_USD, MAX_OUTPUT_TOKENS, assertKnownModel, modelFamily, worstCase } from "./spend.mjs";
import { campaignFromEnv } from "./campaign.mjs";
import { checkSessionOptions, liveInitOnly, liveInitWithTurn, liveRow, markJudgmentConfirmed } from "./live.mjs";

const VALUE_FLAGS = ["model", "effort", "max-session-usd", "max-run-usd", "max-total-usd", "max-output-tokens", "expected-account", "account-label",
  "ledger", "row", "settings", "plugin-dir", "mcp-url", "config-dir", "out", "override", "row-timeout-seconds",
  "routing-blocked", "mark-judgment-confirmed", "auto-memory-settings"];
const BOOL_FLAGS = ["live", "dry-run", "init-only", "expect-no-key", "init-only-with-turn"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]; // sdk.d.ts:1974
const JOURNEY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const USAGE = `Dry by default (no calls). Live only with --live.
Run flags (all required unless --dry-run): --model <id> --effort <low|medium|high|xhigh|max>
  --max-session-usd <n> --max-run-usd <n> --expected-account <text>
  --ledger <path> --row <T2|T4|T5|T6|ISSUE2|T4O-S|T4O-N|T4O-C|ROUTE-1>   (one row per command; a retry names one row)
Live also needs: --settings <file> --plugin-dir <dir> (not T4O-C) --config-dir <empty dir> --out <dir> [--mcp-url <url>]
  [--account-label <text>] [--row-timeout-seconds <n>] [--routing-blocked <reason>] [--override <file>]
  --auto-memory-settings <file> (ROUTE-1 only, and required there: its own settings, deny rules plus autoMemoryEnabled: true)
  [--max-total-usd <n>] (lowers ${CAMPAIGN_CEILING_USD} USD, never raises it) [--max-output-tokens <n>] (lowers ${MAX_OUTPUT_TOKENS}, never raises it)
Live also needs, from the environment only: QUADRON_CAMPAIGN_RECORD (an existing file outside the clone; empty is a total of zero),
  QUADRON_CAMPAIGN_WORKSPACE, QUADRON_CAMPAIGN_ID.
Other: --dry-run; --init-only [--expect-no-key] [--init-only-with-turn]; --mark-judgment-confirmed <id> --ledger <path>
--ledger, --out and --config-dir must be outside the clone.
Exit: 0 success; 1 row failures; 2 refusal; 3 init timeout or run stopped; 4 auth failure; 5 init-only gate failure; 6 BLOCKED-BY-BACKEND.`;

export function parseFlags(argv) {
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Refusal(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (BOOL_FLAGS.includes(k)) f[k] = true;
    else if (VALUE_FLAGS.includes(k)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Refusal(`--${k} needs a value`);
      f[k] = argv[++i];
    } else throw new Refusal(`unknown flag --${k}`); // a misspelt flag never reaches live
  }
  return f;
}

const num = (v) => (v !== undefined && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0 ? Number(v) : null);

function validateRow(row) {
  if (!ROW_NAMES.includes(row)) throw new Refusal(`unknown row ${row} (one of ${ROW_NAMES.join(", ")}); a single row per command`);
}

// The constants are the source of truth: these flags can lower them and nothing can raise them.
function checkLoweringFlags(f) {
  if (f["max-total-usd"] !== undefined) {
    const v = num(f["max-total-usd"]);
    if (v === null) throw new Refusal("--max-total-usd must be a positive number");
    if (v > CAMPAIGN_CEILING_USD) throw new Refusal(`--max-total-usd ${v} is above the campaign ceiling of ${CAMPAIGN_CEILING_USD} USD; a flag can only lower it`);
  }
  if (f["max-output-tokens"] !== undefined) {
    const v = f["max-output-tokens"];
    if (!/^\d+$/.test(v) || Number(v) < 1) throw new Refusal("--max-output-tokens must be a positive whole number");
    if (Number(v) > MAX_OUTPUT_TOKENS) throw new Refusal(`--max-output-tokens ${v} is above the limit of ${MAX_OUTPUT_TOKENS}; a flag can only lower it`);
  }
}

function requireRunFlags(f) {
  const missing = [];
  if (!f.model) missing.push("--model");
  if (!EFFORTS.includes(f.effort)) missing.push("--effort (low|medium|high|xhigh|max)");
  for (const k of ["max-session-usd", "max-run-usd"]) if (num(f[k]) === null) missing.push(`--${k} (positive number)`);
  if (!f["expected-account"]) missing.push("--expected-account");
  if (!f.ledger) missing.push("--ledger");
  if (!f.row) missing.push("--row");
  if (missing.length) throw new Refusal(`missing or invalid required flags: ${missing.join(", ")}`);
  validateRow(f.row);
}

// ----------------------------------------------------------------------------- dry path

function dryReport(f, io, explicit, red) {
  const set = (k) => f[k] ?? "not set";
  const out = (l) => io.out(red.text(l));
  out("DRY RUN: no calls made, no network, nothing spawned.");
  out(`model: ${set("model")}; effort: ${set("effort")}`);
  out(`ceilings (USD): session ${set("max-session-usd")}, run ${set("max-run-usd")}, total ${set("max-total-usd")}; ledger: ${set("ledger")}; expected account: ${set("expected-account")}`);
  out(`campaign ceiling (USD): ${CAMPAIGN_CEILING_USD}; output limit: ${f["max-output-tokens"] ?? MAX_OUTPUT_TOKENS} tokens; a live run also needs a campaign record, which a dry run does not touch`);
  if (modelFamily(f.model) && num(f["max-session-usd"]) !== null) {
    const w = worstCase({ model: f.model, sessionUsd: num(f["max-session-usd"]), maxOutputTokens: f["max-output-tokens"] ? Number(f["max-output-tokens"]) : MAX_OUTPUT_TOKENS });
    out(`one call's worst case (USD): ${w.reservationUsd.toFixed(5)} (session ${w.sessionUsd} + one more response ${w.responseUsd.toFixed(5)})`);
  }
  out("mode: not bare");
  const rows = f.row ? [f.row] : ROW_NAMES;
  for (const r of rows) {
    const d = ROWS[r];
    if (d.noSession) { out(`would run ${r}: no session; this row is the unit check in ${T3_CHECK}`); continue; }
    const caps = d.turns.map((t) => t.maxTurns).join("/");
    const offer = d.offerPhrase ? `; offer phrase "${d.offerPhrase}"` : "";
    const surface = d.noPlugin ? "; connector only, no plugin or skill" : "";
    const reading = d.diagnostic ? "; diagnostic: never a pass, exit 0 whichever way the turn goes" : "";
    const shown = d.observeWrites ? "; Write and Edit shown and never allowed, so a save to a file is seen and denied" : "";
    const memory = d.autoMemory ? "; auto memory on, from --auto-memory-settings, with the memory directory and CLAUDE.md watched" : "";
    out(`would run ${r}: ${d.turns.length} turn(s), caps ${caps}, one command and one session${offer}${surface}${reading}${shown}${memory}`);
  }
  out(explicit ? "dry run (explicit)" : "dry run (default: pass --live to run for real)");
}

async function runDry(f, env, io, fetchHolder, explicit, red, repoRoot) {
  if (f.row) validateRow(f.row);
  checkLoweringFlags(f);
  if (explicit) {
    // The only environment variable the dry path reads is the base URL, to prove it points nowhere real.
    if (!env.ANTHROPIC_BASE_URL || !isLoopbackUrl(env.ANTHROPIC_BASE_URL)) {
      throw new Refusal("--dry-run requires ANTHROPIC_BASE_URL set to a loopback address");
    }
  } else {
    requireRunFlags(f);
  }
  // By path text only: the dry path touches no file. It writes nothing either way.
  assertOutsideClone({ "--out": f.out, "--ledger": f.ledger, "--config-dir": f["config-dir"] }, repoRoot);
  const saved = fetchHolder.fetch;
  fetchHolder.fetch = () => { throw new Error("dry run: network is disabled"); };
  try {
    dryReport(f, io, explicit, red);
  } finally {
    fetchHolder.fetch = saved;
  }
  return { exitCode: EXIT.OK, dry: true };
}

// ----------------------------------------------------------------------------- main

export async function main({
  argv, env = {}, client, loadSdk, fetch: fetchImpl, fs = nodefs, now = () => Date.now(),
  resolve, io = { out: (l) => console.log(l), err: (l) => console.error(l) }, fetchHolder = globalThis,
  repoRoot = path.resolve(JOURNEY_DIR, "..", ".."), journeyDir = JOURNEY_DIR, tmpRoot = tmpdir(),
  home, timeoutMs, testOptionsHook,
} = {}) {
  const red = new Redactor({ home: home ?? homedir(), repoRoot });
  try {
    refusePrintMode(argv);
    const f = parseFlags(argv);
    if (f["mark-judgment-confirmed"] !== undefined) return markForm({ f, env, fs, io, repoRoot, now });
    if (f.live && f["dry-run"]) throw new Refusal("--live and --dry-run together");
    if (f.live && env.QUADRON_HARNESS_DRY === "1") throw new Refusal("QUADRON_HARNESS_DRY=1 refuses --live");
    if (!f.live) return await runDry(f, env, io, fetchHolder, Boolean(f["dry-run"]), red, repoRoot);
    return await runLive({ f, argv, env, client, loadSdk, fetchImpl, fs, now, resolve, io, repoRoot, journeyDir, tmpRoot, red, timeoutMs, testOptionsHook });
  } catch (e) {
    const code = e instanceof Refusal || e instanceof AuthError ? e.code : EXIT.REFUSAL;
    io.err(`refused: ${red.text(e?.message ?? e)}`);
    return { exitCode: code, refused: true };
  }
}

// The one form that needs no --live: it writes one record to the ledger, and calls no model and no
// network. Exactly two flags. The only environment variable it reads is QUADRON_HARNESS_DRY: no
// key, no campaign variable, no URL.
function markForm({ f, env, fs, io, repoRoot, now }) {
  const extra = Object.keys(f).filter((k) => k !== "mark-judgment-confirmed" && k !== "ledger");
  if (extra.length) throw new Refusal("--mark-judgment-confirmed takes only --ledger");
  if (!f.ledger) throw new Refusal("--mark-judgment-confirmed needs --ledger");
  if (env.QUADRON_HARNESS_DRY === "1") throw new Refusal("QUADRON_HARNESS_DRY=1 refuses --mark-judgment-confirmed");
  assertOutsideClone({ "--ledger": f.ledger, "the ledger lock": `${f.ledger}.lock` }, repoRoot, fs);
  return markJudgmentConfirmed({ f, fs, io, repoRoot, now });
}

// ----------------------------------------------------------------------------- live path

async function runLive(ctx) {
  const { f, argv, env, fs, repoRoot, red } = ctx;
  const initMode = Boolean(f["init-only"]);
  const withTurn = Boolean(f["init-only-with-turn"]);
  if (f["expect-no-key"] && !initMode) throw new Refusal("--expect-no-key applies to --init-only only");
  if (withTurn && !initMode) throw new Refusal("--init-only-with-turn needs --init-only");
  if (withTurn && f["expect-no-key"]) throw new Refusal("--expect-no-key cannot be combined with a prompt path");
  checkLoweringFlags(f);
  if (withTurn) {
    const missing = [];
    if (!f.model) missing.push("--model");
    if (!f.ledger) missing.push("--ledger");
    for (const k of ["max-session-usd", "max-run-usd"]) if (num(f[k]) === null) missing.push(`--${k} (positive number)`);
    if (missing.length) throw new Refusal(`--init-only-with-turn needs: ${missing.join(", ")}`);
    if (f.effort !== undefined && !EFFORTS.includes(f.effort)) throw new Refusal("--effort must be low, medium, high, xhigh or max");
  }
  if (!initMode) requireRunFlags(f);
  if (f.model !== undefined) assertKnownModel(f.model);
  // A row was validated above when one runs. An init form asks for the plugin whatever --row says.
  const needsPlugin = initMode || !ROWS[f.row].noPlugin;
  for (const k of ["settings", ...(needsPlugin ? ["plugin-dir"] : []), "config-dir"]) if (!f[k]) throw new Refusal(`--${k} is required for a live run`);
  if (!initMode && !f.out) throw new Refusal("--out is required for a live run");

  // Environment only, never a flag. Every live form needs it; only the forms that send a prompt charge it.
  const campaign = campaignFromEnv(env, repoRoot, fs);

  // Nothing is written until these have passed.
  assertOutsideClone({
    "--out": f.out, "--ledger": f.ledger, "the ledger lock": f.ledger ? `${f.ledger}.lock` : undefined,
    "the findings log": f.out ? path.join(f.out, "findings.jsonl") : undefined, "--config-dir": f["config-dir"],
    "TEMP": env.TEMP, "TMP": env.TMP, "TMPDIR": env.TMPDIR,
  }, repoRoot, fs);

  checkAuthEnv(env, { expectNoKey: Boolean(f["expect-no-key"]) });
  if (env[KEY_VAR]) red.add(env[KEY_VAR]);
  checkBrowserArgsEnv(argv, env);
  checkBrowserLibraries(ctx.resolve ?? createRequire(import.meta.url).resolve);
  checkInstalledSdk(ctx.journeyDir, fs);

  let override = null;
  if (f.override) {
    let raw;
    try { raw = fs.readFileSync(f.override, "utf8"); } catch { throw new Refusal("override file unreadable"); }
    override = loadOverride(raw, ctx.now());
  }
  const lifts = override?.lifts ?? [];

  let settings;
  try { settings = JSON.parse(fs.readFileSync(f.settings, "utf8")); } catch { throw new Refusal("settings file missing or not valid JSON"); }
  checkSettingsDeny(settings, lifts);
  checkFastModeSettings(settings);
  checkSettingsDenyOnly(settings);
  // An `autoMemory` row runs on its own settings file and no other row may name one. Same checks as
  // --settings, plus autoMemoryEnabled: true.
  const autoMemoryRow = !initMode && ROWS[f.row].autoMemory === true;
  if (f["auto-memory-settings"] !== undefined && !autoMemoryRow) throw new Refusal("--auto-memory-settings applies to an auto-memory row only (ROUTE-1)");
  if (autoMemoryRow) {
    if (!f["auto-memory-settings"]) throw new Refusal(`--auto-memory-settings is required for ${f.row}: it runs on its own settings file with auto memory on`);
    let own;
    try { own = JSON.parse(fs.readFileSync(f["auto-memory-settings"], "utf8")); } catch { throw new Refusal("auto-memory settings file missing or not valid JSON"); }
    checkSettingsDeny(own, lifts);
    checkFastModeSettings(own);
    checkSettingsDenyOnly(own, { autoMemory: true });
  }
  checkConfigDir(f["config-dir"], fs);
  checkSessionOptions(ctx);

  // The one dynamic import of the SDK loader: live branch only, and after every refusal above.
  const getClient = async () => ctx.client ?? (await (ctx.loadSdk ?? (() => import("./sdk.mjs")))()).createClient();
  const live = { ...ctx, getClient, settings, override, lifts, campaign };

  if (withTurn) return await liveInitWithTurn(live);
  if (initMode) return await liveInitOnly(live);
  return await liveRow(live);
}
