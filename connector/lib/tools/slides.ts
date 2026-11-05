// Slides: the workspace_slides rows the app turns into the Sunday .pptx.

import crypto from "node:crypto";
import { sql, owner } from "../db";
import type { ToolDef } from "../protocol";
import { loadSermon, sermonUrl } from "./sermons";
import { type Ctx, bool, centralToday, iso, logChange, num, paragraphs, requireWrite, slideMarkers, str, text, uuid } from "./util";

export const SLIDE_TYPES = ["title", "scripture", "quote", "image", "content", "blank"] as const;
const SLIDE_COLS = [
  "id", "sermon_id", "owner_user_id", "sort_order", "slide_type", "title", "body", "notes",
  "anchor_paragraph_text", "anchor_paragraph_idx", "image_resource_id", "marker_description", "created_at", "updated_at",
] as const;

type Row = Record<string, any>;
type T = ReturnType<typeof sql>;

export function slidesHash(rows: Row[]): string {
  const norm = rows
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((r) => [r.id, r.slide_type, r.title, r.body, r.notes, r.anchor_paragraph_idx, r.image_resource_id, r.marker_description]);
  return crypto.createHash("sha256").update(JSON.stringify(norm)).digest("hex").slice(0, 16);
}

async function loadSlides(t: T, sermonId: string): Promise<Row[]> {
  return t`SELECT * FROM workspace_slides WHERE sermon_id = ${sermonId} AND owner_user_id = ${owner()} ORDER BY sort_order, created_at`;
}

/** The sermon for the next worship week that has one. */
async function nextSundaySermonId(): Promise<{ id: string; service_date: string }> {
  const [p] = await sql()`
    SELECT w.service_date, w.selected_sermon_id FROM worship_plans w JOIN sermons s ON s.id = w.selected_sermon_id
    WHERE w.service_date >= ${centralToday()} AND s.owner_user_id = ${owner()}
    ORDER BY w.service_date LIMIT 1`;
  if (!p) throw new Error("No upcoming worship week has a sermon linked yet. Pass sermon_id, or link the sermon to the week in the app.");
  return { id: p.selected_sermon_id, service_date: p.service_date };
}

