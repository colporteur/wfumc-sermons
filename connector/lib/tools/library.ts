// Todd's Colporteur reading library (colporteur.vercel.app): books and
// articles, their full text, his highlights and notes, and AI-saved
// extracts (quotes, illustrations, exegesis). It lives in its own Neon
// database (COLPORTEUR_DATABASE_URL) and the connector only ever READS it:
// every query runs inside a READ ONLY transaction.

import postgres from "postgres";
import type { ToolDef } from "../protocol";
import { bool, num, overlaps, ranges, str, strList, summarize, uuid } from "./util";

type Row = Record<string, any>;
type Sql = ReturnType<typeof postgres>;
let client: Sql | null = null;

export function libraryConfigured() {
  return !!process.env.COLPORTEUR_DATABASE_URL;
}

function lib(): Sql {
  if (client) return client;
  const url = process.env.COLPORTEUR_DATABASE_URL;
  if (!url) throw new Error("The Colporteur library isn't connected yet (COLPORTEUR_DATABASE_URL is not set on the connector).");
  client = postgres(url, {
    prepare: false,
    max: Number(process.env.PG_MAX ?? 3),
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require",
  });
  return client;
}

export function setLibraryForTests(s: Sql | null) {
  client = s;
}

/** Every library query goes through here: read-only, no matter what. */
async function ro<X>(fn: (s: Sql) => Promise<X>): Promise<X> {
  return lib().begin("read only", async (tx) => fn(tx as unknown as Sql)) as Promise<X>;
}

const LIB_BASE = () => (process.env.COLPORTEUR_BASE_URL ?? "https://colporteur.vercel.app").replace(/\/$/, "");
const readerUrl = (bookId: string, format: string, idx: number | null) =>
  `${LIB_BASE()}/books/${bookId}${idx ? `/read?${format === "epub" ? "chapter" : "page"}=${idx}` : ""}`;
const loc = (kind: string | null, idx: number | null) => (idx ? `${kind === "chapter" ? "ch." : "p."} ${idx}` : null);
const cite = (r: Row) => [r.title, r.author, r.year].filter(Boolean).join(", ");

// ─── semantic search (optional; FTS works without it) ────────────────────────

async function embedQuery(q: string, model: string): Promise<number[] | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "WFUMC Sermons connector" },
      body: JSON.stringify({ model, input: [q] }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const v = data?.data?.[0]?.embedding;
    return Array.isArray(v) && v.length === 1536 ? v : null;
  } catch {
    return null;
  }
}

async function searchText(a: Record<string, unknown>) {
  const q = str(a, "q", 300);
  if (!q) throw new Error("q is required");
  const bookId = uuid(a, "book_id", false);
  const limit = num(a, "limit", 12, 1, 40)!;
  const chars = num(a, "excerpt_chars", 1200, 200, 5000)!;
  return ro(async (s) => {
    const fts = await s`
      SELECT c.id, c.book_id, c.text, b.title, b.author, b.year, b.format, bs.idx AS section_idx, bs.kind AS section_kind
      FROM chunks c JOIN books b ON b.id = c.book_id LEFT JOIN book_sections bs ON bs.id = c.section_id
      WHERE to_tsvector('english', c.text) @@ websearch_to_tsquery('english', ${q})
        ${bookId ? s`AND c.book_id = ${bookId}` : s``}
      ORDER BY ts_rank(to_tsvector('english', c.text), websearch_to_tsquery('english', ${q})) DESC
      LIMIT 30`;
    let vec: Row[] = [];
    let semantic = false;
    if (process.env.OPENROUTER_API_KEY) {
      const [setting] = await s`SELECT value FROM settings WHERE key = 'ai.defaults'`.catch(() => [] as Row[]);
      const model = (setting?.value as Row | undefined)?.embedding || "openai/text-embedding-3-small";
      const v = await embedQuery(q, model);
      if (v) {
        vec = await s`
          SELECT c.id, c.book_id, c.text, b.title, b.author, b.year, b.format, bs.idx AS section_idx, bs.kind AS section_kind
          FROM chunks c JOIN books b ON b.id = c.book_id LEFT JOIN book_sections bs ON bs.id = c.section_id
          WHERE c.embedding IS NOT NULL ${bookId ? s`AND c.book_id = ${bookId}` : s``}
          ORDER BY c.embedding <=> ${JSON.stringify(v)}::halfvec LIMIT 30`;
        semantic = true;
      }
    }
    // Reciprocal rank fusion, same as Colporteur's own search.
    const scores = new Map<string, { r: Row; score: number }>();
    for (const list of [vec, fts])
      list.forEach((r, rank) => {
        const k = String(r.id);
        const cur = scores.get(k);
        const sc = 1 / (61 + rank);
        if (cur) cur.score += sc;
        else scores.set(k, { r, score: sc });
      });
    const hits = [...scores.values()].sort((x, y) => y.score - x.score).slice(0, limit);
    return {
      search: semantic ? "meaning + keywords" : "keywords (add OPENROUTER_API_KEY to the connector for meaning-based search)",
      results: hits.map(({ r }) => ({
        book_id: r.book_id,
        source: cite(r),
        location: loc(r.section_kind, r.section_idx),
        excerpt: String(r.text).slice(0, chars),
        link: readerUrl(r.book_id, r.format, r.section_idx),
      })),
    };
  });
}

