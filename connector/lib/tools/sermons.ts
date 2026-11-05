// Sermons, manuscripts, revisions and the upcoming-Sunday lookup.

import crypto from "node:crypto";
import { sql, owner, appBase } from "../db";
import type { ToolDef } from "../protocol";
import {
  type Ctx,
  applyEdits,
  bool,
  centralToday,
  date,
  formatRanges,
  iso,
  logChange,
  num,
  numberedParagraphs,
  overlaps,
  parseEdits,
  ranges,
  requireWrite,
  slideMarkers,
  str,
  summarize,
  text,
  uuid,
  wordCount,
} from "./util";

export const manuscriptHash = (t: string | null | undefined) =>
  crypto.createHash("sha256").update(t ?? "").digest("hex").slice(0, 16);

export const sermonUrl = (id: string) => `${appBase()}/sermons/${id}`;

type Row = Record<string, any>;

export async function loadSermon(id: string): Promise<Row> {
  const [s] = await sql()`SELECT * FROM sermons WHERE id = ${id} AND owner_user_id = ${owner()}`;
  if (!s) throw new Error(`No sermon with id ${id}`);
  return s;
}

const like = (w: string) => `%${w.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

/** Saves the sermon's current editable state to Past Versions. */
export async function snapshotRevision(tx: ReturnType<typeof sql>, s: Row, label: string): Promise<string> {
  const [r] = await tx`
    INSERT INTO sermon_revisions (sermon_id, owner_user_id, snapshot_title, snapshot_manuscript_text,
      snapshot_scripture_reference, snapshot_theme, snapshot_notes, label)
    VALUES (${s.id}, ${owner()}, ${s.title ?? null}, ${s.manuscript_text ?? null}, ${s.scripture_reference ?? null},
      ${s.theme ?? null}, ${s.notes ?? null}, ${label.slice(0, 200)})
    RETURNING id`;
  return String(r.id);
}

function lockedError(s: Row) {
  return new Error(
    `"${s.title ?? "This sermon"}" has a locked manuscript (locked ${iso(s.manuscript_locked_at)?.slice(0, 10) ?? ""}). Unlock it in the app's Workspace first if Todd wants it changed.`,
  );
}

// ─── upcoming Sundays ────────────────────────────────────────────────────────

async function upcoming(weeks: number) {
  const today = centralToday();
  const plans = await sql()`
    SELECT service_date, theme, scripture_reference, sermon_topic, notes, liturgical_season,
           lectionary_year, lectionary_designation, selected_sermon_id, sermon_from_scratch
    FROM worship_plans WHERE service_date >= ${today}
    ORDER BY service_date LIMIT ${weeks}`;
  const ids = plans.map((p) => p.selected_sermon_id).filter(Boolean);
  const sermons = ids.length
    ? await sql()`
        SELECT s.id, s.title, s.scripture_reference, s.theme, s.updated_at, s.manuscript_locked,
               length(coalesce(s.manuscript_text, '')) AS chars,
               (SELECT count(*)::int FROM workspace_slides w WHERE w.sermon_id = s.id) AS slide_count,
               (SELECT coalesce(json_agg(json_build_object('id', l.id, 'title', l.title, 'used_at', l.used_at)), '[]'::json)
                  FROM sermon_liturgy_links k JOIN sermon_liturgies l ON l.id = k.liturgy_id
                  WHERE k.sermon_id = s.id AND k.approved) AS liturgies
        FROM sermons s WHERE s.id IN ${sql()(ids)} AND s.owner_user_id = ${owner()}`
    : [];
  const byId = new Map(sermons.map((s) => [s.id, s]));
  const out = plans.map((p) => {
    const s = p.selected_sermon_id ? byId.get(p.selected_sermon_id) : null;
    return {
      service_date: p.service_date,
      liturgical_season: p.liturgical_season ?? null,
      lectionary: [p.lectionary_year, p.lectionary_designation].filter(Boolean).join(" ") || null,
      theme: p.theme ?? null,
      scripture: p.scripture_reference ?? null,
      sermon_topic: p.sermon_topic ?? null,
      notes: p.notes ?? null,
      sermon: s
        ? {
            id: s.id,
            title: s.title,
            scripture: s.scripture_reference,
            theme: s.theme,
            words_approx: Math.round(Number(s.chars) / 5.7),
            slide_count: s.slide_count,
            manuscript_locked: !!s.manuscript_locked,
            updated_at: iso(s.updated_at),
            liturgies: typeof s.liturgies === "string" ? JSON.parse(s.liturgies) : s.liturgies,
            app_url: sermonUrl(s.id),
          }
        : null,
      note: s ? undefined : p.sermon_from_scratch ? "Planned as a new sermon, not yet linked to one in the archive." : "No sermon linked to this week yet.",
    };
  });
  let recent: unknown[] = [];
  if (!out.some((w) => w.sermon)) {
    recent = (
      await sql()`SELECT id, title, scripture_reference, updated_at FROM sermons
                  WHERE owner_user_id = ${owner()} ORDER BY updated_at DESC LIMIT 5`
    ).map((s) => ({ id: s.id, title: s.title, scripture: s.scripture_reference, updated_at: iso(s.updated_at) }));
  }
  return { today, weeks: out, recently_edited_sermons: recent.length ? recent : undefined };
}

