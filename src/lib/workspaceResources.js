import { supabase, withTimeout } from './supabase';
import { booksFromReference } from './scripture';

// Helpers for the Workspace's Resources picker. Two responsibilities:
//
//   1. Auto-suggest resources whose scripture or themes overlap with the
//      sermon's scripture reference. (Wraps the same booksFromReference
//      helper used elsewhere; matching is by canonical book name.)
//
//   2. Format selected resources into a clean text block to splice into
//      Claude's system prompt. Each resource becomes a labeled section
//      so Claude can cite or pull from them by title.
//
// The selector itself stores selection in sessionStorage (alongside the
// chat thread) so a tab reload preserves what the pastor picked. The
// list lives in component state, not the DB — selecting a resource for
// "this revision turn" doesn't link it to the sermon. (When a resource
// actually gets used in the manuscript, the existing /sermons/:id
// "Resources used" panel is where it gets pinned long-term.)

// Search resources by free text. Matches against title, content,
// scripture_refs, and themes. RLS handles ownership/library scope.
// Returns up to `limit` rows.
export async function searchResources(q, { limit = 12 } = {}) {
  const safe = (q || '').replace(/[%_]/g, '').trim();
  if (!safe) return [];
  const orClause = [
    `title.ilike.%${safe}%`,
    `content.ilike.%${safe}%`,
    `scripture_refs.ilike.%${safe}%`,
  ].join(',');
  const { data, error } = await withTimeout(
    supabase
      .from('resources')
      .select(
        'id, title, content, resource_type, scripture_refs, themes, tone, source'
      )
      .or(orClause)
      .order('created_at', { ascending: false })
      .limit(limit)
  );
  if (error) throw error;
  return data ?? [];
}

// Suggest resources that share a Bible book with the sermon's scripture
// reference. The matcher here is intentionally cheap (book-level
// overlap), since the worship planner's intelligence panel already
// proved that book-level alone surfaces good candidates without false
// negatives from chapter/verse mismatches.
//
// Returns rows annotated with `_overlap_books` (string[]) so the UI
// can show why each one was suggested.
export async function suggestResourcesByScripture(scriptureReference, {
  limit = 24,
} = {}) {
  const books = booksFromReference(scriptureReference);
  if (books.length === 0) return [];

  // Pull all resources whose scripture_refs ilike-matches ANY of our
  // books. Build an .or() clause across all books × ilike.
  // RLS scopes the result automatically.
  const orClause = books
    .map((b) => `scripture_refs.ilike.%${b.replace(/[%_]/g, '')}%`)
    .join(',');

  const { data, error } = await withTimeout(
    supabase
      .from('resources')
      .select(
        'id, title, content, resource_type, scripture_refs, themes, tone, source'
      )
      .or(orClause)
      .order('created_at', { ascending: false })
      .limit(limit)
  );
  if (error) throw error;

  // Annotate with which books overlapped, so the UI can show
  // "Acts" or "Acts, Romans" beside each suggestion.
  return (data ?? []).map((r) => {
    const overlap = books.filter((b) =>
      (r.scripture_refs || '').toLowerCase().includes(b.toLowerCase())
    );
    return { ...r, _overlap_books: overlap };
  });
}

// Re-fetch full data for a list of selected resource IDs. Used when
// the workspace mounts and rehydrates from sessionStorage — the stored
// IDs may be stale (resource edited or deleted in another tab), so we
// always re-query for the current row.
export async function fetchResourcesByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const { data, error } = await withTimeout(
    supabase
      .from('resources')
      .select(
        'id, title, content, resource_type, scripture_refs, themes, tone, source'
      )
      .in('id', ids)
  );
  if (error) throw error;
  // Preserve the order the user picked them in.
  const byId = new Map((data ?? []).map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// Render a list of selected resources into a single text block suitable
// for Claude's system prompt. Each resource gets a labeled section
// with type, scripture refs, themes, source, and full content. Capped
// length per resource so a long story doesn't crowd out the manuscript.
const PER_RESOURCE_CHARS = 4000;

export function buildResourcesContext(resources) {
  if (!Array.isArray(resources) || resources.length === 0) return '';
  const blocks = resources.map((r, i) => {
    const lines = [`## Resource ${i + 1}: ${r.title || '(untitled)'}`];
    if (r.resource_type) lines.push(`Type: ${r.resource_type}`);
    if (r.scripture_refs) lines.push(`Scripture: ${r.scripture_refs}`);
    if (Array.isArray(r.themes) && r.themes.length) {
      lines.push(`Themes: ${r.themes.join(', ')}`);
    }
    if (r.tone) lines.push(`Tone: ${r.tone}`);
    if (r.source) lines.push(`Source: ${r.source}`);
    lines.push('');
    let body = (r.content || '').trim();
    if (body.length > PER_RESOURCE_CHARS) {
      body = body.slice(0, PER_RESOURCE_CHARS) + '\n[…content truncated for prompt length]';
    }
    lines.push(body);
    return lines.join('\n');
  });
  return blocks.join('\n\n---\n\n');
}
