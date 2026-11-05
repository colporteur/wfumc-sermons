// Past liturgies: search them, pull matching elements (every Call to
// Worship used in Advent, say), draft new ones linked to a sermon.

import { sql, owner, appBase } from "../db";
import type { ToolDef } from "../protocol";
import { loadSermon } from "./sermons";
import { type Ctx, bool, date, formatRanges, iso, logChange, num, oneOf, overlaps, ranges, requireWrite, str, strList, uuid } from "./util";

// Canonical element keys (sermon_liturgy_sections.section_kind), from the app's worshipElements.js.
export const ELEMENTS: Record<string, string> = {
  prelude: "Prelude",
  announcements: "Announcements",
  welcome: "Welcome",
  call_to_worship: "Call to Worship",
  opening_hymn: "Opening Hymn",
  opening_prayer: "Invocation / Opening Prayer",
  childrens_moment: "Children's Moment",
  anthem: "Anthem / Special Music",
  scripture_reading: "Scripture Reading",
  sermon: "Sermon",
  hymn_of_response: "Hymn of Response",
  affirmation_of_faith: "Affirmation of Faith / Creed",
  congregational_prayer: "Congregational Prayer (= Pastoral Prayer)",
  lords_prayer: "The Lord's Prayer",
  confession: "Confession",
  words_of_assurance: "Words of Assurance",
  passing_of_peace: "Passing of the Peace",
  offering_statement: "Offering Statement",
  offering_music: "Offering Music",
  doxology: "Doxology",
  communion: "Communion / Eucharist",
  closing_hymn: "Closing Hymn",
  benediction: "Benediction",
  postlude: "Postlude",
  other: "Other",
};

export const SEASONS = ["advent", "christmas", "epiphany", "lent", "holy_week", "easter", "pentecost_ordinary"] as const;
type Season = (typeof SEASONS)[number];

function easter(y: number): Date {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(y, month - 1, day));
}

/** Liturgical season for a date (Revised Common Lectionary calendar). */
export function seasonOf(isoDate: string): Season {
  const d = new Date(isoDate + "T00:00:00Z");
  const y = d.getUTCFullYear();
  const day = 86_400_000;
  const xmas = Date.UTC(y, 11, 25);
  const xmasDow = new Date(xmas).getUTCDay();
  const advent1 = xmas - ((xmasDow === 0 ? 7 : xmasDow) + 21) * day;
  const t = d.getTime();
  if (t >= advent1 && t < xmas) return "advent";
  if (t >= xmas || t <= Date.UTC(y, 0, 5)) return "christmas";
  const e = easter(y).getTime();
  const ash = e - 46 * day;
  const palm = e - 7 * day;
  const pentecost = e + 49 * day;
  if (t < ash) return "epiphany";
  if (t < palm) return "lent";
  if (t < e) return "holy_week";
  if (t <= pentecost) return "easter";
  return "pentecost_ordinary";
}

function normSeason(s: string | null | undefined): Season | null {
  if (!s) return null;
  const v = s.toLowerCase();
  if (v.includes("advent")) return "advent";
  if (v.includes("christmas")) return "christmas";
  if (v.includes("epiphany")) return "epiphany";
  if (v.includes("holy")) return "holy_week";
  if (v.includes("lent")) return "lent";
  if (v.includes("easter")) return "easter";
  if (v.includes("pentecost") || v.includes("ordinary")) return "pentecost_ordinary";
  return null;
}

type Row = Record<string, any>;

