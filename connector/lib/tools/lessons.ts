// Sunday School (WFUMC SS app): class questions ("topics") and their
// lessons. A topic moves possible_future → picked_for_next → active → past;
// each topic has at most one lesson, an ordered list of {header, body}
// sections plus optional homework.

import crypto from "node:crypto";
import { sql, owner } from "../db";
import type { ToolDef } from "../protocol";
import { type Ctx, applyEdits, bool, centralToday, date, iso, logChange, num, oneOf, requireWrite, str, summarize, text, uuid } from "./util";

type Row = Record<string, any>;
type T = ReturnType<typeof sql>;
type Section = { header: string; body: string };

export const TOPIC_STATUSES = ["possible_future", "picked_for_next", "active", "past"] as const;
const ssBase = () => (process.env.SS_APP_BASE_URL ?? "https://colporteur.github.io/wfumc-ss").replace(/\/$/, "");
const lessonUrl = (topicId: string) => `${ssBase()}/lesson/${topicId}`;
const DEFAULT_CLOSING = "What are your thoughts?";

// ─── same rules as the app's lib/lessons.js ─────────────────────────────────

function legacyToSections(l: Row): Section[] {
  const out: Section[] = [];
  if (l.opening_prompt?.trim()) out.push({ header: "Opening Prompt", body: l.opening_prompt.trim() });
  if (l.pastor_notes?.trim()) out.push({ header: "Pastor's Notes", body: l.pastor_notes });
  if (l.closing_prompt?.trim() && l.closing_prompt.trim() !== DEFAULT_CLOSING) out.push({ header: "Closing Prompt", body: l.closing_prompt.trim() });
  else if (out.length) out.push({ header: "Closing Prompt", body: DEFAULT_CLOSING });
  return out;
}

export function sectionsOf(l: Row | null | undefined): Section[] {
  if (!l) return [];
  const s = typeof l.sections === "string" ? JSON.parse(l.sections) : l.sections;
  if (Array.isArray(s) && s.length) return s.map((x: Row) => ({ header: String(x?.header ?? ""), body: String(x?.body ?? "") }));
  return legacyToSections(l);
}

function normalize(sections: Section[]): Section[] {
  return sections
    .map((s) => ({ header: typeof s?.header === "string" ? s.header.trim() : "", body: typeof s?.body === "string" ? s.body : "" }))
    .filter((s) => s.header || s.body.trim());
}

/** The app mirrors the first three sections into the legacy columns; do the same. */
function legacyMirror(clean: Section[]) {
  const op = clean[0]?.body || null;
  return {
    opening_prompt: op && op.trim() ? op : null,
    pastor_notes: clean[1]?.body || "",
    closing_prompt: clean[2]?.body || DEFAULT_CLOSING,
  };
}

export function lessonHash(l: Row | null): string {
  if (!l) return "none";
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([sectionsOf(l), l.homework_text ?? null, iso(l.homework_expires_at)]))
    .digest("hex")
    .slice(0, 16);
}

/** Sunday class end (9:30 AM Central) on or after a date — the app's homework expiry. */
export function classEndUtc(onOrAfter: string): string {
  const d = new Date(onOrAfter + "T12:00:00Z");
  const add = (7 - d.getUTCDay()) % 7;
  const sunday = new Date(d.getTime() + add * 86_400_000).toISOString().slice(0, 10);
  const probe = new Date(`${sunday}T09:30:00Z`);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" })
    .formatToParts(probe)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT-6";
  const m = off.match(/GMT([+-])(\d+)/);
  const offMin = m ? (m[1] === "-" ? -1 : 1) * parseInt(m[2], 10) * 60 : -360;
  return new Date(probe.getTime() - offMin * 60_000).toISOString();
}

function parseSections(v: unknown): Section[] {
  const list = typeof v === "string" ? JSON.parse(v) : v;
  if (!Array.isArray(list)) throw new Error("sections must be a list of {header, body}");
  if (list.length > 40) throw new Error("At most 40 sections");
  const out = normalize(list as Section[]);
  for (const s of out) if (s.body.length > 50_000) throw new Error(`Section "${s.header}" is too long`);
  return out;
}

