// The resource library (replaces the read-only resources-feed function).

import { sql, owner, appBase } from "../db";
import type { ToolDef } from "../protocol";
import { loadSermon } from "./sermons";
import { type Ctx, bool, formatRanges, iso, logChange, num, overlaps, ranges, requireWrite, str, strList, summarize, text, uuid, uuids } from "./util";

export const RESOURCE_TYPES = ["story", "quote", "illustration", "joke", "note", "photo", "exegesis"] as const;
type Row = Record<string, any>;

const resourceUrl = (id: string) => `${appBase()}/resources/${id}`;

async function loadAll() {
  const rows = await sql()`
    SELECT id, resource_type, title, content, source, source_url, themes, scripture_refs, tone, notes,
           created_at, original_created_at, auto_generated, auto_source_label
    FROM resources WHERE owner_user_id = ${owner()} ORDER BY created_at`;
  const used = await sql()`
    SELECT sr.resource_id, sr.used_notes, s.id AS sermon_id, s.title, s.scripture_reference, s.preached_at
    FROM sermon_resources sr JOIN sermons s ON s.id = sr.sermon_id WHERE sr.owner_user_id = ${owner()}`;
  const by = new Map<string, Row[]>();
  for (const u of used) {
    const l = by.get(u.resource_id) ?? [];
    l.push({ sermon_id: u.sermon_id, title: u.title, scripture: u.scripture_reference, preached_at: u.preached_at, notes: u.used_notes ?? undefined });
    by.set(u.resource_id, l);
  }
  return rows.map((r) => ({ r, rs: ranges(r.scripture_refs), used: by.get(r.id) ?? [] }));
}

function shape(x: { r: Row; rs: ReturnType<typeof ranges>; used: Row[] }, full: boolean) {
  const r = x.r;
  const out: Record<string, unknown> = {
    id: r.id,
    title: r.title ?? summarize(r.content, 60),
    type: r.resource_type,
    source: r.source ?? r.auto_source_label ?? null,
    source_url: r.source_url ?? undefined,
    date: (iso(r.original_created_at) ?? iso(r.created_at) ?? "").slice(0, 10) || null,
    scripture: formatRanges(x.rs),
    themes: r.themes ?? [],
    tone: r.tone ?? undefined,
    used_in_count: x.used.length,
  };
  if (full) {
    out.content = r.content;
    out.notes = r.notes ?? undefined;
    out.used_in = x.used;
    out.app_url = resourceUrl(r.id);
  } else {
    out.summary = summarize(r.content);
  }
  return out;
}

function facets(recs: { r: Row; rs: ReturnType<typeof ranges> }[]) {
  const types: Record<string, number> = {};
  const themes: Record<string, number> = {};
  const books: Record<string, number> = {};
  for (const { r, rs } of recs) {
    types[r.resource_type] = (types[r.resource_type] ?? 0) + 1;
    for (const t of r.themes ?? []) themes[t] = (themes[t] ?? 0) + 1;
    for (const b of new Set(rs.map((g) => g.book))) books[b] = (books[b] ?? 0) + 1;
  }
  const top = (o: Record<string, number>, n: number) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));
  return { types: top(types, 20), themes: top(themes, 80), books: top(books, 70) };
}