async function loadLiturgies() {
  const libs = await sql()`
    SELECT id, title, used_at, used_location, scripture_refs, notes, created_at FROM sermon_liturgies
    WHERE owner_user_id = ${owner()} ORDER BY used_at DESC NULLS LAST, created_at DESC`;
  const plans = await sql()`SELECT service_date, liturgical_season FROM worship_plans WHERE liturgical_season IS NOT NULL`;
  const planSeason = new Map(plans.map((p) => [p.service_date, normSeason(p.liturgical_season)]));
  const links = await sql()`
    SELECT k.liturgy_id, s.id, s.title, s.scripture_reference FROM sermon_liturgy_links k JOIN sermons s ON s.id = k.sermon_id
    WHERE k.owner_user_id = ${owner()} AND k.approved`;
  const linkBy = new Map<string, Row[]>();
  for (const k of links) {
    const l = linkBy.get(k.liturgy_id) ?? [];
    l.push({ id: k.id, title: k.title, scripture: k.scripture_reference });
    linkBy.set(k.liturgy_id, l);
  }
  return libs.map((l) => {
    const sermons = linkBy.get(l.id) ?? [];
    const refs = [l.scripture_refs, ...sermons.map((s) => s.scripture)].filter(Boolean).join("; ");
    return {
      l,
      sermons,
      rs: ranges(refs),
      season: l.used_at ? (planSeason.get(l.used_at) ?? seasonOf(l.used_at)) : null,
    };
  });
}

type Lit = Awaited<ReturnType<typeof loadLiturgies>>[number];

function filterLits(lits: Lit[], a: Record<string, unknown>) {
  const scripture = str(a, "scripture", 200);
  const season = oneOf(a, "season", SEASONS, null);
  const from = date(a, "used_from");
  const to = date(a, "used_to");
  const location = str(a, "location", 100)?.toLowerCase();
  let out = lits;
  if (scripture) {
    const want = ranges(scripture);
    if (!want.length) throw new Error(`Couldn't read "${scripture}" as a scripture reference`);
    out = out.filter((x) => overlaps(x.rs, want));
  }
  if (season) out = out.filter((x) => x.season === season || (!x.l.used_at && normSeason(x.l.title) === season));
  if (from) out = out.filter((x) => x.l.used_at && x.l.used_at >= from);
  if (to) out = out.filter((x) => x.l.used_at && x.l.used_at <= to);
  if (location) out = out.filter((x) => (x.l.used_location ?? "").toLowerCase().includes(location));
  return out;
}

