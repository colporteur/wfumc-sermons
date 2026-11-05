// OAuth storage for the connector (ported from FIA). Codes and tokens are
// random, shown to the client once, and stored only as SHA-256 hashes in
// mcp_tokens. One approval = one grant (grant_id). Scope is "read" or
// "read write"; Todd picks it on the Allow page.

import { sql } from "./db";
import {
  ACCESS_TTL_S,
  CODE_TTL_S,
  REFRESH_TTL_S,
  pkceOk,
  randomToken,
  redirectAllowed,
  sha256hex,
} from "./oauth-core";

export const WRITE_SCOPE = "write";
export const hasWrite = (scope: string | null | undefined) => (scope ?? "").split(/\s+/).includes(WRITE_SCOPE);

export class OAuthError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export async function mcpReady(): Promise<boolean> {
  const [r] = await sql()`SELECT to_regclass('public.mcp_tokens') IS NOT NULL AS ok`;
  return !!r?.ok;
}

// ─── clients (Dynamic Client Registration) ───────────────────────────────────

export async function registerClient(body: Record<string, unknown>) {
  const uris = (Array.isArray(body.redirect_uris) ? body.redirect_uris : []).map(String);
  if (!uris.length) throw new OAuthError("invalid_redirect_uri", "redirect_uris is required");
  const bad = uris.find((u) => !redirectAllowed(u));
  if (bad) throw new OAuthError("invalid_redirect_uri", `Redirect not allowed: ${bad}`);
  const name = String(body.client_name ?? "").slice(0, 120) || null;
  const id = randomToken("wsc_");
  await sql()`INSERT INTO mcp_clients (id, name, redirect_uris) VALUES (${id}, ${name}, ${sql().json(uris)})`;
  return {
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name ?? undefined,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export async function loadClient(id: string): Promise<{ id: string; name: string | null; redirectUris: string[] } | null> {
  const [r] = await sql()`SELECT id, name, redirect_uris FROM mcp_clients WHERE id = ${id}`;
  if (!r) return null;
  const uris = typeof r.redirect_uris === "string" ? JSON.parse(r.redirect_uris) : r.redirect_uris;
  return { id: String(r.id), name: (r.name as string | null) ?? null, redirectUris: (uris as string[]) ?? [] };
}

// ─── codes and tokens ────────────────────────────────────────────────────────

async function insertToken(p: {
  clientId: string;
  kind: "code" | "access" | "refresh";
  grantId: string;
  ttlS: number;
  scope: string;
  codeChallenge?: string | null;
  redirectUri?: string | null;
}): Promise<string> {
  const prefix = p.kind === "code" ? "wscode_" : p.kind === "access" ? "wsat_" : "wsrt_";
  const token = randomToken(prefix);
  await sql()`
    INSERT INTO mcp_tokens (client_id, kind, token_hash, grant_id, code_challenge, redirect_uri, expires_at, scope)
    VALUES (${p.clientId}, ${p.kind}, ${sha256hex(token)}, ${p.grantId}::uuid, ${p.codeChallenge ?? null},
            ${p.redirectUri ?? null}, now() + make_interval(secs => ${p.ttlS}), ${p.scope})`;
  return token;
}

async function grantScope(grantId: string): Promise<string> {
  const [r] = await sql()`SELECT max(scope) AS scope FROM mcp_tokens WHERE grant_id = ${grantId}::uuid`;
  return String(r?.scope ?? "read");
}

/** Todd clicked Allow: a one-time code for the client's callback. */
export async function createAuthCode(p: { clientId: string; redirectUri: string; codeChallenge: string; write: boolean }): Promise<string> {
  const client = await loadClient(p.clientId);
  if (!client) throw new OAuthError("invalid_client", "Unknown client — remove the connector in Claude and add it again.");
  if (!client.redirectUris.includes(p.redirectUri) || !redirectAllowed(p.redirectUri))
    throw new OAuthError("invalid_request", "That redirect address isn't registered for this client.");
  const [g] = await sql()`SELECT gen_random_uuid() AS id`;
  return insertToken({
    clientId: p.clientId,
    kind: "code",
    grantId: String(g.id),
    ttlS: CODE_TTL_S,
    codeChallenge: p.codeChallenge,
    redirectUri: p.redirectUri,
    scope: p.write ? `read ${WRITE_SCOPE}` : "read",
  });
}

async function issuePair(clientId: string, grantId: string) {
  const scope = await grantScope(grantId);
  const access = await insertToken({ clientId, kind: "access", grantId, ttlS: ACCESS_TTL_S, scope });
  const refresh = await insertToken({ clientId, kind: "refresh", grantId, ttlS: REFRESH_TTL_S, scope });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
}

/** Marks a token used (once) and returns its row, or null. */
async function claim(token: string, kind: string) {
  const [r] = await sql()`
    UPDATE mcp_tokens SET used_at = now()
    WHERE token_hash = ${sha256hex(token)} AND kind = ${kind} AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
    RETURNING id, client_id, grant_id, code_challenge, redirect_uri`;
  return r ?? null;
}

export async function exchangeCode(p: { code: string; clientId: string; redirectUri: string; verifier: string }) {
  const r = await claim(p.code, "code");
  if (!r) {
    // A replayed code may mean it leaked: kill whatever it already produced.
    await sql()`
      UPDATE mcp_tokens SET revoked_at = now()
      WHERE revoked_at IS NULL AND grant_id IN (SELECT grant_id FROM mcp_tokens WHERE token_hash = ${sha256hex(p.code)} AND kind = 'code')`;
    throw new OAuthError("invalid_grant", "The code is invalid, used or expired.");
  }
  if (String(r.client_id) !== p.clientId) throw new OAuthError("invalid_grant", "The code belongs to another client.");
  if (String(r.redirect_uri) !== p.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri doesn't match.");
  if (!pkceOk(p.verifier, String(r.code_challenge ?? ""))) throw new OAuthError("invalid_grant", "PKCE check failed.");
  return issuePair(p.clientId, String(r.grant_id));
}

export async function refreshTokens(p: { refreshToken: string; clientId: string | null }) {
  const r = await claim(p.refreshToken, "refresh");
  if (!r) throw new OAuthError("invalid_grant", "The refresh token is invalid, used or expired.");
  if (p.clientId && String(r.client_id) !== p.clientId) throw new OAuthError("invalid_grant", "Wrong client.");
  await sql()`UPDATE mcp_tokens SET revoked_at = now() WHERE grant_id = ${String(r.grant_id)}::uuid AND kind = 'access' AND revoked_at IS NULL`;
  return issuePair(String(r.client_id), String(r.grant_id));
}

export async function revokeToken(token: string): Promise<void> {
  await sql()`
    UPDATE mcp_tokens SET revoked_at = now()
    WHERE revoked_at IS NULL AND grant_id IN (SELECT grant_id FROM mcp_tokens WHERE token_hash = ${sha256hex(token)})`;
}

/** The bearer check for /api/mcp. */
export async function verifyAccessToken(token: string): Promise<{ clientId: string; grantId: string; scope: string; who: string } | null> {
  if (!token.startsWith("wsat_")) return null;
  const [r] = await sql()`
    UPDATE mcp_tokens SET last_used_at = now()
    WHERE token_hash = ${sha256hex(token)} AND kind = 'access' AND revoked_at IS NULL AND expires_at > now()
    RETURNING client_id, grant_id`;
  if (!r) return null;
  const grantId = String(r.grant_id);
  const scope = await grantScope(grantId);
  const [c] = await sql()`SELECT name FROM mcp_clients WHERE id = ${String(r.client_id)}`;
  return { clientId: String(r.client_id), grantId, scope, who: `Claude connector (${(c?.name as string | null) ?? "Claude"})` };
}

/** Cut off every connection at once (used by /authorize?revoke_all). */
export async function revokeAll(): Promise<number> {
  const rows = await sql()`UPDATE mcp_tokens SET revoked_at = now() WHERE revoked_at IS NULL RETURNING id`;
  return rows.length;
}
