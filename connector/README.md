# WFUMC Sermons connector

A private Claude connector (MCP server) for the WFUMC Sermons and Sunday School apps (plus read-only search of the Colporteur library), deployed
on Vercel from this folder. Claude reads sermons, manuscripts, slides,
resources, liturgies, the voice guide and Sunday School lessons, searches the Colporteur library, and — on connections approved with
"Allow changes" — writes changes Todd approves in chat. Every write saves the
previous state first (`connector_changes`, plus Past Versions for
manuscripts) and can be undone.

- `app/api/mcp` — the MCP endpoint (add `https://<deployment>/api/mcp` in Claude)
- `app/authorize` — the Allow page (connector password); visit it directly to disconnect everything
- `lib/tools/*` — the tools; every query is scoped to `OWNER_USER_ID`
- `db/0076_claude_connector.sql` — sign-in tables and change log (also copied into the Bulletin App's migrations)
- `npm test` — unit tests; `tests/e2e.mjs` — full run against a local stand-in database (`npx tsx tests/dbserver.ts`, then `npm run build && npm start`)