async function searchLiturgies(a: Record<string, unknown>) {
  let lits = filterLits(await loadLiturgies(), a);
  const q = (str(a, "q", 200) ?? "").toLowerCase();
  const limit = num(a, "limit", 25, 1, 200)!;
  const ids = lits.map((x) => x.l.id);
  const sections = ids.length
    ? await sql()`SELECT liturgy_id, section_kind, title, body FROM sermon_liturgy_sections
                  WHERE liturgy_id IN ${sql()(ids)} AND NOT is_announcement ORDER BY sort_order`
    : [];
  const secBy = new Map<string, Row[]>();
  for (const s of sections) {
    const l = secBy.get(s.liturgy_id) ?? [];
    l.push(s);
    secBy.set(s.liturgy_id, l);
  }
  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    lits = lits.filter((x) => {
      const hay = [x.l.title, x.l.notes, x.l.scripture_refs, ...(secBy.get(x.l.id) ?? []).map((s) => `${s.title ?? ""} ${s.body}`)].join(" \n ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  return {
    matched: lits.length,
    liturgies: lits.slice(0, limit).map((x) => ({
      id: x.l.id,
      title: x.l.title,
      used_at: x.l.used_at,
      location: x.l.used_location ?? undefined,
      season: x.season ?? undefined,
      scripture: formatRanges(x.rs),
      sermons: x.sermons.map((s) => ({ id: s.id, title: s.title })),
      elements: (secBy.get(x.l.id) ?? []).map((s) => s.section_kind),
    })),
  };
}

async function findSections(a: Record<string, unknown>) {
  const kinds = strList(a, "element");
  for (const k of kinds) if (!ELEMENTS[k]) throw new Error(`Unknown element "${k}". Use one of: ${Object.keys(ELEMENTS).join(", ")}`);
  const q = (str(a, "q", 200) ?? "").toLowerCase();
  const limit = num(a, "limit", 20, 1, 100)!;
  const lits = filterLits(await loadLiturgies(), a);
  if (!lits.length) return { matched: 0, sections: [] };
  const byId = new Map(lits.map((x) => [x.l.id, x]));
  const s = sql();
  const rows = await s`
    SELECT id, liturgy_id, section_kind, title, body FROM sermon_liturgy_sections
    WHERE liturgy_id IN ${s([...byId.keys()])} AND NOT is_announcement
    ${kinds.length ? s`AND section_kind IN ${s(kinds)}` : s``}`;
  let hits: Row[] = [...rows];
  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    hits = hits.filter((r) => words.every((w) => `${r.title ?? ""} ${r.body}`.toLowerCase().includes(w)));
  }
  const order = new Map(lits.map((x, i) => [x.l.id, i]));
  hits.sort((x, y) => (order.get(x.liturgy_id)! - order.get(y.liturgy_id)!));
  return {
    matched: hits.length,
    sections: hits.slice(0, limit).map((r) => {
      const x = byId.get(r.liturgy_id)!;
      return {
        section_id: r.id,
        element: r.section_kind,
        title: r.title ?? undefined,
        text: r.body,
        liturgy: { id: x.l.id, title: x.l.title, used_at: x.l.used_at, season: x.season ?? undefined, sermons: x.sermons.map((s) => s.title) },
      };
    }),
  };
}

async function getLiturgy(a: Record<string, unknown>) {
  const id = uuid(a, "liturgy_id")!;
  const includeAnnouncements = bool(a, "include_announcements", false);
  const [l] = await sql()`SELECT * FROM sermon_liturgies WHERE id = ${id} AND owner_user_id = ${owner()}`;
  if (!l) throw new Error(`No liturgy with id ${id}`);
  const sections = await sql()`SELECT id, section_kind, title, body, sort_order, is_announcement FROM sermon_liturgy_sections
                               WHERE liturgy_id = ${id} ORDER BY sort_order, created_at`;
  const sermons = await sql()`SELECT s.id, s.title, s.scripture_reference, k.link_kind, k.approved FROM sermon_liturgy_links k
                              JOIN sermons s ON s.id = k.sermon_id WHERE k.liturgy_id = ${id}`;
  return {
    id: l.id,
    title: l.title,
    used_at: l.used_at,
    location: l.used_location,
    season: l.used_at ? seasonOf(l.used_at) : null,
    scripture: l.scripture_refs,
    notes: l.notes,
    sermons,
    sections: sections
      .filter((s) => includeAnnouncements || !s.is_announcement)
      .map((s) => ({ id: s.id, element: s.section_kind, title: s.title, text: s.body })),
    app_url: `${appBase()}/liturgies/${l.id}`,
  };
}

async function getInstructions() {
  const rows = await sql()`SELECT element_type, instructions FROM liturgy_element_instructions WHERE owner_user_id = ${owner()}`;
  return {
    elements: ELEMENTS,
    todds_instructions: Object.fromEntries(rows.filter((r) => r.instructions?.trim()).map((r) => [r.element_type, r.instructions])),
  };
}

// ─── writes ──────────────────────────────────────────────────────────────────

type SectionIn = { id?: string; element?: string; title?: string | null; text?: string };

function parseSections(v: unknown, requireText: boolean): SectionIn[] {
  const list = typeof v === "string" ? JSON.parse(v) : v;
  if (!Array.isArray(list)) throw new Error("sections must be a list");
  if (list.length > 60) throw new Error("At most 60 sections");
  return list.map((x: Record<string, unknown>, i: number) => {
    const element = x.element == null ? undefined : String(x.element);
    if (element && !ELEMENTS[element]) throw new Error(`Section ${i + 1}: unknown element "${element}"`);
    const t = x.text == null ? undefined : String(x.text).trim();
    if (requireText && !t) throw new Error(`Section ${i + 1}: text is required`);
    return { id: x.id ? String(x.id) : undefined, element, title: x.title == null ? (x.title as null | undefined) : String(x.title).trim(), text: t };
  });
}

async function createLiturgy(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const title = str(a, "title", 200);
  if (!title) throw new Error("title is required");
  const sections = parseSections(a.sections ?? [], true);
  const sermonId = uuid(a, "sermon_id", false);
  if (sermonId) await loadSermon(sermonId);
  return sql().begin(async (tx) => {
    const t = tx as unknown as ReturnType<typeof sql>;
    const [l] = await t`INSERT INTO sermon_liturgies (owner_user_id, title, scripture_refs, notes, used_at)
                        VALUES (${owner()}, ${title}, ${str(a, "scripture_refs", 300)}, ${str(a, "notes", 5000)}, ${date(a, "used_at")}) RETURNING id`;
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      await t`INSERT INTO sermon_liturgy_sections (liturgy_id, owner_user_id, section_kind, title, body, sort_order)
              VALUES (${l.id}, ${owner()}, ${s.element ?? "other"}, ${s.title ?? ELEMENTS[s.element ?? "other"] ?? null}, ${s.text!}, ${i})`;
    }
    let linkId: string | null = null;
    if (sermonId) {
      const [k] = await t`INSERT INTO sermon_liturgy_links (liturgy_id, sermon_id, owner_user_id, link_kind, confidence, approved)
                          VALUES (${l.id}, ${sermonId}, ${owner()}, 'manual', 'high', true) RETURNING id`;
      linkId = k.id;
    }
    const changeId = await logChange(t, ctx, {
      kind: "liturgy_create",
      tool: "create_liturgy",
      summary: `New liturgy "${title}" (${sections.length} elements)`,
      sermonId,
      targetId: l.id,
      after: { liturgy_id: l.id, link_id: linkId },
    });
    return { liturgy_id: l.id, sections: sections.length, linked_to_sermon: !!linkId, change_id: changeId, app_url: `${appBase()}/liturgies/${l.id}` };
  });
}