const topicRow = (t: Row) => ({
  topic_id: t.id,
  question: t.text,
  status: t.status,
  discussed_on: t.discussed_on ?? undefined,
  picked_by: t.picked_by ?? undefined,
  submitted_by: t.submitted_by_name ?? undefined,
  has_lesson: t.has_lesson ?? undefined,
  sections: t.section_count ?? undefined,
});

async function loadTopic(t: T, id: string, lock = false) {
  const [topic] = lock
    ? await t`SELECT * FROM ss_topics WHERE id = ${id} AND owner_user_id = ${owner()} FOR UPDATE`
    : await t`SELECT * FROM ss_topics WHERE id = ${id} AND owner_user_id = ${owner()}`;
  if (!topic) throw new Error(`No Sunday School topic with id ${id}`);
  return topic;
}

const TOPIC_LIST_COLS = (s: T) => s`
  t.id, t.text, t.status, t.discussed_on, t.submitted_by_name, t.queue_sort, t.created_at,
  m.display_name AS picked_by,
  (l.id IS NOT NULL) AS has_lesson,
  CASE WHEN l.id IS NULL THEN NULL
       WHEN jsonb_array_length(coalesce(l.sections, '[]'::jsonb)) > 0 THEN jsonb_array_length(l.sections)
       WHEN coalesce(l.opening_prompt, '') <> '' OR coalesce(l.pastor_notes, '') <> '' THEN 3 ELSE 0 END AS section_count`;

// ─── read ───────────────────────────────────────────────────────────────────

async function overview(a: Record<string, unknown>) {
  const nFuture = num(a, "future", 10, 0, 100)!;
  const nPast = num(a, "past", 8, 0, 100)!;
  const s = sql();
  const base = s`FROM ss_topics t LEFT JOIN ss_members m ON m.id = t.picked_by_member_id
                 LEFT JOIN ss_lessons l ON l.topic_id = t.id WHERE t.owner_user_id = ${owner()}`;
  const [current, future, past, futureCount, suggestions] = await Promise.all([
    s`SELECT ${TOPIC_LIST_COLS(s)} ${base} AND t.status IN ('active', 'picked_for_next') ORDER BY t.status, t.updated_at DESC`,
    s`SELECT ${TOPIC_LIST_COLS(s)} ${base} AND t.status = 'possible_future' ORDER BY t.queue_sort LIMIT ${nFuture}`,
    s`SELECT ${TOPIC_LIST_COLS(s)} ${base} AND t.status = 'past' ORDER BY t.discussed_on DESC NULLS LAST, t.created_at DESC LIMIT ${nPast}`,
    s`SELECT count(*)::int AS n FROM ss_topics WHERE owner_user_id = ${owner()} AND status = 'possible_future'`,
    s`SELECT text, submitter_name, created_at FROM ss_topic_suggestions WHERE owner_user_id = ${owner()} AND NOT processed ORDER BY created_at`,
  ]);
  const active = current.filter((t) => t.status === "active").map(topicRow);
  const next = current.filter((t) => t.status === "picked_for_next").map(topicRow);
  const queueHead = future[0];
  return {
    today: centralToday(),
    next_sunday: classEndUtc(centralToday()).slice(0, 10),
    active,
    picked_for_next: next,
    next_to_draft: next.find((t) => !t.has_lesson || !t.sections) ?? (queueHead ? topicRow(queueHead) : null),
    queue: { total: futureCount[0]?.n ?? 0, first: future.map(topicRow) },
    recent_past: past.map(topicRow),
    unprocessed_suggestions: suggestions.map((x) => ({ question: x.text, from: x.submitter_name, at: iso(x.created_at) })),
  };
}

