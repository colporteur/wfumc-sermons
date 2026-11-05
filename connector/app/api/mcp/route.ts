// /api/mcp — the WFUMC Sermons connector's MCP endpoint (Streamable HTTP,
// stateless, JSON replies). Every call needs an access token from the
// connector's sign-in (Todd approves it on /authorize).

import { handleRpc } from "@/lib/protocol";
import { allTools } from "@/lib/tools";
import { hasWrite, verifyAccessToken } from "@/lib/oauth";
import { siteOrigin } from "@/lib/oauth-core";
import { CORS, json, preflight } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized(req: Request, why: string) {
  const meta = `${siteOrigin(req)}/.well-known/oauth-protected-resource`;
  return json({ error: "invalid_token", error_description: why }, 401, {
    "WWW-Authenticate": `Bearer error="invalid_token", error_description="${why}", resource_metadata="${meta}"`,
  });
}

export async function POST(req: Request) {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return unauthorized(req, "Sign in required");
  const who = await verifyAccessToken(m[1].trim()).catch((err) => {
    console.error("[mcp] token check failed", err);
    return null;
  });
  if (!who) return unauthorized(req, "Token expired or revoked");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  const reply = await handleRpc(body, allTools({ who: who.who, write: hasWrite(who.scope) }));
  if (reply === null) return new Response(null, { status: 202, headers: CORS });
  return json(reply);
}

export async function GET(req: Request) {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m || !(await verifyAccessToken(m[1].trim()).catch(() => null))) return unauthorized(req, "Sign in required");
  return new Response("Method Not Allowed", { status: 405, headers: { ...CORS, Allow: "POST" } });
}
export const DELETE = GET;
export const OPTIONS = preflight;
