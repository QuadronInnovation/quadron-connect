"use strict";
// Device-code OAuth for a terminal. No browser callback, no localhost listener, no pasted secret.
//
// Why device code and not the auth-code + PKCE flow the browser extension uses: a CLI has nowhere
// to receive a redirect. Binding a port to catch one is a firewall prompt on macOS, breaks over
// ssh, and fails in a container. Device code needs only outbound HTTPS, which is the one thing a
// terminal always has. Keycloak advertises it:
//   grant_types_supported includes urn:ietf:params:oauth:grant-type:device_code
//   device_authorization_endpoint = <issuer>/protocol/openid-connect/auth/device
//
// The client registers itself via DCR (also advertised, and verified working), so there is no
// client secret to ship and nothing to rotate in this package.

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = path.join(os.homedir(), ".quadron");
const CREDS = path.join(HOME, "credentials.json");
const CLIENT = path.join(HOME, "client.json");
const CONFIG = path.join(HOME, "config.json");

const DEFAULTS = {
  issuer: "https://app.quadron.tech/auth/realms/quadron",
  api: "https://app.quadron.tech",
  mcpUrl: "https://mcp.quadron.tech/mcp",
};

// ── which Quadron this connector talks to ─────────────────────────────────────────────────────
// Resolution is env > ~/.quadron/config.json > production default, and the INSTALLER writes that
// config file.
//
// ★ These were env-only, and that quietly could not work. `quadron-connect install` honoured
// QUADRON_ISSUER / QUADRON_MCP_URL, but the SessionStart hook it installs is run by the agent,
// in an environment where none of them are set — settings.js writes a bare `node "<path>"` command
// with nothing baked in. So a connector installed against staging recalled from PRODUCTION at
// every session start, and refreshed its staging credential against the production issuer. In
// silence, because a hook that cannot reach anything is required to say nothing.
//
// A config file is what makes the hook inherit the environment the install chose, without
// depending on the agent's environment or on shell quoting inside a hook command. Env still wins,
// so a one-off override needs no file edit.
const _cfg = load(CONFIG) || {};
const ISSUER = process.env.QUADRON_ISSUER || _cfg.issuer || DEFAULTS.issuer;
const API = process.env.QUADRON_API || _cfg.api || DEFAULTS.api;
const MCP_URL = process.env.QUADRON_MCP_URL || _cfg.mcpUrl || DEFAULTS.mcpUrl;

function saveConfig(cfg = {}) {
  save(CONFIG, { issuer: ISSUER, api: API, mcpUrl: MCP_URL, ...cfg });
}

// A credential or DCR registration belongs to the environment that minted it. Before endpoints
// were configurable that was unambiguous; now that staging is reachable, a stale credential in
// ~/.quadron would otherwise be refreshed against the other environment's issuer and fail in a way
// that reads as "login broken" rather than "wrong environment".
//
// One written before this field existed can only have come from the default issuer, because that
// was the only endpoint reachable then — so absent means default rather than mismatch, and it gets
// stamped on the next write.
function stampedIssuer(o) {
  return (o && o.issuer) || DEFAULTS.issuer;
}

// Refresh this far before expiry rather than on failure: a hook has one shot and no way to ask
// the person for anything, so it must never be the thing that discovers a token just died.
const SKEW_MS = 60_000;
const SCOPE = "openid offline_access profile email quadron-mcp";
const SCOPE_VERSION = 1;
const NETWORK_TIMEOUT_MS = 5000;

function scoped(record) {
  return !!(record && record.scope_version === SCOPE_VERSION &&
    typeof record.scope === "string" && record.scope.split(/\s+/).includes("quadron-mcp"));
}

function request(url, options = {}) {
  return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
}

function wellKnown() {
  return `${ISSUER}/.well-known/openid-configuration`;
}

async function discover() {
  const r = await request(wellKnown());
  if (!r.ok) throw new Error(`discovery failed: ${r.status} ${wellKnown()}`);
  return r.json();
}

// ── credential storage ────────────────────────────────────────────────────────────────────────
// 0600, owner only, and NOT in settings.json. Claude Code's /hooks menu displays the full command
// of every registered hook, so anything on that command line is shoulder-surfable; the token
// lives in a file the hook reads instead.
function save(file, obj) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600); // explicit: writeFileSync mode is ignored if the file already exists
}