const SECTION_COLS = ["id", "liturgy_id", "owner_user_id", "section_kind", "title", "body", "sort_order", "is_announcement", "created_at"] as const;

async function setSections(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const id = uuid(a, "liturgy_id")!;
  const summary = str(a, "change_summary", 300);
  if (!summary) throw new Error("change_summary is required");
  const wanted = parseSections(a.sections, false);
  const confirmRemovals = bool(a, "confirm_removals", false);
  return sql().begin(async (tx) => {
    const t = tx as unknown as ReturnType<typeof sql>;
    const [l] = await t`SELECT id, title FROM sermon_liturgies WHERE id = ${id} AND owner_user_id = ${owner()} FOR UPDATE`;
    if (!l) throw new Error(`No liturgy with id ${id}`);
    const before = await t`SELECT * FROM sermon_liturgy_sections WHERE liturgy_id = ${id} ORDER BY sort_order, created_at`;
    const visible = before.filter((s) => !s.is_announcement);
    const existing = new Map(visible.map((s) => [s.id, s]));
    for (const x of wanted) if (x.id && !existing.has(x.id)) throw new Error(`Section ${x.id} isn't in this liturgy`);
    const keep = new Set(wanted.map((x) => x.id).filter(Boolean));
    const removed = visible.filter((s) => !keep.has(s.id));
    if (removed.length && !confirmRemovals)
      throw new Error(`This would remove ${removed.length} element(s): ${removed.map((s) => s.title ?? s.section_kind).join(", ")}. Call again with confirm_removals: true if Todd approved.`);
    for (let i = 0; i < wanted.length; i++) {
      const x = wanted[i];
      if (x.id) {
        const patch: Record<string, unknown> = { sort_order: i };
        if (x.element !== undefined) patch.section_kind = x.element;
        if (x.title !== undefined) patch.title = x.title || null;
        if (x.text !== undefined) {
          if (!x.text) throw new Error(`Section ${i + 1}: text can't be empty`);
          patch.body = x.text;
        }
        await t`UPDATE sermon_liturgy_sections SET ${t(patch as any)} WHERE id = ${x.id}`;
      } else {
        if (!x.text) throw new Error(`New section ${i + 1}: text is required`);
        const kind = x.element ?? "other";
        await t`INSERT INTO sermon_liturgy_sections (liturgy_id, owner_user_id, section_kind, title, body, sort_order)
                VALUES (${id}, ${owner()}, ${kind}, ${x.title ?? ELEMENTS[kind] ?? null}, ${x.text}, ${i})`;
      }
    }
    if (removed.length) await t`DELETE FROM sermon_liturgy_sections WHERE id IN ${t(removed.map((s) => s.id))}`;
    const changeId = await logChange(t, ctx, {
      kind: "liturgy_sections",
      tool: "set_liturgy_sections",
      summary: `${summary} ("${l.title}")`,
      targetId: id,
      before: { sections: before.map((s) => Object.fromEntries(SECTION_COLS.map((c) => [c, c === "created_at" ? iso(s[c]) : s[c] ?? null]))) },
    });
    return { change_id: changeId, sections: wanted.length, removed: removed.length };
  });
}