// ─── search ──────────────────────────────────────────────────────────────────

async function searchSermons(a: Record<string, unknown>) {
  const q = (str(a, "q", 200) ?? "").toLowerCase();
  const words = q.split(/\s+/).filter((w) => w.length > 0).slice(0, 8);
  const scripture = str(a, "scripture", 200);
  const from = date(a, "preached_from");
  const to = date(a, "preached_to");
  const location = str(a, "location", 100);
  const includeEulogies = bool(a, "include_eulogies", false);
  const limit = num(a, "limit", 25, 1, 200)!;
  const s = sql();

  const cond = words.reduce(
    (acc, w) =>
      s`${acc} AND concat_ws(' ', title, scripture_reference, theme, notes, major_stories, manuscript_text,
                     array_to_string(previous_titles, ' ')) ILIKE ${like(w)}`,
    s``,
  );
  const rows = await s`
    SELECT id, title, scripture_reference, theme, preached_at, strength, lectionary_year, is_eulogy,
           previous_titles, updated_at, length(coalesce(manuscript_text, '')) AS chars
    FROM sermons WHERE owner_user_id = ${owner()} ${includeEulogies ? s`` : s`AND NOT coalesce(is_eulogy, false)`} ${cond}`;

  const preachings = await s`
    SELECT sermon_id, preached_at, location, title_used FROM preachings
    WHERE owner_user_id = ${owner()} ORDER BY preached_at DESC NULLS LAST`;
  const pBy = new Map<string, Row[]>();
  for (const p of preachings) {
    const l = pBy.get(p.sermon_id) ?? [];
    l.push(p);
    pBy.set(p.sermon_id, l);
  }

  let recs = rows.map((r) => {
    const ps = pBy.get(r.id) ?? [];
    const dates = [r.preached_at, ...ps.map((p) => p.preached_at)].filter(Boolean).sort().reverse();
    return { r, ps, last: (dates[0] as string | undefined) ?? null, rs: ranges(r.scripture_reference) };
  });
  if (scripture) {
    const want = ranges(scripture);
    if (!want.length) throw new Error(`Couldn't read "${scripture}" as a scripture reference`);
    recs = recs.filter((x) => overlaps(x.rs, want));
  }
  if (location) {
    const l = location.toLowerCase();
    recs = recs.filter((x) => x.ps.some((p) => (p.location ?? "").toLowerCase().includes(l)));
  }
  if (from || to) {
    recs = recs.filter((x) => {
      const ds = [x.r.preached_at, ...x.ps.map((p) => p.preached_at)].filter(Boolean) as string[];
      return ds.some((d) => (!from || d >= from) && (!to || d <= to));
    });
  }
  recs.sort((a, b) => (b.last ?? "").localeCompare(a.last ?? "") || String(a.r.title).localeCompare(String(b.r.title)));
  return {
    matched: recs.length,
    returned: Math.min(limit, recs.length),
    sermons: recs.slice(0, limit).map((x) => ({
      id: x.r.id,
      title: x.r.title,
      scripture: x.r.scripture_reference,
      theme: x.r.theme,
      strength: x.r.strength ?? null,
      lectionary_year: x.r.lectionary_year ?? null,
      eulogy: x.r.is_eulogy || undefined,
      previous_titles: x.r.previous_titles?.length ? x.r.previous_titles : undefined,
      words_approx: Math.round(Number(x.r.chars) / 5.7),
      last_preached: x.last,
      preached: x.ps.slice(0, 6).map((p) => [p.preached_at, p.location].filter(Boolean).join(" @ ")),
    })),
  };
}