function anchorStatus(r: Row, paras: string[]) {
  if (r.anchor_paragraph_idx == null && !r.anchor_paragraph_text) return null;
  const idx = r.anchor_paragraph_idx;
  const want = (r.anchor_paragraph_text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (idx != null && paras[idx] && paras[idx].replace(/\s+/g, " ").trim().toLowerCase() === want) return { paragraph: idx, status: "exact" };
  const found = paras.findIndex((p) => p.replace(/\s+/g, " ").trim().toLowerCase() === want);
  if (found >= 0) return { paragraph: found, status: "moved" };
  return { paragraph: idx, status: "stranded", anchor_text_start: (r.anchor_paragraph_text ?? "").slice(0, 120) };
}

async function getSlides(a: Record<string, unknown>) {
  let sermonId = uuid(a, "sermon_id", false);
  let serviceDate: string | null = null;
  if (!sermonId) {
    const n = await nextSundaySermonId();
    sermonId = n.id;
    serviceDate = n.service_date;
  }
  const s = await loadSermon(sermonId);
  const rows = await loadSlides(sql(), sermonId);
  const paras = paragraphs(s.manuscript_text);
  const imgIds = rows.map((r) => r.image_resource_id).filter(Boolean);
  const imgs = imgIds.length ? await sql()`SELECT id, title, content FROM resources WHERE id IN ${sql()(imgIds)} AND owner_user_id = ${owner()}` : [];
  const imgBy = new Map(imgs.map((r) => [r.id, r.title ?? String(r.content ?? "").slice(0, 60)]));
  const uploaded = await sql()`SELECT sort_order, original_filename, matched_marker_number FROM sermon_slide_images WHERE sermon_id = ${sermonId} ORDER BY sort_order`;
  return {
    sermon: { id: s.id, title: s.title, scripture: s.scripture_reference, app_url: sermonUrl(s.id) },
    service_date: serviceDate ?? undefined,
    slides_hash: slidesHash(rows),
    slide_count: rows.length,
    slides: rows.map((r, i) => ({
      number: i + 1,
      id: r.id,
      type: r.slide_type,
      title: r.title,
      body: r.body,
      notes: r.notes,
      anchor: anchorStatus(r, paras) ?? undefined,
      image_resource: r.image_resource_id ? { id: r.image_resource_id, title: imgBy.get(r.image_resource_id) ?? null } : undefined,
      marker_description: r.marker_description ?? undefined,
    })),
    manuscript_slide_markers: slideMarkers(s.manuscript_text),
    uploaded_slide_images: uploaded.length ? uploaded.length : undefined,
    pptx_style:
      "The app's .pptx: 16:9, Albertus Medium, 54pt left-aligned prose (no bullets, autoshrinks). title = title + optional subtitle(body); scripture = text in body, reference in title (shown bottom-right); quote = quote in body, source in title, italic on cream; image = title + placeholder; content = title + body; blank = pause. notes go to speaker notes.",
    note: "Todd downloads the .pptx from the sermon's Workspace in the app after slide changes.",
  };
}

type SlideIn = {
  id?: string;
  type?: string;
  title?: string | null;
  body?: string | null;
  notes?: string | null;
  anchor_paragraph?: number | null;
  image_resource_id?: string | null;
  marker_description?: string | null;
};

function cleanFields(x: SlideIn, paras: string[], i: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const label = x.id ? `Slide ${x.id}` : `New slide ${i + 1}`;
  if (x.type !== undefined) {
    if (!SLIDE_TYPES.includes(x.type as never)) throw new Error(`${label}: type must be one of ${SLIDE_TYPES.join(", ")}`);
    out.slide_type = x.type;
  }
  for (const k of ["title", "body", "notes", "marker_description"] as const) {
    if (x[k] === undefined) continue;
    const v = x[k] == null ? null : String(x[k]).trim();
    if (v && v.length > 20_000) throw new Error(`${label}: ${k} is too long`);
    out[k] = v || null;
  }
  if (x.anchor_paragraph !== undefined) {
    if (x.anchor_paragraph == null) {
      out.anchor_paragraph_idx = null;
      out.anchor_paragraph_text = null;
    } else {
      const n = Number(x.anchor_paragraph);
      if (!Number.isInteger(n) || !paras[n]) throw new Error(`${label}: anchor_paragraph ${x.anchor_paragraph} isn't a paragraph of the manuscript (0–${paras.length - 1})`);
      out.anchor_paragraph_idx = n;
      out.anchor_paragraph_text = paras[n];
    }
  }
  if (x.image_resource_id !== undefined) {
    const v = x.image_resource_id ? String(x.image_resource_id) : null;
    if (v && !/^[0-9a-f-]{36}$/i.test(v)) throw new Error(`${label}: image_resource_id must be a resource id`);
    out.image_resource_id = v;
  }
  return out;
}

function parseSlides(v: unknown): SlideIn[] {
  const list = typeof v === "string" ? JSON.parse(v) : v;
  if (!Array.isArray(list)) throw new Error("slides must be a list");
  if (list.length > 150) throw new Error("At most 150 slides");
  return list as SlideIn[];
}

async function setSlides(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const sermonId = uuid(a, "sermon_id")!;
  const expected = str(a, "expected_slides_hash", 40);
  const summary = str(a, "change_summary", 300);
  if (!summary) throw new Error("change_summary is required");
  if (!expected) throw new Error("expected_slides_hash is required (from get_slides)");
  const wanted = parseSlides(a.slides);
  const confirmRemovals = bool(a, "confirm_removals", false);
  const s = await loadSermon(sermonId);
  const paras = paragraphs(s.manuscript_text);

  return sql().begin(async (tx) => {
    const t = tx as unknown as T;
    await t`SELECT id FROM sermons WHERE id = ${sermonId} FOR UPDATE`;
    const before = await loadSlides(t, sermonId);
    if (slidesHash(before) !== expected) throw new Error("The slides changed since you read them. Call get_slides again and rebuild the list from the current slides.");
    const existing = new Map(before.map((r) => [r.id, r]));
    const seen = new Set<string>();
    for (const x of wanted) {
      if (x.id) {
        if (!existing.has(x.id)) throw new Error(`Slide id ${x.id} isn't one of this sermon's slides`);
        if (seen.has(x.id)) throw new Error(`Slide id ${x.id} is listed twice`);
        seen.add(x.id);
      }
    }
    const removed = before.filter((r) => !seen.has(r.id));
    if (removed.length && !confirmRemovals)
      throw new Error(
        `This would remove ${removed.length} slide(s): ${removed.map((r) => `"${r.title ?? r.slide_type}"`).join(", ")}. If Todd approved that, call again with confirm_removals: true.`,
      );

    let added = 0;
    let updated = 0;
    for (let i = 0; i < wanted.length; i++) {
      const x = wanted[i];
      const f = cleanFields(x, paras, i);
      if (x.id) {
        const cur = existing.get(x.id)!;
        const patch: Record<string, unknown> = { ...f };
        if (cur.sort_order !== i) patch.sort_order = i;
        const differs = Object.entries(patch).some(([k, v]) => (cur[k] ?? null) !== (v ?? null));
        if (differs) {
          await t`UPDATE workspace_slides SET ${t(patch as any)} WHERE id = ${x.id}`;
          updated++;
        }
      } else {
        const row = { slide_type: "content", ...f, sermon_id: sermonId, owner_user_id: owner(), sort_order: i };
        await t`INSERT INTO workspace_slides ${t(row as any)}`;
        added++;
      }
    }
    if (removed.length) await t`DELETE FROM workspace_slides WHERE id IN ${t(removed.map((r) => r.id))}`;
    const after = await loadSlides(t, sermonId);
    const changeId = await logChange(t, ctx, {
      kind: "slides",
      tool: "set_slides",
      summary,
      sermonId,
      targetId: sermonId,
      before: { slides: before.map(pickCols) },
      after: { slides_hash: slidesHash(after) },
    });
    return {
      change_id: changeId,
      added,
      updated,
      removed: removed.length,
      slide_count: after.length,
      slides_hash: slidesHash(after),
      note: "Saved. Todd can re-download the .pptx from the Workspace. undo_change with this change_id restores the previous slides exactly.",
    };
  });
}

async function editSlide(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const slideId = uuid(a, "slide_id")!;
  const summary = str(a, "change_summary", 300);
  if (!summary) throw new Error("change_summary is required");
  const [cur] = await sql()`SELECT * FROM workspace_slides WHERE id = ${slideId} AND owner_user_id = ${owner()}`;
  if (!cur) throw new Error(`No slide with id ${slideId}`);
  const s = await loadSermon(cur.sermon_id);
  const f = cleanFields(
    {
      type: a.type as string | undefined,
      title: a.title as string | undefined,
      body: a.body === undefined ? undefined : text(a, "body", 20_000),
      notes: a.notes === undefined ? undefined : text(a, "notes", 20_000),
      anchor_paragraph: a.anchor_paragraph === undefined ? undefined : (num(a, "anchor_paragraph", null, 0, 100_000) as number | null),
      image_resource_id: a.image_resource_id as string | undefined,
      marker_description: a.marker_description as string | undefined,
    },
    paragraphs(s.manuscript_text),
    0,
  );
  if (!Object.keys(f).length) throw new Error("Nothing to change");
  return sql().begin(async (tx) => {
    const t = tx as unknown as T;
    await t`SELECT id FROM sermons WHERE id = ${cur.sermon_id} FOR UPDATE`;
    const before = await loadSlides(t, cur.sermon_id);
    await t`UPDATE workspace_slides SET ${t(f as any)} WHERE id = ${slideId}`;
    const after = await loadSlides(t, cur.sermon_id);
    const changeId = await logChange(t, ctx, {
      kind: "slides",
      tool: "edit_slide",
      summary,
      sermonId: cur.sermon_id,
      targetId: slideId,
      before: { slides: before.map(pickCols) },
      after: { slides_hash: slidesHash(after) },
    });
    const n = after.findIndex((r) => r.id === slideId) + 1;
    return { change_id: changeId, slide_number: n, changed: Object.keys(f), slides_hash: slidesHash(after) };
  });
}

export function pickCols(r: Row) {
  return Object.fromEntries(SLIDE_COLS.map((c) => [c, c === "created_at" || c === "updated_at" ? iso(r[c]) : r[c] ?? null]));
}

/** Used by undo_change: put a sermon's slides back exactly as logged. */
export async function restoreSlides(t: T, sermonId: string, rows: Row[]) {
  await t`DELETE FROM workspace_slides WHERE sermon_id = ${sermonId} AND owner_user_id = ${owner()}`;
  for (const r of rows) {
    const row = Object.fromEntries(SLIDE_COLS.filter((c) => c !== "updated_at").map((c) => [c, r[c] ?? null]));
    row.owner_user_id = owner();
    row.sermon_id = sermonId;
    await t`INSERT INTO workspace_slides ${t(row as any)}`;
  }
}

export { loadSlides };

const slideItemSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Existing slide id; omit for a new slide" },
    type: { type: "string", enum: [...SLIDE_TYPES] },
    title: { type: ["string", "null"] },
    body: { type: ["string", "null"] },
    notes: { type: ["string", "null"], description: "Speaker notes" },
    anchor_paragraph: { type: ["integer", "null"], description: "Manuscript paragraph number (0-based, as in get_sermon numbered_paragraphs) where this slide advances" },
    image_resource_id: { type: ["string", "null"] },
    marker_description: { type: ["string", "null"] },
  },
};