async function findQuotes(a: Record<string, unknown>) {
  const q = (str(a, "q", 200) ?? "").toLowerCase();
  const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
  const scripture = str(a, "scripture", 200);
  const themes = strList(a, "theme").map((t) => t.toLowerCase());
  const kinds = strList(a, "kind").filter((k) => ["quote", "illustration", "exegesis", "question", "highlight"].includes(k));
  const limit = num(a, "limit", 25, 1, 100)!;
  const want = scripture ? ranges(scripture) : [];
  if (scripture && !want.length) throw new Error(`Couldn't read "${scripture}" as a scripture reference`);
  return ro(async (s) => {
    const extracts = !kinds.length || kinds.some((k) => k !== "highlight")
      ? await s`
          SELECT e.id, e.kind::text AS kind, e.title, e.content, e.themes, e.scripture_refs, e.tone, e.section_ref, e.created_at,
                 e.shared_resource_id, b.id AS book_id, b.title AS book_title, b.author, b.year, b.format, b.scripture_range
          FROM ai_extracts e JOIN books b ON b.id = e.book_id`
      : [];
    const highlights = !kinds.length || kinds.includes("highlight")
      ? await s`
          SELECT h.id, h.selected_text, h.color, h.anchor, h.created_at, h.shared_resource_id, hl.label,
                 (SELECT string_agg(n.body, ' / ') FROM notes n WHERE n.highlight_id = h.id) AS note,
                 b.id AS book_id, b.title AS book_title, b.author, b.year, b.format, b.scripture_range
          FROM highlights h JOIN books b ON b.id = h.book_id LEFT JOIN highlight_labels hl ON hl.color = h.color`
      : [];
    type Item = { score: number; out: Row; hay: string; refs: string };
    const items: Item[] = [];
    for (const e of extracts) {
      if (kinds.length && !kinds.includes(e.kind)) continue;
      items.push({
        score: 1,
        hay: [e.title, e.content, (e.themes ?? []).join(" "), e.tone].join(" ").toLowerCase(),
        // The extract's own scripture when it has one; otherwise the book's range.
        refs: e.scripture_refs?.trim() ? e.scripture_refs : e.scripture_range ?? "",
        out: {
          type: e.kind,
          title: e.title ?? undefined,
          text: e.content,
          themes: e.themes?.length ? e.themes : undefined,
          scripture: e.scripture_refs ?? undefined,
          source: cite({ title: e.book_title, author: e.author, year: e.year }),
          location: e.section_ref ?? undefined,
          in_sermon_library: !!e.shared_resource_id || undefined,
          link: readerUrl(e.book_id, e.format, null),
        },
      });
    }
    for (const h of highlights) {
      const anchor = typeof h.anchor === "string" ? JSON.parse(h.anchor) : h.anchor;
      const page = Number(anchor?.page) || null;
      items.push({
        score: 1,
        hay: [h.selected_text, h.note, h.label].join(" ").toLowerCase(),
        refs: h.scripture_range ?? "",
        out: {
          type: "highlight",
          label: h.label || undefined,
          text: h.selected_text,
          note: h.note ?? undefined,
          source: cite({ title: h.book_title, author: h.author, year: h.year }),
          location: page ? `p. ${page}` : undefined,
          in_sermon_library: !!h.shared_resource_id || undefined,
          link: readerUrl(h.book_id, h.format, page),
        },
      });
    }
    let found = items;
    if (words.length) found = found.filter((x) => words.every((w) => x.hay.includes(w)));
    if (themes.length) found = found.filter((x) => themes.some((t) => x.hay.includes(t)));
    if (want.length) found = found.filter((x) => overlaps(ranges(x.refs), want));
    return { matched: found.length, items: found.slice(0, limit).map((x) => x.out) };
  });
}

