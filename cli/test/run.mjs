// quadron-connect — the properties that matter if this ships to other people's machines.
//
// Two things here can do real harm: the settings merger writes into a file the person owns and
// other tools also register hooks in, and the Stop detector decides what gets written to someone's
// permanent record. Both are tested against the cases that would hurt, not the happy path.
//
// Run: node test/run.mjs   (exit 0 = green)

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const settings = require("../lib/settings.js");
const sessionStart = require("../hooks/session-start.js");

let passed = 0;
const check = (cond, msg) => {
  if (!cond) { console.log(`FAIL: ${msg}`); process.exit(1); }
  passed += 1;
};

const HOOKS = "/opt/quadron-connect/hooks";

// ── the merger must not damage what it finds ──────────────────────────────────────────────────

// A real config: someone else's SessionStart hook, plus two sibling UserPromptSubmit groups —
// the exact shape observed in a live settings.json.
const existing = {
  permissions: { allow: ["Bash(git:*)"] },
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: 'node "/other/tool/activate.js"', timeout: 5 }] }],
    UserPromptSubmit: [
      { hooks: [{ type: "command", command: 'node "/other/tool/track.js"' }] },
      { hooks: [{ type: "command", command: 'node "/another/router.mjs"' }] },
    ],
  },
};

const r1 = settings.install(structuredClone(existing), HOOKS);
check(r1.added.includes("SessionStart"), "installs the recall hook");
check(r1.data.hooks.SessionStart.length === 2,
      "★ appends a NEW group beside the existing SessionStart hook rather than replacing it");
check(r1.data.hooks.SessionStart[0].hooks[0].command.includes("/other/tool/activate.js"),
      "★ the other tool's SessionStart hook survives untouched");
check(r1.data.hooks.UserPromptSubmit.length === 2,
      "★ unrelated events are left exactly as they were");
check(JSON.stringify(r1.data.permissions) === JSON.stringify(existing.permissions),
      "★ non-hook settings are preserved (permissions block intact)");

// Idempotence: running the installer twice is something people do.
const r2 = settings.install(r1.data, HOOKS);
check(r2.added.length === 0, "second install adds nothing");
check(r2.data.hooks.SessionStart.length === 2, "★ re-running does not add a duplicate group");

// ★ There is no capture hook, and the installer must not be able to add one. It posted the
// MODEL's words into the person's record as though they were the person's own judgment — the
// wrong attribution. Removed before merge, and asserted gone so it cannot return as a flag.
check(!r1.data.hooks.Stop, "★ no capture hook is installed");
import { existsSync } from "node:fs";
check(!existsSync(new URL("../hooks/stop.js", import.meta.url)),
      "★ hooks/stop.js does not exist — capture was removed, not merely switched off");
const r3 = settings.install(structuredClone(existing), HOOKS);
check(!r3.data.hooks.Stop, "★ there is no option that adds a capture hook");

// Removal takes ours and only ours.
const r4 = settings.uninstall(r1.data);
check(r4.data.hooks.SessionStart.length === 1, "uninstall removes our group");
check(r4.data.hooks.SessionStart[0].hooks[0].command.includes("/other/tool/activate.js"),
      "★ uninstall leaves the other tool's hook in place");
check(r4.data.hooks.UserPromptSubmit.length === 2, "uninstall touches nothing else");

// An event we emptied should be gone, not left as a dangling [].
const onlyOurs = settings.install({}, HOOKS);
const emptied = settings.uninstall(onlyOurs.data);
check(!emptied.data.hooks, "★ an event left with no groups is deleted, not left as an empty array");

// ★ A settings file that exists but does not parse is not ours to rewrite.
const bad = settings.read("/dev/null/definitely-not-a-file/settings.json");
check(bad.ok === true && bad.existed === false, "a missing settings file is fine (fresh install)");

// The command must be absolute and marked, so it resolves from any cwd and is findable later.
const cmd = r1.data.hooks.SessionStart[1].hooks[0].command;
check(cmd.includes(HOOKS), "the hook command uses an absolute path");
check(cmd.includes(settings.MARKER) || HOOKS.includes(settings.MARKER),
      "our hooks are identifiable by marker rather than by position");

// ── session-start injection ───────────────────────────────────────────────────────────────────

const inj = sessionStart.render([{ name: "O-1 Visas" }, { name: "Building Quadron" }]);
check(inj.includes("O-1 Visas") && inj.includes("Building Quadron"), "injects the project names");
check(inj.length <= sessionStart.CAP, "stays inside the output budget");
// ★ Phrased as statements. Imperative text framed as an out-of-band instruction can trip the
//   host's prompt-injection defenses, which surfaces it to the person instead of using it.
for (const imperative of ["you must", "You must", "always call", "do not wait", "PROACTIVELY"]) {
  check(!inj.includes(imperative), `★ injected context contains no directive ("${imperative}")`);
}
check(sessionStart.render([]) === "", "no projects means no output, not an empty banner");