// ─── one sermon ──────────────────────────────────────────────────────────────

async function getSermon(a: Record<string, unknown>) {
  const id = uuid(a, "sermon_id")!;
  const withManuscript = bool(a, "include_manuscript", true);
  const numbered = bool(a, "numbered_paragraphs", false);
  const s = await loadSermon(id);
  const db = sql();
  const [preachings, resources, liturgies, stashed, slides, docs, weeks, revisions] = await Promise.all([
    db`SELECT preached_at, location, title_used, series, notes, is_at_our_church FROM preachings
       WHERE sermon_id = ${id} ORDER BY preached_at DESC NULLS LAST`,
    db`SELECT r.id, r.resource_type, r.title, r.content, sr.used_notes FROM sermon_resources sr
       JOIN resources r ON r.id = sr.resource_id WHERE sr.sermon_id = ${id} AND sr.owner_user_id = ${owner()}`,
    db`SELECT l.id, l.title, l.used_at, l.used_location, k.link_kind, k.approved FROM sermon_liturgy_links k
       JOIN sermon_liturgies l ON l.id = k.liturgy_id WHERE k.sermon_id = ${id} AND k.owner_user_id = ${owner()}
       ORDER BY l.used_at DESC NULLS LAST`,
    db`SELECT id, title, body, source, used_at FROM sermon_stashed_blocks WHERE sermon_id = ${id} ORDER BY created_at`,
    db`SELECT count(*)::int AS n FROM workspace_slides WHERE sermon_id = ${id}`,
    db`SELECT id, title, kind, page_count, length(coalesce(extracted_text, '')) AS chars FROM sermon_background_docs
       WHERE sermon_id = ${id} AND owner_user_id = ${owner()} ORDER BY created_at`,
    db`SELECT service_date FROM worship_plans WHERE selected_sermon_id = ${id} AND service_date >= ${centralToday()} ORDER BY service_date`,
    db`SELECT count(*)::int AS n FROM sermon_revisions WHERE sermon_id = ${id}`,
  ]);
  const manuscript = s.manuscript_text ?? "";
  return {
    id: s.id,
    title: s.title,
    previous_titles: s.previous_titles?.length ? s.previous_titles : undefined,
    scripture: s.scripture_reference,
    scripture_normalized: formatRanges(ranges(s.scripture_reference)),
    theme: s.theme,
    liturgy_theme: s.liturgy_theme ?? null,
    lectionary_year: s.lectionary_year ?? null,
    strength: s.strength ?? null,
    timeless: s.timeless ?? null,
    major_stories: s.major_stories ?? null,
    notes: s.notes ?? null,
    eulogy: s.is_eulogy ? { deceased_name: s.deceased_name ?? null, outline: s.eulogy_outline ?? null } : undefined,
    manuscript_locked: !!s.manuscript_locked,
    updated_at: iso(s.updated_at),
    manuscript_hash: manuscriptHash(manuscript),
    word_count: wordCount(manuscript),
    paragraph_count: manuscript ? manuscript.split(/\n[ \t]*\n+/).filter((p: string) => p.trim()).length : 0,
    slide_markers_in_manuscript: slideMarkers(manuscript).length,
    slide_rows: slides[0]?.n ?? 0,
    revisions_saved: revisions[0]?.n ?? 0,
    upcoming_weeks: weeks.map((w) => w.service_date),
    preachings: preachings.map((p) => ({ ...p, preached_at: p.preached_at })),
    resources_used: resources.map((r) => ({ id: r.id, type: r.resource_type, title: r.title ?? summarize(r.content, 60), notes: r.used_notes ?? undefined })),
    liturgies: liturgies.map((l) => ({ id: l.id, title: l.title, used_at: l.used_at, location: l.used_location, link: l.link_kind, approved: l.approved })),
    stashed_blocks: stashed.map((b) => ({ id: b.id, title: b.title, source: b.source, used: !!b.used_at, text: b.body })),
    background_docs: docs.map((d) => ({ id: d.id, title: d.title, kind: d.kind, pages: d.page_count, chars: Number(d.chars) })),
    app_url: sermonUrl(s.id),
    manuscript: withManuscript ? (numbered ? numberedParagraphs(manuscript) : manuscript) : undefined,
    manuscript_note: withManuscript && numbered ? "[¶n] prefixes are paragraph numbers for reference only — they are not in the stored text, so leave them out of update_manuscript find text." : undefined,
  };
}

