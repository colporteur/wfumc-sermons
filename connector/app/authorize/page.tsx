// /authorize — the consent step of the connector's sign-in. Claude sends
// Todd here; he types the connector password (CONNECTOR_PASSWORD), picks
// read-only or read + changes, and Allow sends a one-time code back to
// Claude. Visiting /authorize directly offers "disconnect everything".

import crypto from "node:crypto";
import { redirect } from "next/navigation";
import { parseAuthorize } from "@/lib/oauth-core";
import { createAuthCode, loadClient, mcpReady, revokeAll } from "@/lib/oauth";

export const dynamic = "force-dynamic";

type SP = Record<string, string | string[] | undefined>;

function back(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

function selfUrl(sp: SP, extra: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "err" && k !== "done") q.set(k, v);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return `/authorize?${q.toString()}`;
}

async function passwordOk(given: string): Promise<boolean> {
  const want = process.env.CONNECTOR_PASSWORD ?? "";
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  const ok = want.length >= 8 && crypto.timingSafeEqual(a, b);
  if (!ok) await new Promise((r) => setTimeout(r, 1500)); // slow down guessing
  return ok;
}

const box: React.CSSProperties = { maxWidth: 560, margin: "48px auto", padding: "0 20px", fontFamily: "Georgia, 'Times New Roman', serif", color: "#2b2620", lineHeight: 1.5 };
const btn: React.CSSProperties = { padding: "10px 20px", borderRadius: 6, border: "1px solid #2b2620", background: "#2b2620", color: "#fff", fontSize: 16, cursor: "pointer" };
const btn2: React.CSSProperties = { ...btn, background: "transparent", color: "#2b2620" };
const input: React.CSSProperties = { width: "100%", padding: "10px 12px", fontSize: 16, border: "1px solid #b8ab98", borderRadius: 6, boxSizing: "border-box" };

export default async function AuthorizePage({ searchParams }: { searchParams: SP }) {
  const shell = (body: React.ReactNode) => (
    <main style={box}>
      <p style={{ fontSize: 12, letterSpacing: 2, textTransform: "uppercase", color: "#8a6d3b", marginBottom: 4 }}>WFUMC Sermons</p>
      {body}
    </main>
  );
  if (!(await mcpReady())) return shell(<p>The database migration hasn&apos;t been run yet (0076_claude_connector.sql).</p>);
  const wrong = searchParams.err === "1";

  // No OAuth request: the "disconnect everything" page.
  if (!searchParams.client_id) {
    async function revoke(form: FormData) {
      "use server";
      if (!(await passwordOk(String(form.get("password") ?? "")))) redirect("/authorize?err=1");
      const n = await revokeAll();
      redirect(`/authorize?done=${n}`);
    }
    return shell(
      <>
        <h1 style={{ fontSize: 28, margin: "0 0 12px" }}>Claude connector</h1>
        {searchParams.done != null && <p style={{ color: "#2e6b30" }}>Disconnected. Every Claude connection must sign in again.</p>}
        <p>To connect, add this server as a custom connector in Claude. To cut off every existing connection at once:</p>
        <form action={revoke} style={{ display: "grid", gap: 12, marginTop: 16 }}>
          <input type="password" name="password" placeholder="Connector password" style={input} required />
          {wrong && <p style={{ color: "#a33", margin: 0 }}>That password isn&apos;t right.</p>}
          <div>
            <button style={btn}>Disconnect all</button>
          </div>
        </form>
      </>,
    );
  }

  const p = parseAuthorize(searchParams);
  if ("error" in p) return shell(<p style={{ color: "#a33" }}>Can&apos;t connect: {p.error}</p>);
  const client = await loadClient(p.clientId);
  if (!client || !client.redirectUris.includes(p.redirectUri))
    return shell(<p style={{ color: "#a33" }}>This connection request isn&apos;t recognized. Remove the connector in Claude and add it again.</p>);

  const params = p;
  const sp = searchParams;
  async function allow(form: FormData) {
    "use server";
    if (!(await passwordOk(String(form.get("password") ?? "")))) redirect(selfUrl(sp, { err: "1" }));
    const code = await createAuthCode({
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      write: form.get("write") === "on",
    });
    redirect(back(params.redirectUri, { code, state: params.state }));
  }
  async function deny() {
    "use server";
    redirect(back(params.redirectUri, { error: "access_denied", state: params.state }));
  }

  const host = new URL(p.redirectUri).host;
  return shell(
    <>
      <h1 style={{ fontSize: 28, margin: "0 0 12px" }}>Connect {client.name ?? "Claude"} to your Sermons app?</h1>
      <p style={{ marginBottom: 6 }}>It will be able to <strong>read</strong>:</p>
      <ul style={{ marginTop: 0, fontSize: 15 }}>
        <li>sermons, manuscripts, past versions and preaching history</li>
        <li>slide lists, resources, liturgies and liturgy instructions</li>
        <li>your voice guide, background documents and upcoming worship weeks</li>
      </ul>
      <p style={{ fontSize: 14, color: "#6b6156" }}>
        Pastoral records, bulletins and everything else in the shared database are not reachable. The approval goes back to <code>{host}</code>.
      </p>
      <form action={allow} style={{ display: "grid", gap: 14, marginTop: 20 }}>
        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 15 }}>
          <input type="checkbox" name="write" defaultChecked style={{ marginTop: 5 }} />
          <span>
            <strong>Allow changes</strong> you approve in chat: manuscripts, slides, sermon details, resources and liturgies. Every change saves
            the previous version first and can be undone. Nothing is ever permanently deleted except things Claude itself added.
          </span>
        </label>
        <input type="password" name="password" placeholder="Connector password" style={input} required autoFocus />
        {wrong && <p style={{ color: "#a33", margin: 0 }}>That password isn&apos;t right.</p>}
        <div style={{ display: "flex", gap: 12 }}>
          <button style={btn}>Allow</button>
          <button style={btn2} formAction={deny} formNoValidate>
            Cancel
          </button>
        </div>
      </form>
    </>,
  );
}
