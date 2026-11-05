// Connector auth. The only path is a refresh token for a staging test account
// (QUADRON_CONNECTOR_REFRESH_TOKEN, _CLIENT_ID, _ISSUER), exchanged per row for an access token
// that goes only into the MCP Authorization header. The refresh token never reaches the child
// env or a file. No credential file is read here.

import { EXIT, Refusal } from "./guards.mjs";

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
    this.code = EXIT.AUTH;
  }
}

const STAGING_SUFFIX = ".quadron.tech";

// Staging means https, a host under quadron.tech, and a first DNS label of exactly "staging".
export function isStagingUrl(value) {
  let u;
  try { u = new URL(value); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  return u.hostname.endsWith(STAGING_SUFFIX) && u.hostname.split(".")[0] === "staging";
}

export function assertStaging(issuer, mcpUrl) {
  if (!isStagingUrl(issuer)) throw new Refusal("connector issuer is not the staging server");
  if (!isStagingUrl(mcpUrl)) throw new Refusal("MCP URL is not the staging server");
}

// Discovery's answer decides where the refresh token goes, so it is held to the issuer's host.
export function assertTokenEndpoint(tokenEndpoint, issuer) {
  let t;
  try { t = new URL(tokenEndpoint); } catch { throw new Refusal("token endpoint from discovery is not a URL; no token sent"); }
  if (t.protocol !== "https:" || t.username || t.password) throw new Refusal("token endpoint from discovery is not https; no token sent");
  if (t.hostname !== new URL(issuer).hostname) throw new Refusal("token endpoint from discovery is not on the issuer's host; no token sent");
}

// Refresh-token request shape as in cli/lib/auth.js: discovery, then a form POST with
// grant_type=refresh_token, refresh_token, client_id; the scope, when present, must include
// quadron-mcp. Discovery path is the standard OIDC one (unmeasured against staging). A redirect is
// an error, on both requests, so the checks above cannot be walked around.
// Errors carry no token, and every failure reads as an auth failure, never a product result.
export async function mintAccessToken({ refreshToken, clientId, issuer, fetch }) {
  try {
    const d = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, { redirect: "error" });
    if (!d.ok) throw new AuthError(`discovery failed (HTTP ${d.status})`);
    const meta = await d.json();
    assertTokenEndpoint(meta.token_endpoint, issuer);
    const r = await fetch(meta.token_endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
    });
    if (!r.ok) throw new AuthError(`token refresh failed (HTTP ${r.status})`);
    const body = await r.json();
    const scopeBad = body.scope !== undefined && (typeof body.scope !== "string" || !body.scope.split(/\s+/).includes("quadron-mcp"));
    if (!body.access_token || scopeBad) throw new AuthError("token response unusable (token or scope missing)");
    return body.access_token;
  } catch (e) {
    if (e instanceof AuthError || e instanceof Refusal) throw e;
    throw new AuthError("token refresh failed (network or parse error)"); // original message dropped on purpose
  }
}

// Identity as the token reports it, from the unverified payload. Null when none is exposed.
export function identityFromToken(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
    return payload.preferred_username ?? payload.email ?? null;
  } catch {
    return null;
  }
}

// Returns {check, note}. A reported identity that differs from the expected account refuses.
// Where none is reported the check is "not shown": --account-label is required, and it is printed
// as a label. The expected account is never restated as one.
export function checkAccount(accessToken, expectedAccount, accountLabel) {
  const id = identityFromToken(accessToken);
  if (id === null) {
    if (!accountLabel) throw new Refusal("the token exposes no identity: --account-label is required");
    return { check: "not shown", note: `account label (not verified): ${accountLabel}` };
  }
  if (id !== expectedAccount) throw new Refusal("token identity does not match the expected account");
  return { check: "matched", note: "token identity matches the expected account" };
}

export function mcpServersFor(accessToken, mcpUrl) {
  return { quadron: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${accessToken}` } } };
}