// ── parsing the server's project list ─────────────────────────────────────────────────────────
// ★ The default seed Quad is named "Hello, Quadron" — a project name WITH A COMMA IN IT. The
//   parser split on "," and reported it as two projects that do not exist, then stated them to the
//   model as fact. The rendered line looked correct because split-then-join round-trips, so nothing
//   downstream could reveal it. These assert the count, which is the thing that was wrong.
const GROUND = (list) =>
  `Active Quadron projects: ${list}. Keep these in view as you work: which project does this advance, and what could the person go on record about? This is where their expertise record is built.`;

const seeded = sessionStart.parseProjects(GROUND("Hello, Quadron · Skill Compose · Gearbx"));
check(seeded.length === 3, "★ a comma-containing project name stays ONE project, not two");
check(seeded[0].name === "Hello, Quadron", "★ the seed Quad's comma survives parsing");
check(seeded[2].name === "Gearbx", "the last project is not truncated");

// The enrichment suffix is stripped, and only from the name it belongs to.
const enriched = sessionStart.parseProjects(GROUND("Hello, Quadron (3 recorded judgments) · Gearbx"));
check(enriched.length === 2 && enriched[0].name === "Hello, Quadron",
      "★ the judgment-count suffix is stripped without eating the comma in the name");

// A server older than this package still speaks commas. That path cannot be made correct — it is a
// fallback, not a supported one — but it must not crash or drop everything.
const legacy = sessionStart.parseProjects(GROUND("Skill Compose, Gearbx"));
check(legacy.length === 2, "the legacy comma separator still parses");

check(sessionStart.parseProjects("Expertise recall is temporarily unavailable.") === null,
      "★ a non-grounding response yields null so the caller passes the text through untouched");
check(sessionStart.render([{ name: "" }, { name: "   " }]) === "",
      "blank names produce no output rather than a list of nothing");

// ── which Quadron this connector talks to ─────────────────────────────────────────────────────
// ★ The endpoints were env-only, and the hook is run by the AGENT — an environment where none of
//   them are set. So a connector installed against staging recalled from PRODUCTION at every
//   session start, in silence, because a hook that cannot reach anything must say nothing. These
//   run auth.js in a throwaway HOME with the env explicitly cleared: the hook's actual situation.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const AUTH = new URL("../lib/auth.js", import.meta.url).pathname;

// A fresh process per case: auth.js resolves its endpoints once, at module load.
function resolveIn(home, env = {}) {
  const out = execFileSync(process.execPath,
    ["-e", `const a=require(${JSON.stringify(AUTH)});process.stdout.write(JSON.stringify({i:a.ISSUER,m:a.MCP_URL,d:a.DEFAULTS.issuer}))`],
    { env: { PATH: process.env.PATH, HOME: home, ...env }, encoding: "utf8" });
  return JSON.parse(out);
}

const home = mkdtempSync(join(tmpdir(), "qc-"));
mkdirSync(join(home, ".quadron"), { recursive: true });

const bare = resolveIn(home);
check(bare.i === bare.d, "with no config and no env, the production default is unchanged");

writeFileSync(join(home, ".quadron", "config.json"), JSON.stringify({
  issuer: "https://staging.app.quadron.tech/auth/realms/quadron",
  mcpUrl: "https://staging.mcp.quadron.tech/mcp",
}));

const fromCfg = resolveIn(home);
check(fromCfg.i === "https://staging.app.quadron.tech/auth/realms/quadron",
      "★ the issuer is read from config with NO env set — the hook's situation");
check(fromCfg.m === "https://staging.mcp.quadron.tech/mcp",
      "★ the hook recalls from the environment the install chose, not production");

const overridden = resolveIn(home, { QUADRON_MCP_URL: "https://override.example/mcp" });
check(overridden.m === "https://override.example/mcp", "env still wins over the config file");

// A credential belongs to the environment that minted it.
const auth = require("../lib/auth.js");
check(auth.stampedIssuer({ issuer: "https://x/realms/q" }) === "https://x/realms/q",
      "a stamped credential reports its own issuer");
check(auth.stampedIssuer({}) === auth.DEFAULTS.issuer,
      "★ a credential predating the stamp counts as production, not as a mismatch — it could only "
      + "have come from there, and treating it as unknown would log everyone out");
check(auth.stampedIssuer(null) === auth.DEFAULTS.issuer, "a missing credential does not throw");

rmSync(home, { recursive: true, force: true });

console.log(`OK — ${passed} assertions passed`);
