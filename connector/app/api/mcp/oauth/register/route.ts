// POST /api/mcp/oauth/register — Dynamic Client Registration (RFC 7591).
// Registering grants nothing: Todd still has to sign in and click Allow,
// and only Claude's callback (or a loopback address) is accepted.
import { OAuthError, registerClient } from "@/lib/oauth";
import { json, preflight } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_client_metadata", error_description: "Body must be JSON" }, 400);
  }
  try {
    return json(await registerClient(body), 201);
  } catch (err) {
    if (err instanceof OAuthError) return json({ error: err.code, error_description: err.message }, err.status);
    console.error("[mcp] register failed", err);
    return json({ error: "server_error" }, 500);
  }
}
export const OPTIONS = preflight;