async function listBooks(a: Record<string, unknown>) {
  const q = (str(a, "q", 200) ?? "").toLowerCase();
  const scripture = str(a, "scripture", 200);
  const starredOnly = bool(a, "starred", false);
  const limit = num(a, "limit", 40, 1, 300)!;
  return ro(async (s) => {
    const rows = await s`
      SELECT b.id, b.title, b.author, b.year, b.doc_type::text AS doc_type, b.format::text AS format, b.topics, b.scripture_range,
             b.section_count, b.starred, c.name AS category,
             (SELECT count(*)::int FROM highlights h WHERE h.book_id = b.id) AS highlights,
             (SELECT count(*)::int FROM ai_extracts e WHERE e.book_id = b.id) AS extracts
      FROM books b LEFT JOIN categories c ON c.id = b.category_id
      WHERE b.status = 'ready' ${starredOnly ? s`AND b.starred` : s``}
      ORDER BY b.title`;
    let out: Row[] = [...rows];
    if (q) {
      const words = q.split(/\s+/).filter(Boolean);
      out = out.filter((b) => words.every((w) => [b.title, b.author, b.category, (b.topics ?? []).join(" ")].join(" ").toLowerCase().includes(w)));
    }
    if (scripture) {
      const want = ranges(scripture);
      if (!want.length) throw new Error(`Couldn't read "${scripture}" as a scripture reference`);
      out = out.filter((b) => overlaps(ranges(b.scripture_range), want));
    }
    return {
      total: rows.length,
      matched: out.length,
      books: out.slice(0, limit).map((b) => ({
        book_id: b.id,
        title: b.title,
        author: b.author ?? undefined,
        year: b.year ?? undefined,
        type: b.doc_type,
        category: b.category ?? undefined,
        scripture: b.scripture_range ?? undefined,
        topics: b.topics?.length ? b.topics : undefined,
        pages_or_chapters: b.section_count ?? undefined,
        highlights: b.highlights || undefined,
        extracts: b.extracts || undefined,
        starred: b.starred || undefined,
        link: readerUrl(b.id, b.format, null),
      })),
    };
  });
}

async function readPassage(a: Record<string, unknown>) {
  const bookId = uuid(a, "book_id")!;
  const at = num(a, "page_or_chapter", 1, 1, 100_000)!;
  const span = num(a, "count", 1, 1, 5)!;
  const max = num(a, "max_chars", 12_000, 1_000, 60_000)!;
  return ro(async (s) => {
    const [b] = await s`SELECT id, title, author, year, format::text AS format, section_count FROM books WHERE id = ${bookId}`;
    if (!b) throw new Error(`No library book with id ${bookId}`);
    const secs = await s`SELECT idx, kind::text AS kind, title, text FROM book_sections
                         WHERE book_id = ${bookId} AND idx BETWEEN ${at} AND ${at + span - 1} ORDER BY idx`;
    let used = 0;
    const parts = [];
    for (const x of secs) {
      const t = String(x.text ?? "").slice(0, Math.max(0, max - used));
      used += t.length;
      parts.push({ location: loc(x.kind, x.idx), heading: x.title ?? undefined, text: t || "(no text — may need OCR)" });
      if (used >= max) break;
    }
    return { source: cite(b), of: b.section_count, sections: parts, link: readerUrl(b.id, b.format, at) };
  });
}

export function libraryTools(): ToolDef[] {
  if (!libraryConfigured()) return [];
  return [
    {
      name: "search_library",
      title: "Search Colporteur library text",
      description:
        "Search the full text of Todd's Colporteur reading library (commentaries, theology, articles) and return matching passages with book, page/chapter and a reader link. q accepts phrases in quotes, OR, and -excluded words. Uses meaning-based search too when configured.",
      inputSchema: {
        type: "object",
        required: ["q"],
        properties: { q: { type: "string" }, book_id: { type: "string" }, limit: { type: "integer", default: 12 }, excerpt_chars: { type: "integer", default: 1200 } },
      },
      run: searchText,
    },
    {
      name: "find_library_quotes",
      title: "Find quotes and highlights",
      description:
        "Todd's own highlights (with his notes and color labels like Illustration/Exegesis) and saved extracts (quote, illustration, exegesis, question) from the Colporteur library. Filter by words, scripture (overlap with the extract's refs or the book's range), theme, kind. in_sermon_library marks items already sent to the Sermons resource library.",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string" },
          scripture: { type: "string" },
          theme: { type: "array", items: { type: "string" } },
          kind: { type: "array", items: { type: "string", enum: ["quote", "illustration", "exegesis", "question", "highlight"] } },
          limit: { type: "integer", default: 25 },
        },
      },
      run: findQuotes,
    },
    {
      name: "list_library_books",
      title: "List library books",
      description: "Books and articles in the Colporteur library, filtered by words (title/author/category/topics), scripture coverage (e.g. commentaries on Matthew), or starred.",
      inputSchema: { type: "object", properties: { q: { type: "string" }, scripture: { type: "string" }, starred: { type: "boolean" }, limit: { type: "integer", default: 40 } } },
      run: listBooks,
    },
    {
      name: "read_library_passage",
      title: "Read a library passage",
      description: "The text of one or a few pages (PDF) or chapters (EPUB) of a library book, for context around a search hit. Quote briefly with attribution; don't reproduce long stretches.",
      inputSchema: {
        type: "object",
        required: ["book_id", "page_or_chapter"],
        properties: { book_id: { type: "string" }, page_or_chapter: { type: "integer" }, count: { type: "integer", default: 1, maximum: 5 }, max_chars: { type: "integer", default: 12000 } },
      },
      run: readPassage,
    },
  ];
}
