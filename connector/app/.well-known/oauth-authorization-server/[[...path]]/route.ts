// RFC 8414 metadata: The connector is its own authorization server for the connector.
import { authorizationServerMetadata, siteOrigin } from "@/lib/oauth-core";
import { json, preflight } from "@/lib/http";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return json(authorizationServerMetadata(siteOrigin(req)));
}
export const OPTIONS = preflight;
