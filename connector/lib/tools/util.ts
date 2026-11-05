// Shared helpers for the connector's tools: argument parsing, dates,
// manuscript text helpers and the change log.

import { sql, owner } from "../db";
import { parseScriptureRanges, rangesOverlap, formatRange } from "../scripture.js";

type Args = Record<string, unknown>;

// ─── arguments ───────────────────────────────────────────────────────────────

export function str(a: Args, k: string, max = 500): string | null {
  const v = a[k];
  if (v == null || v === "") return null;
  return String(v).trim().slice(0, max) || null;
}

/** Long text (manuscripts, bodies). Not trimmed, so formatting survives. */
export function text(a: Args, k: string, max = 400_000): string | null {
  const v = a[k];
  if (v == null) return null;
  const s = String(v);
  if (s.length > max) throw new Error(`${k} is too long (max ${max} characters)`);
  return s;
}

export function num(a: Args, k: string, dflt: number | null, min: number, max: number): number | null {
  const v = a[k];
  if (v == null || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function bool(a: Args, k: string, dflt = false): boolean {
  const v = a[k];
  if (v == null || v === "") return dflt;
  if (typeof v === "boolean") return v;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

export function uuid(a: Args, k: string, required = true): string | null {
  const v = str(a, k, 60);
  if (!v) {
    if (required) throw new Error(`${k} is required`);
    return null;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error(`${k} must be an id (uuid)`);
  return v.toLowerCase();
}

export function uuids(a: Args, k: string, maxCount = 50): string[] {
  const v = a[k];
  const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
  const out = list.map((s) => s.trim()).filter(Boolean);
  if (out.length > maxCount) throw new Error(`At most ${maxCount} ids at once`);
  for (const id of out) if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Not an id: ${id}`);
  return out.map((s) => s.toLowerCase());
}

export function strList(a: Args, k: string, maxEach = 80): string[] {
  const v = a[k];
  const list = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
  return list.map((s) => s.trim().slice(0, maxEach)).filter(Boolean);
}

export function date(a: Args, k: string): string | null {
  const v = str(a, k, 10);
  if (v == null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${k} must be YYYY-MM-DD`);
  return v;
}

export function oneOf<T extends string>(a: Args, k: string, allowed: readonly T[], dflt: T | null): T | null {
  const v = str(a, k, 60);
  if (v == null) return dflt;
  if (!allowed.includes(v as T)) throw new Error(`${k} must be one of: ${allowed.join(", ")}`);
  return v as T;
}

// ─── dates ───────────────────────────────────────────────────────────────────

/** Today's date in US Central as YYYY-MM-DD. */
export function centralToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

// ─── scripture ───────────────────────────────────────────────────────────────

export type Range = { book: string; chapter: number; startVerse: number; endVerse: number };

export function ranges(ref: string | null | undefined): Range[] {
  if (!ref) return [];
  try {
    return parseScriptureRanges(ref.replace(/([A-Za-z])\.(?=\s|$)/g, "$1")) as Range[];
  } catch {
    return [];
  }
}

export function overlaps(a: Range[], b: Range[]): boolean {
  for (const x of a) for (const y of b) if (rangesOverlap(x, y)) return true;
  return false;
}

export function formatRanges(rs: Range[]): string[] {
  return rs.map((r) => formatRange(r) as string);
}

// ─── text ────────────────────────────────────────────────────────────────────

/** Same paragraph split the Sermons app uses (blank-line separated). */
export function paragraphs(t: string | null | undefined): string[] {
  if (!t) return [];
  return t
    .split(/\n[ \t]*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function numberedParagraphs(t: string | null | undefined): string {
  return paragraphs(t)
    .map((p, i) => `[¶${i}] ${p}`)
    .join("\n\n");
}

const SLIDE_MARKER_RE = /<SLIDE\s+#?(\d+)\s*[-–—]\s*([^>]+)>/g;

export function slideMarkers(t: string | null | undefined) {
  const out: { number: number; description: string; paragraph: number }[] = [];
  paragraphs(t).forEach((p, idx) => {
    SLIDE_MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SLIDE_MARKER_RE.exec(p)) !== null) out.push({ number: parseInt(m[1], 10), description: m[2].trim(), paragraph: idx });
  });
  return out;
}

export function wordCount(t: string | null | undefined): number {
  return (t ?? "").split(/\s+/).filter(Boolean).length;
}

export function summarize(t: string | null | undefined, n = 280): string {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return cut.slice(0, sp > n * 0.7 ? sp : n) + "…";
}

export type Edit = { find: string; replace: string };

/**
 * Applies find/replace edits in order. Each `find` must occur exactly once
 * in the text as it stands at that point, so an edit can never land in the
 * wrong place. All-or-nothing: on any problem nothing is changed.
 */
export function applyEdits(original: string, edits: Edit[]): string {
  let out = original;
  edits.forEach((e, i) => {
    if (!e || typeof e.find !== "string" || typeof e.replace !== "string") throw new Error(`Edit ${i + 1}: needs find and replace text`);
    if (!e.find) throw new Error(`Edit ${i + 1}: find is empty`);
    const first = out.indexOf(e.find);
    if (first < 0) throw new Error(`Edit ${i + 1}: the find text isn't in the manuscript (it must match exactly, including punctuation): "${summarize(e.find, 80)}"`);
    if (out.indexOf(e.find, first + 1) >= 0) throw new Error(`Edit ${i + 1}: the find text appears more than once; include more surrounding words: "${summarize(e.find, 80)}"`);
    out = out.slice(0, first) + e.replace + out.slice(first + e.find.length);
  });
  return out;
}

export function parseEdits(a: Args, k = "edits"): Edit[] | null {
  const v = a[k];
  if (v == null) return null;
  const list = typeof v === "string" ? JSON.parse(v) : v;
  if (!Array.isArray(list)) throw new Error(`${k} must be a list of {find, replace}`);
  if (list.length > 100) throw new Error("At most 100 edits at once");
  return list.map((e: Record<string, unknown>) => ({ find: String(e?.find ?? ""), replace: String(e?.replace ?? "") }));
}

// ─── change log ──────────────────────────────────────────────────────────────

export type ChangeKind =
  | "manuscript"
  | "sermon_details"
  | "slides"
  | "resource_create"
  | "resource_update"
  | "resource_link"
  | "liturgy_create"
  | "liturgy_sections"
  | "liturgy_link"
  | "lesson"
  | "undo";

export type Ctx = { who: string; write: boolean };

type Tx = ReturnType<typeof sql>;

export async function logChange(
  tx: Tx,
  ctx: Ctx,
  p: { kind: ChangeKind; tool: string; summary: string; sermonId?: string | null; targetId?: string | null; before?: unknown; after?: unknown; revisionId?: string | null },
): Promise<string> {
  const s = tx as ReturnType<typeof sql>;
  const [r] = await s`
    INSERT INTO connector_changes (owner_user_id, kind, tool, sermon_id, target_id, summary, before, after, revision_id, client)
    VALUES (${owner()}, ${p.kind}, ${p.tool}, ${p.sermonId ?? null}, ${p.targetId ?? null}, ${p.summary.slice(0, 500)},
            ${p.before === undefined ? null : s.json(p.before as never)}, ${p.after === undefined ? null : s.json(p.after as never)},
            ${p.revisionId ?? null}, ${ctx.who})
    RETURNING id`;
  return String(r.id);
}

export function requireWrite(ctx: Ctx) {
  if (!ctx.write)
    throw new Error(
      "This connection is read-only. To allow changes, remove the connector in Claude's settings, add it again and tick \"Allow changes\" on the Allow page.",
    );
}
