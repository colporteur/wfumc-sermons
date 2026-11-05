// POST /api/mcp/oauth/token — code → tokens, refresh → new tokens, and
// (with `token` and no grant_type) revocation per RFC 7009.
import { OAuthError, exchangeCode, refreshTokens, revokeToken } from "@/lib/oauth";
import { json, preflight } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function params(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, String(v ?? "")]));
  }
  const f = new URLSearchParams(await req.text());
  return Object.fromEntries(f.entries());
}

/** client_id may also arrive via HTTP Basic (the secret is ignored: public clients + PKCE). */
function basicClientId(req: Request): string | null {
  const m = (req.headers.get("authorization") ?? "").match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  const dec = Buffer.from(m[1], "base64").toString("utf8");
  return decodeURIComponent(dec.split(":")[0] ?? "") || null;
}

export async function POST(req: Request) {
  const p = await params(req);
  const clientId = p.client_id || basicClientId(req);
  try {
    if (p.grant_type === "authorization_code") {
      if (!clientId) throw new OAuthError("invalid_client", "client_id is required", 401);
      return json(await exchangeCode({ code: p.code ?? "", clientId, redirectUri: p.redirect_uri ?? "", verifier: p.code_verifier ?? "" }));
    }
    if (p.grant_type === "refresh_token") {
      return json(await refreshTokens({ refreshToken: p.refresh_token ?? "", clientId }));
    }
    if (!p.grant_type && p.token) {
      await revokeToken(p.token);
      return json({});
    }
    throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token");
  } catch (err) {
    if (err instanceof OAuthError) return json({ error: err.code, error_description: err.message }, err.status);
    console.error("[mcp] token failed", err);
    return json({ error: "server_error" }, 500);
  }
}
export const OPTIONS = preflight;
