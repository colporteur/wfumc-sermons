// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { authorizationServerMetadata, parseAuthorize, pkceOk, redirectAllowed } from "../lib/oauth-core";

test("only Claude's callback or loopback may receive a code", () => {
  assert.equal(redirectAllowed("https://claude.ai/api/mcp/auth_callback"), true);
  assert.equal(redirectAllowed("https://claude.com/api/mcp/auth_callback"), true);
  assert.equal(redirectAllowed("http://localhost:6274/oauth/callback"), true);
  assert.equal(redirectAllowed("http://127.0.0.1:33418/callback"), true);
  assert.equal(redirectAllowed("https://claude.ai/somewhere-else"), false);
  assert.equal(redirectAllowed("https://claude.ai.evil.com/api/mcp/auth_callback"), false);
  assert.equal(redirectAllowed("https://evil.com/api/mcp/auth_callback"), false);
  assert.equal(redirectAllowed("http://claude.ai/api/mcp/auth_callback"), false);
  assert.equal(redirectAllowed("https://user@claude.ai/api/mcp/auth_callback"), false);
  assert.equal(redirectAllowed("javascript:alert(1)"), false);
  assert.equal(redirectAllowed("not a url"), false);
});

test("PKCE S256", () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  assert.equal(pkceOk(verifier, challenge), true);
  assert.equal(pkceOk(verifier + "x", challenge), false);
  assert.equal(pkceOk("short", challenge), false);
});

test("authorize params are validated", () => {
  const good = {
    response_type: "code",
    client_id: "fiac_x",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    state: "s1",
  };
  const p = parseAuthorize(good);
  assert.ok(!("error" in p));
  assert.equal((p as { state: string }).state, "s1");
  assert.ok("error" in parseAuthorize({ ...good, code_challenge_method: "plain" }));
  assert.ok("error" in parseAuthorize({ ...good, redirect_uri: "https://evil.com/cb" }));
  assert.ok("error" in parseAuthorize({ ...good, response_type: "token" }));
});

test("metadata points at the connector's own endpoints", () => {
  const m = authorizationServerMetadata("https://www.foundinalabama.com");
  assert.equal(m.authorization_endpoint, "https://www.foundinalabama.com/authorize");
  assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
});