// ─── revisions ───────────────────────────────────────────────────────────────

async function listRevisions(a: Record<string, unknown>) {
  const id = uuid(a, "sermon_id")!;
  await loadSermon(id);
  const rows = await sql()`
    SELECT id, label, taken_at, snapshot_title, length(coalesce(snapshot_manuscript_text, '')) AS chars
    FROM sermon_revisions WHERE sermon_id = ${id} ORDER BY taken_at DESC LIMIT 100`;
  return rows.map((r) => ({ id: r.id, label: r.label, taken_at: iso(r.taken_at), title: r.snapshot_title, words_approx: Math.round(Number(r.chars) / 5.7) }));
}

async function getRevision(a: Record<string, unknown>) {
  const id = uuid(a, "revision_id")!;
  const [r] = await sql()`
    SELECT r.* FROM sermon_revisions r JOIN sermons s ON s.id = r.sermon_id
    WHERE r.id = ${id} AND s.owner_user_id = ${owner()}`;
  if (!r) throw new Error(`No revision with id ${id}`);
  return {
    id: r.id,
    sermon_id: r.sermon_id,
    label: r.label,
    taken_at: iso(r.taken_at),
    title: r.snapshot_title,
    scripture: r.snapshot_scripture_reference,
    theme: r.snapshot_theme,
    notes: r.snapshot_notes,
    manuscript: r.snapshot_manuscript_text,
  };
}

// ─── writes ──────────────────────────────────────────────────────────────────

async function updateManuscript(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const id = uuid(a, "sermon_id")!;
  const expected = str(a, "expected_manuscript_hash", 40);
  const summary = str(a, "change_summary", 300);
  if (!summary) throw new Error("change_summary is required (one line saying what Todd approved)");
  const edits = parseEdits(a);
  const full = text(a, "new_manuscript");
  if (!edits && full == null) throw new Error("Give either edits (preferred) or new_manuscript");
  if (edits && full != null) throw new Error("Give edits or new_manuscript, not both");

  return sql().begin(async (tx) => {
    const t = tx as unknown as ReturnType<typeof sql>;
    const [s] = await t`SELECT * FROM sermons WHERE id = ${id} AND owner_user_id = ${owner()} FOR UPDATE`;
    if (!s) throw new Error(`No sermon with id ${id}`);
    if (s.manuscript_locked) throw lockedError(s);
    const before = s.manuscript_text ?? "";
    if (expected && expected !== manuscriptHash(before))
      throw new Error("The manuscript has changed since you last read it (maybe Todd edited it in the app). Read it again with get_sermon and redo the edits on the current text.");
    if (!expected && full != null)
      throw new Error("Replacing the whole manuscript needs expected_manuscript_hash from get_sermon, so Todd's newer edits can't be overwritten.");
    const after = edits ? applyEdits(before, edits) : full!;
    if (after === before) return { changed: false, note: "No difference from the current manuscript; nothing saved." };

    const revisionId = await snapshotRevision(t, s, `Before Claude: ${summary}`.slice(0, 200));
    const [u] = await t`UPDATE sermons SET manuscript_text = ${after} WHERE id = ${id} RETURNING updated_at`;
    const changeId = await logChange(t, ctx, {
      kind: "manuscript",
      tool: "update_manuscript",
      summary,
      sermonId: id,
      targetId: id,
      before: { manuscript_text: before },
      after: { manuscript_hash: manuscriptHash(after) },
      revisionId,
    });
    return {
      changed: true,
      change_id: changeId,
      saved_previous_version_as: revisionId,
      edits_applied: edits?.length ?? undefined,
      words_before: wordCount(before),
      words_after: wordCount(after),
      manuscript_hash: manuscriptHash(after),
      updated_at: iso(u.updated_at),
      note: "Saved. The previous text is in the app's Past Versions; undo_change with this change_id puts it back. If the Workspace is open in a browser, Todd should reload it before typing so the old text doesn't autosave over this.",
    };
  });
}