export async function restoreSections(t: ReturnType<typeof sql>, liturgyId: string, rows: Row[]) {
  await t`DELETE FROM sermon_liturgy_sections WHERE liturgy_id = ${liturgyId}`;
  for (const r of rows) {
    const row = Object.fromEntries(SECTION_COLS.map((c) => [c, r[c] ?? null]));
    row.owner_user_id = owner();
    row.liturgy_id = liturgyId;
    await t`INSERT INTO sermon_liturgy_sections ${t(row as any)}`;
  }
}

async function linkLiturgy(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const liturgyId = uuid(a, "liturgy_id")!;
  const sermonId = uuid(a, "sermon_id")!;
  const s = await loadSermon(sermonId);
  const [l] = await sql()`SELECT id, title FROM sermon_liturgies WHERE id = ${liturgyId} AND owner_user_id = ${owner()}`;
  if (!l) throw new Error(`No liturgy with id ${liturgyId}`);
  const [already] = await sql()`SELECT id, approved FROM sermon_liturgy_links WHERE liturgy_id = ${liturgyId} AND sermon_id = ${sermonId}`;
  if (already?.approved) return { linked: true, note: "Already linked; nothing changed." };
  return sql().begin(async (tx) => {
    const t = tx as unknown as ReturnType<typeof sql>;
    let linkId: string;
    let before: unknown = undefined;
    if (already) {
      await t`UPDATE sermon_liturgy_links SET approved = true WHERE id = ${already.id}`;
      linkId = already.id;
      before = { approved: false };
    } else {
      const [k] = await t`INSERT INTO sermon_liturgy_links (liturgy_id, sermon_id, owner_user_id, link_kind, confidence, approved)
                          VALUES (${liturgyId}, ${sermonId}, ${owner()}, 'manual', 'high', true) RETURNING id`;
      linkId = k.id;
    }
    const changeId = await logChange(t, ctx, {
      kind: "liturgy_link",
      tool: "link_liturgy_to_sermon",
      summary: `Linked liturgy "${l.title}" to "${s.title}"`,
      sermonId,
      targetId: linkId,
      before,
      after: { link_id: linkId },
    });
    return { linked: true, change_id: changeId };
  });
}

const filterProps = {
  scripture: { type: "string", description: "Verse overlap with the liturgy's own refs or its linked sermons'" },
  season: { type: "string", enum: [...SEASONS] },
  used_from: { type: "string", description: "YYYY-MM-DD" },
  used_to: { type: "string", description: "YYYY-MM-DD" },
  location: { type: "string" },
};