async function searchResources(a: Record<string, unknown>) {
  let recs = await loadAll();
  const total = recs.length;
  const types = strList(a, "type").map((s) => s.toLowerCase());
  const themes = strList(a, "theme").map((s) => s.toLowerCase());
  const scripture = str(a, "scripture", 200);
  const exclude = str(a, "exclude_scripture", 200);
  const q = (str(a, "q", 200) ?? "").toLowerCase();
  const unused = bool(a, "unused", false);
  const full = bool(a, "full", false);
  const limit = num(a, "limit", 40, 1, 300)!;
  const offset = num(a, "offset", 0, 0, 100_000)!;
  const filtered = !!(types.length || themes.length || scripture || exclude || q || unused);

  if (types.length) recs = recs.filter((x) => types.includes(x.r.resource_type));
  if (themes.length) recs = recs.filter((x) => (x.r.themes ?? []).some((t: string) => themes.includes(t.toLowerCase())));
  if (scripture) {
    const want = ranges(scripture);
    if (!want.length) throw new Error(`Couldn't read "${scripture}" as a scripture reference`);
    recs = recs.filter((x) => overlaps(x.rs, want));
  }
  if (exclude) {
    const avoid = ranges(exclude);
    recs = recs.filter((x) => !overlaps(x.rs, avoid));
  }
  if (unused) recs = recs.filter((x) => x.used.length === 0);
  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    recs = recs.filter((x) => {
      const hay = [x.r.title, x.r.content, x.r.source, x.r.notes, x.r.tone, (x.r.themes ?? []).join(" "), x.r.scripture_refs].join(" \n ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  return {
    total_in_library: total,
    matched: recs.length,
    offset,
    returned: Math.min(limit, Math.max(0, recs.length - offset)),
    facets: filtered ? undefined : facets(recs),
    resources: recs.slice(offset, offset + limit).map((x) => shape(x, full)),
  };
}

async function getResources(a: Record<string, unknown>) {
  const ids = uuids(a, "ids", 40);
  if (!ids.length) throw new Error("ids is required");
  const all = await loadAll();
  const found = all.filter((x) => ids.includes(x.r.id));
  return { resources: found.map((x) => shape(x, true)), missing: ids.filter((id) => !found.some((x) => x.r.id === id)) };
}

// ─── writes ──────────────────────────────────────────────────────────────────

const EDITABLE = ["title", "content", "source", "source_url", "themes", "scripture_refs", "tone", "notes", "resource_type"] as const;

function resourceFields(a: Record<string, unknown>) {
  const f: Record<string, unknown> = {};
  for (const k of EDITABLE) {
    if (a[k] === undefined) continue;
    if (k === "themes") f.themes = strList(a, "themes").map((t) => t.toLowerCase());
    else if (k === "resource_type") {
      const v = str(a, k, 30);
      if (!v || !RESOURCE_TYPES.includes(v as never)) throw new Error(`resource_type must be one of ${RESOURCE_TYPES.join(", ")}`);
      f[k] = v;
    } else if (k === "content") {
      const v = text(a, k, 100_000)?.trim();
      if (!v) throw new Error("content can't be empty");
      f[k] = v;
    } else f[k] = text(a, k, 5_000)?.trim() || null;
  }
  return f;
}

async function createResource(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const f = resourceFields(a);
  if (!f.resource_type) throw new Error("resource_type is required");
  if (!f.content) throw new Error("content is required");
  const sermonId = uuid(a, "link_to_sermon_id", false);
  if (sermonId) await loadSermon(sermonId);
  const usedNotes = str(a, "used_notes", 1000);
  return sql().begin(async (tx) => {
    const t = tx as unknown as ReturnType<typeof sql>;
    const row = { themes: [], ...f, owner_user_id: owner(), auto_generated: true, auto_source_label: str(a, "source_label", 200) ?? "Added by Claude" };
    const [r] = await t`INSERT INTO resources ${t(row as any)} RETURNING id`;
    let linkId: string | null = null;
    if (sermonId) {
      const [l] = await t`INSERT INTO sermon_resources (sermon_id, resource_id, owner_user_id, used_notes)
                          VALUES (${sermonId}, ${r.id}, ${owner()}, ${usedNotes}) RETURNING id`;
      linkId = l.id;
    }
    const changeId = await logChange(t, ctx, {
      kind: "resource_create",
      tool: "create_resource",
      summary: `Added ${f.resource_type}: ${String(f.title ?? summarize(String(f.content), 60))}`,
      sermonId,
      targetId: r.id,
      after: { resource_id: r.id, link_id: linkId },
    });
    return { resource_id: r.id, linked_to_sermon: !!linkId, change_id: changeId, app_url: resourceUrl(r.id), note: "Marked as auto-generated in the library so Todd can review it." };
  });
}

async function updateResource(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const id = uuid(a, "resource_id")!;
  const f = resourceFields(a);
  const addThemes = strList(a, "add_themes").map((t) => t.toLowerCase());
  if (!Object.keys(f).length && !addThemes.length) throw new Error(`Nothing to change. Fields: ${EDITABLE.join(", ")}, add_themes`);
  return sql().begin(async (tx) => {
    const t = tx as unknown as ReturnType<typeof sql>;
    const [cur] = await t`SELECT * FROM resources WHERE id = ${id} AND owner_user_id = ${owner()} FOR UPDATE`;
    if (!cur) throw new Error(`No resource with id ${id}`);
    if (addThemes.length) f.themes = [...new Set([...((f.themes as string[]) ?? cur.themes ?? []), ...addThemes])];
    const before = Object.fromEntries(Object.keys(f).map((k) => [k, cur[k] ?? null]));
    await t`UPDATE resources SET ${t(f as any)} WHERE id = ${id}`;
    const changeId = await logChange(t, ctx, {
      kind: "resource_update",
      tool: "update_resource",
      summary: `Updated ${Object.keys(f).join(", ")} on "${cur.title ?? summarize(cur.content, 40)}"`,
      targetId: id,
      before,
      after: f,
    });
    return { changed: Object.keys(f), change_id: changeId };
  });
}

async function linkResource(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const resourceId = uuid(a, "resource_id")!;
  const sermonId = uuid(a, "sermon_id")!;
  const usedNotes = str(a, "used_notes", 1000);
  const s = await loadSermon(sermonId);
  const [r] = await sql()`SELECT id, title, content FROM resources WHERE id = ${resourceId} AND owner_user_id = ${owner()}`;
  if (!r) throw new Error(`No resource with id ${resourceId}`);
  const [already] = await sql()`SELECT id FROM sermon_resources WHERE sermon_id = ${sermonId} AND resource_id = ${resourceId}`;
  if (already) return { linked: true, note: "Already linked; nothing changed." };
  return sql().begin(async (tx) => {
    const t = tx as unknown as ReturnType<typeof sql>;
    const [l] = await t`INSERT INTO sermon_resources (sermon_id, resource_id, owner_user_id, used_notes)
                        VALUES (${sermonId}, ${resourceId}, ${owner()}, ${usedNotes}) RETURNING id`;
    const changeId = await logChange(t, ctx, {
      kind: "resource_link",
      tool: "link_resource_to_sermon",
      summary: `Linked "${r.title ?? summarize(r.content, 40)}" to "${s.title}"`,
      sermonId,
      targetId: l.id,
      after: { link_id: l.id },
    });
    return { linked: true, change_id: changeId };
  });
}

export function resourceTools(ctx: Ctx): ToolDef[] {
  return [
    {
      name: "search_resources",
      title: "Search resources",
      description:
        "Search Todd's resource library (stories, quotes, illustrations, jokes, notes, photos, exegesis). Filters AND together: q (every word must appear), scripture (verse overlap), exclude_scripture, theme (any of), type (any of), unused (never linked to a sermon). Without filters returns facets (types, top themes, books) too. Results have summaries; use get_resources or full=true for the text.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string" },
          scripture: { type: "string" },
          exclude_scripture: { type: "string" },
          theme: { type: "array", items: { type: "string" } },
          type: { type: "array", items: { type: "string", enum: [...RESOURCE_TYPES] } },
          unused: { type: "boolean" },
          full: { type: "boolean", default: false },
          limit: { type: "integer", default: 40, maximum: 300 },
          offset: { type: "integer", default: 0 },
        },
      },
      run: searchResources,
    },
    {
      name: "get_resources",
      title: "Get resources",
      description: "Full text, Todd's private notes, and the sermons each resource was used in.",
      inputSchema: { type: "object", required: ["ids"], properties: { ids: { type: "array", items: { type: "string" } } } },
      run: getResources,
    },
    {
      name: "create_resource",
      title: "Add a resource",
      description:
        "Add a new item to the library (e.g. an illustration found while researching), optionally linked to a sermon. Marked auto-generated so Todd can review it. Only after Todd approves.",
      readOnly: false,
      inputSchema: {
        type: "object",
        required: ["resource_type", "content"],
        properties: {
          resource_type: { type: "string", enum: [...RESOURCE_TYPES] },
          title: { type: "string" },
          content: { type: "string" },
          source: { type: "string", description: "Author/book/article" },
          source_url: { type: "string" },
          themes: { type: "array", items: { type: "string" } },
          scripture_refs: { type: "string" },
          tone: { type: "string" },
          notes: { type: "string" },
          source_label: { type: "string", description: "Short provenance label; default 'Added by Claude'" },
          link_to_sermon_id: { type: "string" },
          used_notes: { type: "string" },
        },
      },
      run: (a) => createResource(a, ctx),
    },
    {
      name: "update_resource",
      title: "Edit a resource",
      description: "Change a resource's tags or text (themes, add_themes, scripture_refs, tone, notes, title, source, content, type). Logged and undoable. Only after Todd approves.",
      readOnly: false,
      inputSchema: {
        type: "object",
        required: ["resource_id"],
        properties: {
          resource_id: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          source: { type: "string" },
          source_url: { type: "string" },
          themes: { type: "array", items: { type: "string" }, description: "Replaces the theme list" },
          add_themes: { type: "array", items: { type: "string" }, description: "Adds to the theme list" },
          scripture_refs: { type: "string" },
          tone: { type: "string" },
          notes: { type: "string" },
          resource_type: { type: "string", enum: [...RESOURCE_TYPES] },
        },
      },
      run: (a) => updateResource(a, ctx),
    },
    {
      name: "link_resource_to_sermon",
      title: "Link a resource to a sermon",
      description: "Record that a resource is used in a sermon (shows on the sermon in the app and counts as 'used'). Only after Todd approves.",
      readOnly: false,
      inputSchema: {
        type: "object",
        required: ["resource_id", "sermon_id"],
        properties: { resource_id: { type: "string" }, sermon_id: { type: "string" }, used_notes: { type: "string" } },
      },
      run: (a) => linkResource(a, ctx),
    },
  ];
}