async function restoreRevision(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const revId = uuid(a, "revision_id")!;
  const alsoDetails = bool(a, "also_restore_title_and_details", false);
  return sql().begin(async (tx) => {
    const t = tx as unknown as ReturnType<typeof sql>;
    const [r] = await t`SELECT r.* FROM sermon_revisions r JOIN sermons s ON s.id = r.sermon_id
                        WHERE r.id = ${revId} AND s.owner_user_id = ${owner()}`;
    if (!r) throw new Error(`No revision with id ${revId}`);
    const [s] = await t`SELECT * FROM sermons WHERE id = ${r.sermon_id} FOR UPDATE`;
    if (s.manuscript_locked) throw lockedError(s);
    const label = `Before restoring "${r.label ?? iso(r.taken_at)?.slice(0, 10)}" (Claude)`;
    const snap = await snapshotRevision(t, s, label);
    if (alsoDetails) {
      await t`UPDATE sermons SET manuscript_text = ${r.snapshot_manuscript_text}, title = ${r.snapshot_title},
                scripture_reference = ${r.snapshot_scripture_reference}, theme = ${r.snapshot_theme}, notes = ${r.snapshot_notes}
              WHERE id = ${s.id}`;
    } else {
      await t`UPDATE sermons SET manuscript_text = ${r.snapshot_manuscript_text} WHERE id = ${s.id}`;
    }
    const changeId = await logChange(t, ctx, {
      kind: alsoDetails ? "sermon_details" : "manuscript",
      tool: "restore_revision",
      summary: `Restored version "${r.label ?? revId}"`,
      sermonId: s.id,
      targetId: s.id,
      before: alsoDetails
        ? { manuscript_text: s.manuscript_text, title: s.title, scripture_reference: s.scripture_reference, theme: s.theme, notes: s.notes }
        : { manuscript_text: s.manuscript_text },
      revisionId: snap,
    });
    return { restored: true, change_id: changeId, saved_previous_version_as: snap };
  });
}

const DETAIL_FIELDS = ["title", "scripture_reference", "theme", "liturgy_theme", "notes", "lectionary_year", "major_stories", "timeless", "strength"] as const;

async function updateDetails(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const id = uuid(a, "sermon_id")!;
  const patch: Record<string, unknown> = {};
  for (const f of DETAIL_FIELDS) {
    if (a[f] === undefined) continue;
    if (f === "strength") patch[f] = num(a, f, null, 1, 10);
    else patch[f] = text(a, f, 20_000)?.trim() || null;
  }
  if (!Object.keys(patch).length) throw new Error(`Nothing to change. Fields: ${DETAIL_FIELDS.join(", ")}`);
  return sql().begin(async (tx) => {
    const t = tx as unknown as ReturnType<typeof sql>;
    const [s] = await t`SELECT * FROM sermons WHERE id = ${id} AND owner_user_id = ${owner()} FOR UPDATE`;
    if (!s) throw new Error(`No sermon with id ${id}`);
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, s[k] ?? null]));
    // Keep the old title findable, the way the app's merge does.
    const prev: string[] = s.previous_titles ?? [];
    const keepTitle = patch.title && s.title && patch.title !== s.title && !prev.includes(s.title);
    await t`UPDATE sermons SET ${t(patch as any)} ${keepTitle ? t`, previous_titles = array_append(previous_titles, ${s.title})` : t``} WHERE id = ${id}`;
    const changeId = await logChange(t, ctx, {
      kind: "sermon_details",
      tool: "update_sermon_details",
      summary: `Updated ${Object.keys(patch).join(", ")}`,
      sermonId: id,
      targetId: id,
      before,
      after: patch,
    });
    return { changed: Object.keys(patch), change_id: changeId };
  });
}

// ─── tool list ───────────────────────────────────────────────────────────────