export function slideTools(ctx: Ctx): ToolDef[] {
  return [
    {
      name: "get_slides",
      title: "Get slides",
      description:
        "The slide list for a sermon, in order, as the app uses it to build the Sunday .pptx: number, id, type, title, body, speaker notes, which manuscript paragraph each slide advances on (exact/moved/stranded), image resource, plus the <SLIDE #N – …> markers found in the manuscript and slides_hash for edits. Omit sermon_id for the next Sunday's sermon.",
      inputSchema: { type: "object", properties: { sermon_id: { type: "string" } } },
      run: getSlides,
    },
    {
      name: "set_slides",
      title: "Rewrite the slide list",
      description:
        "Replace a sermon's slide list with an approved new version, in order. Existing slides keep their id (send only the fields that change); new slides have no id; existing slides left out are removed (needs confirm_removals: true). Needs expected_slides_hash from get_slides. The whole previous list is logged so undo_change restores it exactly. Only after Todd approves.",
      readOnly: false,
      destructive: true,
      inputSchema: {
        type: "object",
        required: ["sermon_id", "slides", "expected_slides_hash", "change_summary"],
        properties: {
          sermon_id: { type: "string" },
          expected_slides_hash: { type: "string" },
          change_summary: { type: "string" },
          confirm_removals: { type: "boolean", default: false },
          slides: { type: "array", items: slideItemSchema },
        },
      },
      run: (a) => setSlides(a, ctx),
    },
    {
      name: "edit_slide",
      title: "Edit one slide",
      description: "Change fields on one slide (type, title, body, notes, anchor_paragraph, image_resource_id). Logged and undoable. Only after Todd approves.",
      readOnly: false,
      inputSchema: {
        type: "object",
        required: ["slide_id", "change_summary"],
        properties: { slide_id: { type: "string" }, change_summary: { type: "string" }, ...slideItemSchema.properties, id: undefined },
      },
      run: (a) => editSlide(a, ctx),
    },
  ];
}