function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// ── dynamic client registration ───────────────────────────────────────────────────────────────
async function ensureClient() {
  const existing = load(CLIENT);
  // ★ Issuer-checked, not merely present. A DCR client_id exists only in the realm that issued it,
  //   so reusing a staging registration against production sends an unknown client to the token
  //   endpoint — an OAuth error with nothing in it pointing at the real cause. Re-register instead.
  if (existing && existing.client_id && stampedIssuer(existing) === ISSUER && scoped(existing)) return existing;
  const meta = await discover();
  if (!meta.registration_endpoint) throw new Error("this realm does not offer dynamic registration");
  const r = await request(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "quadron-connect (CLI)",
      scope: SCOPE,
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      token_endpoint_auth_method: "none", // public client; there is no secret to keep
    }),
  });
  if (!r.ok) throw new Error(`client registration failed: ${r.status}`);
  const reg = await r.json();
  if (!reg || typeof reg.client_id !== "string" || !reg.client_id) throw new Error("client registration returned no client identity");
  save(CLIENT, { ...reg, issuer: ISSUER, scope: SCOPE, scope_version: SCOPE_VERSION });
  return reg;
}

// ── the device flow ───────────────────────────────────────────────────────────────────────────
async function beginDeviceAuth() {
  const meta = await discover();
  const client = await ensureClient();
  const ep = meta.device_authorization_endpoint;
  if (!ep) throw new Error("this realm does not advertise a device authorization endpoint");
  const r = await request(ep, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.client_id, scope: SCOPE }),
  });
  if (!r.ok) throw new Error(`device authorization failed: ${r.status}`);
  return { ...(await r.json()), client_id: client.client_id, token_endpoint: meta.token_endpoint };
}

async function pollForToken(dev, onTick) {
  // Honour the server's interval and its slow_down, rather than picking our own pace: polling
  // faster than asked is how a client gets rate-limited mid-login.
  let interval = (dev.interval || 5) * 1000;
  const deadline = Date.now() + (dev.expires_in || 600) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const r = await request(dev.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: dev.device_code,
        client_id: dev.client_id,
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.ok && body.access_token) {
      if (body.scope !== undefined && (typeof body.scope !== "string" || !body.scope.split(/\s+/).includes("quadron-mcp"))) throw new Error("sign-in did not grant Quadron access; reconnect with consent");
      const creds = { ...body, scope: body.scope || SCOPE, scope_version: SCOPE_VERSION, client_id: dev.client_id, issuer: ISSUER, obtained_at: Date.now() };
      save(CREDS, creds);
      return creds;
    }
    if (body.error === "authorization_pending") {
      if (onTick) onTick();
      continue;
    }
    if (body.error === "slow_down") {
      interval += 5000;
      continue;
    }
    throw new Error(`sign-in failed: ${r.status}; retry explicit sign-in`);
  }
  throw new Error("sign-in timed out — run the command again");
}

// ── the accessor a hook uses ──────────────────────────────────────────────────────────────────
async function accessToken() {
  const c = load(CREDS);
  if (!c || !c.refresh_token) return null;
  // Refusing here is the point: a credential from the other environment would otherwise be sent to
  // THIS issuer's token endpoint. The hook treats null as "not linked" and stays silent, which is
  // the correct posture — better no context than context from the wrong Quadron.
  if (stampedIssuer(c) !== ISSUER || !scoped(c)) return null;
  const fresh = c.obtained_at + (c.expires_in || 300) * 1000 - SKEW_MS > Date.now();
  if (fresh && c.access_token) return c.access_token;
  const meta = await discover();
  const r = await request(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: c.refresh_token,
      client_id: c.client_id,
    }),
  });
  if (!r.ok) return null; // caller degrades; a hook must never block on this
  const body = await r.json();
  if (!body.access_token || (body.scope !== undefined && (typeof body.scope !== "string" || !body.scope.split(/\s+/).includes("quadron-mcp")))) return null;
  save(CREDS, { ...c, ...body, issuer: ISSUER, obtained_at: Date.now() });
  return body.access_token;
}

function isLinked() {
  const c = load(CREDS);
  return !!(c && c.refresh_token && stampedIssuer(c) === ISSUER && scoped(c));
}

module.exports = {
  ISSUER, API, MCP_URL, DEFAULTS, HOME, CREDS, CLIENT, CONFIG,
  discover, ensureClient, beginDeviceAuth, pollForToken, accessToken, isLinked, load, save,
  saveConfig, stampedIssuer, scoped, SCOPE, SCOPE_VERSION, request,
};