export function sermonTools(ctx: Ctx): ToolDef[] {
  return [
    {
      name: "get_upcoming_sundays",
      title: "Upcoming Sundays",
      description:
        "The next worship weeks from Todd's worship plan (today onward, US Central): date, season, lectionary, theme, scripture, and the sermon linked to each week with its slide count and liturgies. Start here for 'this Sunday' / 'next Sunday'.",
      inputSchema: { type: "object", properties: { weeks: { type: "integer", minimum: 1, maximum: 12, default: 2 } } },
      run: (a) => upcoming(num(a, "weeks", 2, 1, 12)!),
    },
    {
      name: "search_sermons",
      title: "Search sermons",
      description:
        "Search Todd's sermon archive. q matches every word across title, scripture, theme, notes, major stories, previous titles and the manuscript. scripture is a verse-overlap match ('Phil 2' finds 'Philippians 2:5-11'). Also filter by preached date range and location (from preaching history). Returns compact rows, most recently preached first.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string" },
          scripture: { type: "string" },
          preached_from: { type: "string", description: "YYYY-MM-DD" },
          preached_to: { type: "string", description: "YYYY-MM-DD" },
          location: { type: "string", description: "church/place name, partial match" },
          include_eulogies: { type: "boolean", default: false },
          limit: { type: "integer", default: 25, maximum: 200 },
        },
      },
      run: searchSermons,
    },
    {
      name: "get_sermon",
      title: "Get a sermon",
      description:
        "One sermon in full: details, manuscript, manuscript_hash (pass to update_manuscript), lock state, preaching history, resources used, linked liturgies, stashed blocks, background docs and upcoming weeks it's planned for. Set numbered_paragraphs for feedback that cites paragraphs.",
      inputSchema: {
        type: "object",
        required: ["sermon_id"],
        properties: {
          sermon_id: { type: "string" },
          include_manuscript: { type: "boolean", default: true },
          numbered_paragraphs: { type: "boolean", default: false },
        },
      },
      run: getSermon,
    },
    {
      name: "list_revisions",
      title: "List past versions",
      description: "Saved past versions of a sermon (the app's Past Versions panel), newest first.",
      inputSchema: { type: "object", required: ["sermon_id"], properties: { sermon_id: { type: "string" } } },
      run: listRevisions,
    },
    {
      name: "get_revision",
      title: "Get a past version",
      description: "The full text of one saved past version.",
      inputSchema: { type: "object", required: ["revision_id"], properties: { revision_id: { type: "string" } } },
      run: getRevision,
    },
    {
      name: "update_manuscript",
      title: "Change a manuscript",
      description:
        "Write Todd-approved changes into a sermon's manuscript in the app. Use only after Todd approves the specific changes in chat. Preferred: edits = [{find, replace}], where each find is copied exactly from the current manuscript and occurs once (all-or-nothing). Or new_manuscript for a full replacement (requires expected_manuscript_hash). Always pass expected_manuscript_hash from get_sermon. The current text is saved to Past Versions first; refused if the manuscript is locked.",
      readOnly: false,
      destructive: true,
      inputSchema: {
        type: "object",
        required: ["sermon_id", "change_summary"],
        properties: {
          sermon_id: { type: "string" },
          change_summary: { type: "string", description: "One line: what Todd approved, e.g. 'Tightened intro; new ending illustration'" },
          expected_manuscript_hash: { type: "string" },
          edits: {
            type: "array",
            items: { type: "object", required: ["find", "replace"], properties: { find: { type: "string" }, replace: { type: "string" } } },
          },
          new_manuscript: { type: "string" },
        },
      },
      run: (a) => updateManuscript(a, ctx),
    },
    {
      name: "restore_revision",
      title: "Restore a past version",
      description:
        "Put a saved past version's manuscript back (optionally its title/scripture/theme/notes too). The current text is saved as a new past version first. Only when Todd asks.",
      readOnly: false,
      destructive: true,
      inputSchema: {
        type: "object",
        required: ["revision_id"],
        properties: { revision_id: { type: "string" }, also_restore_title_and_details: { type: "boolean", default: false } },
      },
      run: (a) => restoreRevision(a, ctx),
    },
    {
      name: "update_sermon_details",
      title: "Change sermon details",
      description: `Change a sermon's details (not the manuscript): ${DETAIL_FIELDS.join(", ")}. A replaced title is kept in previous_titles. Logged and undoable. Only after Todd approves.`,
      readOnly: false,
      inputSchema: {
        type: "object",
        required: ["sermon_id"],
        properties: {
          sermon_id: { type: "string" },
          ...Object.fromEntries(DETAIL_FIELDS.map((f) => [f, f === "strength" ? { type: "integer", minimum: 1, maximum: 10 } : { type: "string" }])),
        },
      },
      run: (a) => updateDetails(a, ctx),
    },
  ];
}