export function liturgyTools(ctx: Ctx): ToolDef[] {
  return [
    {
      name: "search_liturgies",
      title: "Search liturgies",
      description:
        "Search Todd's past liturgies by scripture (overlap with the liturgy or its linked sermons), liturgical season, date used, location, and q (words in titles or element text). Returns each liturgy's date, season, sermons and which elements it has.",
      inputSchema: { type: "object", properties: { q: { type: "string" }, ...filterProps, limit: { type: "integer", default: 25 } } },
      run: searchLiturgies,
    },
    {
      name: "find_liturgy_elements",
      title: "Find past liturgy elements",
      description: `Pull the actual text of past liturgy elements, newest first, e.g. every call_to_worship used in Advent, or confessions for a passage. element keys: ${Object.keys(ELEMENTS).join(", ")}. Combine with scripture/season/date/q filters.`,
      inputSchema: {
        type: "object",
        properties: { element: { type: "array", items: { type: "string", enum: Object.keys(ELEMENTS) } }, q: { type: "string" }, ...filterProps, limit: { type: "integer", default: 20 } },
      },
      run: findSections,
    },
    {
      name: "get_liturgy",
      title: "Get a liturgy",
      description: "One liturgy in order with every element's text, its date, season and linked sermons.",
      inputSchema: { type: "object", required: ["liturgy_id"], properties: { liturgy_id: { type: "string" }, include_announcements: { type: "boolean", default: false } } },
      run: getLiturgy,
    },
    {
      name: "get_liturgy_instructions",
      title: "Liturgy drafting instructions",
      description: "Todd's standing instructions for writing each liturgy element, plus the element vocabulary. Read before drafting liturgy.",
      inputSchema: { type: "object", properties: {} },
      run: getInstructions,
    },
    {
      name: "create_liturgy",
      title: "Create a liturgy",
      description:
        "Save a new liturgy (title + ordered elements), optionally linked to a sermon. Leave used_at empty for a draft. Only after Todd approves the text.",
      readOnly: false,
      inputSchema: {
        type: "object",
        required: ["title", "sections"],
        properties: {
          title: { type: "string" },
          sermon_id: { type: "string" },
          scripture_refs: { type: "string" },
          notes: { type: "string" },
          used_at: { type: "string", description: "YYYY-MM-DD; omit for a draft" },
          sections: {
            type: "array",
            items: { type: "object", required: ["element", "text"], properties: { element: { type: "string", enum: Object.keys(ELEMENTS) }, title: { type: "string" }, text: { type: "string" } } },
          },
        },
      },
      run: (a) => createLiturgy(a, ctx),
    },
    {
      name: "set_liturgy_sections",
      title: "Revise a liturgy",
      description:
        "Replace a liturgy's elements with an approved revision, in order. Existing elements keep their id (send only what changes); new ones have no id; ones left out are removed (needs confirm_removals). Announcements are untouched. The previous version is logged so undo_change restores it.",
      readOnly: false,
      destructive: true,
      inputSchema: {
        type: "object",
        required: ["liturgy_id", "sections", "change_summary"],
        properties: {
          liturgy_id: { type: "string" },
          change_summary: { type: "string" },
          confirm_removals: { type: "boolean", default: false },
          sections: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" }, element: { type: "string", enum: Object.keys(ELEMENTS) }, title: { type: "string" }, text: { type: "string" } } },
          },
        },
      },
      run: (a) => setSections(a, ctx),
    },
    {
      name: "link_liturgy_to_sermon",
      title: "Link a liturgy to a sermon",
      description: "Connect a past or new liturgy to a sermon (or approve a suggested link). Only after Todd approves.",
      readOnly: false,
      inputSchema: { type: "object", required: ["liturgy_id", "sermon_id"], properties: { liturgy_id: { type: "string" }, sermon_id: { type: "string" } } },
      run: (a) => linkLiturgy(a, ctx),
    },
  ];
}