async function searchLessons(a: Record<string, unknown>) {
  const q = (str(a, "q", 200) ?? "").toLowerCase();
  const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
  const status = oneOf(a, "status", TOPIC_STATUSES, null);
  const from = date(a, "discussed_from");
  const to = date(a, "discussed_to");
  const withLesson = bool(a, "only_with_lesson", false);
  const limit = num(a, "limit", 25, 1, 200)!;
  const s = sql();
  const rows = await s`
    SELECT t.id, t.text, t.status, t.discussed_on, t.submitted_by_name, t.queue_sort, t.created_at, m.display_name AS picked_by,
           l.id AS lesson_id, l.sections, l.opening_prompt, l.pastor_notes, l.closing_prompt, l.homework_text
    FROM ss_topics t LEFT JOIN ss_members m ON m.id = t.picked_by_member_id LEFT JOIN ss_lessons l ON l.topic_id = t.id
    WHERE t.owner_user_id = ${owner()}
      ${status ? s`AND t.status = ${status}` : s``}
      ${from ? s`AND t.discussed_on >= ${from}` : s``}
      ${to ? s`AND t.discussed_on <= ${to}` : s``}
      ${withLesson ? s`AND l.id IS NOT NULL` : s``}
    ORDER BY t.discussed_on DESC NULLS LAST, t.queue_sort`;
  let recs = rows.map((r) => ({ r, secs: r.lesson_id ? sectionsOf(r) : [] }));
  if (words.length)
    recs = recs.filter((x) => {
      const hay = [x.r.text, x.r.homework_text, ...x.secs.map((z) => `${z.header} ${z.body}`)].join(" \n ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  return {
    matched: recs.length,
    topics: recs.slice(0, limit).map((x) => ({
      ...topicRow({ ...x.r, has_lesson: !!x.r.lesson_id, section_count: x.secs.length }),
      headers: x.secs.length ? x.secs.map((z) => z.header) : undefined,
      preview: x.secs.length ? summarize(x.secs.map((z) => z.body).join(" "), 200) : undefined,
    })),
  };
}

async function getLesson(a: Record<string, unknown>) {
  const topicId = uuid(a, "topic_id")!;
  const s = sql();
  const topic = await loadTopic(s, topicId);
  const [l] = await s`SELECT * FROM ss_lessons WHERE topic_id = ${topicId} AND owner_user_id = ${owner()}`;
  const [m] = topic.picked_by_member_id ? await s`SELECT display_name FROM ss_members WHERE id = ${topic.picked_by_member_id}` : [];
  const imgs = l ? await s`SELECT original_name, caption, include_in_print FROM ss_lesson_images WHERE lesson_id = ${l.id} ORDER BY sort_order` : [];
  return {
    topic_id: topic.id,
    question: topic.text,
    status: topic.status,
    discussed_on: topic.discussed_on ?? null,
    picked_by: m?.display_name ?? null,
    submitted_by: topic.submitted_by_name ?? null,
    pastor_topic_notes: topic.notes ?? null,
    lesson_exists: !!l,
    lesson_hash: lessonHash(l ?? null),
    updated_at: iso(l?.updated_at),
    sections: sectionsOf(l),
    homework: l?.homework_text ? { text: l.homework_text, hides_at: iso(l.homework_expires_at) } : null,
    images: imgs.length ? imgs.map((i) => ({ name: i.original_name, caption: i.caption, printed: i.include_in_print })) : undefined,
    app_url: lessonUrl(topic.id),
  };
}

// ─── write ──────────────────────────────────────────────────────────────────

async function writeLesson(
  t: T,
  ctx: Ctx,
  p: { topicId: string; before: Row | null; sections: Section[]; homework?: { text: string | null; expires: string | null }; createdTopicId?: string | null; tool: string; summary: string },
) {
  const mirror = legacyMirror(p.sections);
  const hw = p.homework ?? { text: p.before?.homework_text ?? null, expires: iso(p.before?.homework_expires_at) };
  const row = {
    sections: t.json(p.sections as never),
    ...mirror,
    homework_text: hw.text,
    homework_expires_at: hw.expires,
  };
  let after: Row;
  if (p.before) {
    [after] = await t`UPDATE ss_lessons SET ${t(row as any)} WHERE id = ${p.before.id} RETURNING *`;
  } else {
    [after] = await t`INSERT INTO ss_lessons ${t({ ...row, owner_user_id: owner(), topic_id: p.topicId } as any)} RETURNING *`;
  }
  const changeId = await logChange(t, ctx, {
    kind: "lesson",
    tool: p.tool,
    summary: p.summary,
    targetId: p.topicId,
    before: {
      lesson: p.before
        ? Object.fromEntries(["sections", "opening_prompt", "pastor_notes", "closing_prompt", "homework_text", "homework_expires_at"].map((k) => [k, k === "homework_expires_at" ? iso(p.before![k]) : p.before![k] ?? null]))
        : null,
      created_topic_id: p.createdTopicId ?? null,
    },
    after: { lesson_hash: lessonHash(after) },
  });
  return { after, changeId };
}

async function saveLesson(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const summary = str(a, "change_summary", 300);
  if (!summary) throw new Error("change_summary is required");
  const sections = parseSections(a.sections);
  if (!sections.length) throw new Error("A lesson needs at least one section");
  let topicId = uuid(a, "topic_id", false);
  const newQuestion = str(a, "new_question", 1000);
  if (!topicId && !newQuestion) throw new Error("Give topic_id for an existing question, or new_question to add one");
  if (topicId && newQuestion) throw new Error("Give topic_id or new_question, not both");
  const expected = str(a, "expected_lesson_hash", 40);
  const newStatus = oneOf(a, "new_question_status", ["possible_future", "picked_for_next"] as const, "possible_future")!;
  const hwText = a.homework_text === undefined ? undefined : text(a, "homework_text", 5000)?.trim() || null;

  return sql().begin(async (tx) => {
    const t = tx as unknown as T;
    let createdTopicId: string | null = null;
    if (!topicId) {
      const [first] = await t`SELECT min(queue_sort) AS q FROM ss_topics WHERE owner_user_id = ${owner()} AND status = 'possible_future'`;
      const [last] = await t`SELECT max(queue_sort) AS q FROM ss_topics WHERE owner_user_id = ${owner()} AND status = 'possible_future'`;
      const front = bool(a, "put_at_front_of_queue", false);
      const qs = front ? Number(first?.q ?? Date.now() / 1000) - 1 : Number(last?.q ?? Date.now() / 1000) + 1;
      const [tp] = await t`INSERT INTO ss_topics (owner_user_id, text, status, queue_sort, submitted_by_name, notes)
                           VALUES (${owner()}, ${newQuestion}, ${newStatus}, ${qs}, ${str(a, "submitted_by", 200)}, ${str(a, "topic_notes", 2000)}) RETURNING id`;
      topicId = String(tp.id);
      createdTopicId = topicId;
    } else {
      await loadTopic(t, topicId, true);
    }
    const [before] = await t`SELECT * FROM ss_lessons WHERE topic_id = ${topicId} AND owner_user_id = ${owner()} FOR UPDATE`;
    if (before && !expected)
      throw new Error("This question already has a lesson. Read it with get_lesson and pass expected_lesson_hash, so Todd's own edits can't be overwritten.");
    if (expected && expected !== lessonHash(before ?? null))
      throw new Error("The lesson changed since you read it (maybe Todd edited it in the app). Read it again with get_lesson and redo the change on the current text.");
    let homework: { text: string | null; expires: string | null } | undefined;
    if (hwText !== undefined) homework = { text: hwText, expires: hwText ? classEndUtc(date(a, "homework_due") ?? centralToday()) : null };
    const { after, changeId } = await writeLesson(t, ctx, { topicId: topicId!, before: before ?? null, sections, homework, createdTopicId, tool: "save_lesson", summary });
    return {
      saved: true,
      topic_id: topicId,
      created_question: !!createdTopicId,
      replaced_existing_lesson: !!before,
      sections: sections.length,
      homework_hides_at: iso(after.homework_expires_at) ?? undefined,
      lesson_hash: lessonHash(after),
      change_id: changeId,
      app_url: lessonUrl(topicId!),
      note: "Saved. The previous lesson (if any) is logged; undo_change with this change_id puts it back. If the lesson is open in the app, reload it before typing so autosave doesn't write the old text back.",
    };
  });
}

async function editLesson(a: Record<string, unknown>, ctx: Ctx) {
  requireWrite(ctx);
  const topicId = uuid(a, "topic_id")!;
  const summary = str(a, "change_summary", 300);
  if (!summary) throw new Error("change_summary is required");
  const expected = str(a, "expected_lesson_hash", 40);
  if (!expected) throw new Error("expected_lesson_hash is required (from get_lesson)");
  const editsRaw = a.edits;
  const list = typeof editsRaw === "string" ? JSON.parse(editsRaw) : editsRaw;
  if (!Array.isArray(list) || !list.length) throw new Error("edits must be a list of {find, replace}");
  const edits = list.map((e: Row) => ({ find: String(e?.find ?? ""), replace: String(e?.replace ?? "") }));

  return sql().begin(async (tx) => {
    const t = tx as unknown as T;
    await loadTopic(t, topicId, true);
    const [before] = await t`SELECT * FROM ss_lessons WHERE topic_id = ${topicId} AND owner_user_id = ${owner()} FOR UPDATE`;
    if (!before) throw new Error("This question has no lesson yet; use save_lesson to create one.");
    if (expected !== lessonHash(before)) throw new Error("The lesson changed since you read it. Read it again with get_lesson.");
    // Edit the lesson as one text (sections separated by a marker no lesson contains), so each find must be unique across the lesson.
    const SEP = "\n␞\n";
    const flat = sectionsOf(before).map((s) => `${s.header}␟${s.body}`).join(SEP);
    for (const e of edits) if (e.find.includes("␞") || e.find.includes("␟")) throw new Error("Bad find text");
    const out = applyEdits(flat, edits);
    const sections = out.split(SEP).map((chunk) => {
      const i = chunk.indexOf("␟");
      if (i < 0) throw new Error("An edit crossed a section boundary; edit one section at a time");
      return { header: chunk.slice(0, i), body: chunk.slice(i + 1) };
    });
    const { after, changeId } = await writeLesson(t, ctx, { topicId, before, sections: normalize(sections), tool: "edit_lesson", summary });
    return { saved: true, edits_applied: edits.length, lesson_hash: lessonHash(after), change_id: changeId };
  });
}

/** Used by undo_change. */
export async function undoLesson(t: T, topicId: string, before: Row | null, afterHash: string | undefined, force: boolean): Promise<string> {
  const [cur] = await t`SELECT * FROM ss_lessons WHERE topic_id = ${topicId} AND owner_user_id = ${owner()} FOR UPDATE`;
  if (afterHash && cur && lessonHash(cur) !== afterHash && !force)
    throw new Error("The lesson has been edited since this change; undoing would discard those edits too. Call again with force: true if Todd wants that.");
  const prev = before?.lesson as Row | null;
  if (prev) {
    const row = { ...prev, sections: t.json((prev.sections ?? []) as never) };
    if (cur) await t`UPDATE ss_lessons SET ${t(row as any)} WHERE id = ${cur.id}`;
    else await t`INSERT INTO ss_lessons ${t({ ...row, owner_user_id: owner(), topic_id: topicId } as any)}`;
    return "Restored the previous lesson";
  }
  if (cur) await t`DELETE FROM ss_lessons WHERE id = ${cur.id}`;
  if (before?.created_topic_id) {
    await t`DELETE FROM ss_topics WHERE id = ${before.created_topic_id} AND owner_user_id = ${owner()}`;
    return "Removed the lesson and the question Claude added";
  }
  return "Removed the lesson Claude created";
}

const sectionSchema = {
  type: "array",
  items: { type: "object", required: ["header", "body"], properties: { header: { type: "string" }, body: { type: "string", description: "Prose, or '- item' lines for a bullet list" } } },
};

export function lessonTools(ctx: Ctx): ToolDef[] {
  return [
    {
      name: "get_sunday_school_overview",
      title: "Sunday School overview",
      description:
        "Todd's Sunday School class (\"Todd & Tyler's Excellent Adventure\", Wedowee FUMC, Sundays 9–9:30 AM): the active question, the one picked for next week, next_to_draft (the first upcoming question without a lesson), the queue of possible future questions in Todd's planned order, recent past questions, and unprocessed suggestions. Start here for 'draft the next lesson'.",
      inputSchema: { type: "object", properties: { future: { type: "integer", default: 10 }, past: { type: "integer", default: 8 } } },
      run: overview,
    },
    {
      name: "search_lessons",
      title: "Search Sunday School lessons",
      description: "Search class questions and lesson text (every word must appear), by status and date discussed. Use it to see how a subject was handled before or avoid repeating a past lesson.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string" },
          status: { type: "string", enum: [...TOPIC_STATUSES] },
          discussed_from: { type: "string" },
          discussed_to: { type: "string" },
          only_with_lesson: { type: "boolean" },
          limit: { type: "integer", default: 25 },
        },
      },
      run: searchLessons,
    },
    {
      name: "get_lesson",
      title: "Get a Sunday School lesson",
      description:
        "One class question and its lesson: ordered sections (header + body; bodies use '- ' lines for bullets), homework, image captions, who picked it, and lesson_hash for edits. Lessons the app hasn't re-saved since the sections update come back converted the same way the app shows them.",
      inputSchema: { type: "object", required: ["topic_id"], properties: { topic_id: { type: "string" } } },
      run: getLesson,
    },
    {
      name: "save_lesson",
      title: "Save a Sunday School lesson",
      description:
        "Save a whole lesson Todd approved into the Sunday School app: for an existing question (topic_id; if it already has a lesson, expected_lesson_hash is required and the old lesson is logged for undo) or a new one (new_question, added to the queue as possible_future or picked_for_next). Lessons are 3–6 sections typically, Todd's voice: thoughtful, ecumenical, Wesleyan-leaning, honest about mystery; prompts in prose, 'thoughts' as '- ' bullets; often ending 'What are your thoughts?'. Optional homework_text (hidden on the public page after class on the Sunday on/after homework_due).",
      readOnly: false,
      destructive: true,
      inputSchema: {
        type: "object",
        required: ["sections", "change_summary"],
        properties: {
          topic_id: { type: "string" },
          new_question: { type: "string" },
          new_question_status: { type: "string", enum: ["possible_future", "picked_for_next"], default: "possible_future" },
          put_at_front_of_queue: { type: "boolean", default: false },
          submitted_by: { type: "string" },
          topic_notes: { type: "string", description: "Private pastor notes on the question" },
          expected_lesson_hash: { type: "string" },
          change_summary: { type: "string" },
          sections: sectionSchema,
          homework_text: { type: ["string", "null"] },
          homework_due: { type: "string", description: "YYYY-MM-DD; homework hides after class on that Sunday (default: next Sunday)" },
        },
      },
      run: (a) => saveLesson(a, ctx),
    },
    {
      name: "edit_lesson",
      title: "Edit a Sunday School lesson",
      description:
        "Targeted find/replace edits to an existing lesson's headers or bodies, after Todd approves them. Each find is copied exactly from get_lesson and must occur once in the whole lesson; all-or-nothing. Needs expected_lesson_hash. Logged and undoable.",
      readOnly: false,
      destructive: true,
      inputSchema: {
        type: "object",
        required: ["topic_id", "edits", "expected_lesson_hash", "change_summary"],
        properties: {
          topic_id: { type: "string" },
          expected_lesson_hash: { type: "string" },
          change_summary: { type: "string" },
          edits: { type: "array", items: { type: "object", required: ["find", "replace"], properties: { find: { type: "string" }, replace: { type: "string" } } } },
        },
      },
      run: (a) => editLesson(a, ctx),
    },
  ];
}
