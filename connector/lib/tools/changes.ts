// The change log: what the connector has written, and undo.

import { sql, owner } from "../db";
import type { ToolDef } from "../protocol";
import { manuscriptHash, snapshotRevision } from "./sermons";
import { loadSlides, restoreSlides, slidesHash } from "./slides";
import { restoreSections } from "./liturgies";
import { type Ctx, bool, iso, logChange, num, requireWrite, uuid } from "./util";

type Row = Record<string, any>;
type T = ReturnType<typeof sql>;
const j = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v) as Row | null;

async function listChanges(a: Record<string, unknown>) {
  const sermonId = uuid(a, "sermon_id", false);
  const limit = num(a, "limit", 20, 1, 100)!;
  const s = sql();
  const rows = await s`
    SELECT c.id, c.kind, c.tool, c.summary, c.created_at, c.undone_at, c.sermon_id, c.target_id, s.title AS sermon_title
    FROM connector_changes c LEFT JOIN sermons s ON s.id = c.sermon_id
    WHERE c.owner_user_id = ${owner()} ${sermonId ? s`AND c.sermon_id = ${sermonId}` : s``}
    ORDER BY c.created_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    change_id: r.id,
    when: iso(r.created_at),
    what: r.summary,
    kind: r.kind,
    sermon: r.sermon_title ?? undefined,
    undone: r.undone_at ? iso(r.undone_at) : undefined,
    can_undo: !r.undone_at && r.kind !== "undo",
  }));
}

async function undo(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const id = uuid(a, "change_id")!;
  const force = bool(a, "force", false);
  return sql().begin(async (tx) => {
    const t = tx as unknown as T;
    const [c] = await t`SELECT * FROM connector_changes WHERE id = ${id} AND owner_user_id = ${owner()} FOR UPDATE`;
    if (!c) throw new Error(`No change with id ${id}`);
    if (c.undone_at) throw new Error(`Already undone on ${iso(c.undone_at)}`);
    if (c.kind === "undo") throw new Error("That entry is itself an undo; undo the original change again isn't possible — make a new change instead.");
    const before = j(c.before);
    const after = j(c.after);
    let what = "";

    switch (c.kind) {
      case "manuscript":
      case "sermon_details": {
        const [s] = await t`SELECT * FROM sermons WHERE id = ${c.sermon_id} AND owner_user_id = ${owner()} FOR UPDATE`;
        if (!s) throw new Error("The sermon no longer exists");
        const touchesText = before && "manuscript_text" in before;
        if (touchesText && s.manuscript_locked) throw new Error("The manuscript is locked in the app; unlock it first.");
        if (c.kind === "manuscript" && after?.manuscript_hash && after.manuscript_hash !== manuscriptHash(s.manuscript_text) && !force)
          throw new Error(
            "The manuscript has been edited since this change, so undoing would also throw away those later edits. Tell Todd; if he still wants it, call again with force: true (the current text is saved to Past Versions first either way).",
          );
        if (touchesText) await snapshotRevision(t, s, "Before undoing a Claude change");
        await t`UPDATE sermons SET ${t(before as any)} WHERE id = ${s.id}`;
        what = `Restored ${Object.keys(before ?? {}).join(", ")} on "${s.title}"`;
        break;
      }
      case "slides": {
        const cur = await loadSlides(t, c.sermon_id);
        if (after?.slides_hash && after.slides_hash !== slidesHash(cur) && !force)
          throw new Error("The slides have changed since this change. Undoing would also discard the later slide edits; call again with force: true if Todd wants that.");
        await restoreSlides(t, c.sermon_id, (before?.slides as Row[]) ?? []);
        what = `Restored ${(before?.slides as Row[])?.length ?? 0} slides`;
        break;
      }
      case "resource_create": {
        await t`DELETE FROM resources WHERE id = ${c.target_id} AND owner_user_id = ${owner()}`;
        what = "Removed the resource Claude added (and its sermon link)";
        break;
      }
      case "resource_update": {
        await t`UPDATE resources SET ${t(before as any)} WHERE id = ${c.target_id} AND owner_user_id = ${owner()}`;
        what = `Restored ${Object.keys(before ?? {}).join(", ")} on the resource`;
        break;
      }
      case "resource_link": {
        await t`DELETE FROM sermon_resources WHERE id = ${c.target_id} AND owner_user_id = ${owner()}`;
        what = "Removed the resource link";
        break;
      }
      case "liturgy_create": {
        await t`DELETE FROM sermon_liturgies WHERE id = ${c.target_id} AND owner_user_id = ${owner()}`;
        what = "Removed the liturgy Claude created";
        break;
      }
      case "liturgy_sections": {
        await restoreSections(t, c.target_id, (before?.sections as Row[]) ?? []);
        what = "Restored the liturgy's previous elements";
        break;
      }
      case "liturgy_link": {
        if (before && before.approved === false) await t`UPDATE sermon_liturgy_links SET approved = false WHERE id = ${c.target_id}`;
        else await t`DELETE FROM sermon_liturgy_links WHERE id = ${c.target_id} AND owner_user_id = ${owner()}`;
        what = "Removed the liturgy link";
        break;
      }
      default:
        throw new Error(`Don't know how to undo a ${c.kind} change`);
    }
    const undoId = await logChange(t, ctx, { kind: "undo", tool: "undo_change", summary: `Undid: ${c.summary}`, sermonId: c.sermon_id, targetId: c.id });
    await t`UPDATE connector_changes SET undone_at = now(), undone_by = ${undoId} WHERE id = ${c.id}`;
    return { undone: true, what, undo_change_id: undoId };
  });
}

export function changeTools(ctx: Ctx): ToolDef[] {
  return [
    {
      name: "list_recent_changes",
      title: "Recent changes by Claude",
      description: "What this connector has changed in the Sermons app, newest first, with change ids for undo_change.",
      inputSchema: { type: "object", properties: { sermon_id: { type: "string" }, limit: { type: "integer", default: 20 } } },
      run: listChanges,
    },
    {
      name: "undo_change",
      title: "Undo a change",
      description:
        "Put back what a connector change replaced (manuscript text, slides, liturgy elements, resource fields) or remove what it added. Refuses if the item was edited again since, unless force is true (manuscripts are saved to Past Versions first regardless). Only when Todd asks.",
      readOnly: false,
      destructive: true,
      inputSchema: { type: "object", required: ["change_id"], properties: { change_id: { type: "string" }, force: { type: "boolean", default: false } } },
      run: (a) => undo(a, ctx),
    },
  ];
}
