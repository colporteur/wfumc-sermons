// Pure OAuth helpers for the WFUMC Sermons connector (ported from the FIA
// connector). No DB here so the rules are testable (tests/oauth-core.test.ts).
//
// Flow (OAuth 2.1 + PKCE, what the Claude app's custom connectors speak):
//   Claude → /api/mcp (401 + resource metadata) → /.well-known/* →
//   /api/mcp/oauth/register (DCR) → /authorize (Todd enters the connector
//   password and clicks Allow) → Claude's callback with a code →
//   /api/mcp/oauth/token (code + verifier → access + refresh tokens).

import crypto from "node:crypto";

export const ACCESS_TTL_S = 8 * 60 * 60; // 8 hours
export const REFRESH_TTL_S = 90 * 24 * 60 * 60; // 90 days, rotated on use
export const CODE_TTL_S = 5 * 60;

export function randomToken(prefix: string): string {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

export function sha256hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** PKCE S256: base64url(sha256(verifier)) must equal the challenge. */
export function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const got = crypto.createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(got);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Where an approval may send its code: Claude's own connector callback
 * (claude.ai / claude.com), or a loopback address for desktop tools such as
 * Claude Code. Anything else is refused at registration and again at
 * approval, so a code can never be handed to some other website.
 */
export function redirectAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === "https:") {
    const h = u.hostname.toLowerCase();
    const claudeHost = h === "claude.ai" || h === "claude.com" || h.endsWith(".claude.ai") || h.endsWith(".claude.com");
    return claudeHost && u.pathname === "/api/mcp/auth_callback";
  }
  if (u.protocol === "http:") {
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  }
  return false;
}

export function siteOrigin(req: Request): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3030";
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = h.get("x-forwarded-proto") ?? (local ? "http" : "https");
  return `${proto}://${host}`;
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: ["read", "write"],
    bearer_methods_supported: ["header"],
    resource_name: "WFUMC Sermons",
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`,
    revocation_endpoint: `${origin}/api/mcp/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["read", "write"],
  };
}

export type AuthorizeParams = {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  scope: string | null;
};

/** Validates the /authorize query; returns the params or an error text. */
export function parseAuthorize(q: Record<string, string | string[] | undefined>): AuthorizeParams | { error: string } {
  const one = (k: string) => {
    const v = q[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const clientId = one("client_id") ?? "";
  const redirectUri = one("redirect_uri") ?? "";
  const codeChallenge = one("code_challenge") ?? "";
  if (one("response_type") !== "code") return { error: "response_type must be code" };
  if (!clientId) return { error: "client_id is missing" };
  if (!redirectAllowed(redirectUri)) return { error: "That redirect address isn't allowed." };
  if ((one("code_challenge_method") ?? "") !== "S256") return { error: "PKCE (S256) is required" };
  if (!/^[A-Za-z0-9\-_]{43,128}$/.test(codeChallenge)) return { error: "code_challenge is invalid" };
  return { clientId, redirectUri, state: one("state") ?? null, codeChallenge, scope: one("scope") ?? null };
}
