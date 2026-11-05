// RFC 9728 metadata for the connector. Also answers the
// path-suffixed form (/.well-known/oauth-protected-resource/api/mcp).
import { protectedResourceMetadata, siteOrigin } from "@/lib/oauth-core";
import { json, preflight } from "@/lib/http";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return json(protectedResourceMetadata(siteOrigin(req)));
}
export const OPTIONS = preflight;
