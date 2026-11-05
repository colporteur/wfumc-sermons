// One Postgres connection for the whole connector. It talks to the
// database directly (not through Supabase's REST layer), so when the
// apps move from Supabase to Neon only DATABASE_URL changes.
//
// The connection bypasses row-level security, so EVERY query in lib/tools
// filters by owner() — Todd's user id — and only touches the tables listed
// in ALLOWED_TABLES below. Pastoral records, bulletins, parishioners etc.
// are deliberately unreachable from here.

import postgres from "postgres";

export const ALLOWED_TABLES = [
  "sermons",
  "preachings",
  "sermon_revisions",
  "workspace_slides",
  "sermon_slide_images",
  "resources",
  "sermon_resources",
  "sermon_stashed_blocks",
  "sermon_liturgies",
  "sermon_liturgy_sections",
  "sermon_liturgy_links",
  "liturgy_element_instructions",
  "pastoral_voice_guides",
  "voice_exemplars",
  "sermon_background_docs",
  "worship_plans", // read-only, for "what's next Sunday"
  "connector_changes",
  "mcp_clients",
  "mcp_tokens",
] as const;

type Sql = ReturnType<typeof postgres>;
let client: Sql | null = null;

export function sql(): Sql {
  if (client) return client;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  client = postgres(url, {
    // Supabase's transaction pooler (port 6543) can't use prepared statements.
    prepare: false,
    max: Number(process.env.PG_MAX ?? 3),
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require",
    types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } },
  });
  return client;
}

/** Tests swap in their own database. */
export function setSqlForTests(s: Sql | null) {
  client = s;
}

export function owner(): string {
  const id = process.env.OWNER_USER_ID ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("OWNER_USER_ID is not set to a user id");
  return id;
}

export function appBase(): string {
  return (process.env.APP_BASE_URL ?? "https://colporteur.github.io/wfumc-sermons").replace(/\/$/, "");
}
