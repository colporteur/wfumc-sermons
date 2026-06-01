import { supabase, withTimeout } from './supabase';
import {
  booksFromReference,
  parseScriptureRanges,
  findOverlappingRanges,
  formatRange,
  rangesOverlap,
  expandWithSynopticParallels,
} from './scripture';

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

// Suggest resources whose scripture_refs share at least one verse with
// the sermon's scripture reference. Two-stage matching:
//
//   1. SQL pre-filter (cheap): pull every resource whose scripture_refs
//      mentions one of the books in the sermon's reference. We
//      over-fetch (limit*4) so the JS post-filter has enough candidates.
//
//   2. JS post-filter (precise): parse both references into normalized
//      verse ranges and only keep resources where at least one range
//      actually overlaps. So "Acts 17:22-31" matches "Acts 17:24-29"
//      (overlap) but NOT "Acts 2:42-47" (same book, no shared verse).
//
// Annotates each surviving row with `_overlap_ranges` (the specific
// ranges from the resource that matched) so the UI can show *why*
// each suggestion came up.
//
// When `includeSynopticParallels` is true, the target range set is
// expanded via expandWithSynopticParallels — so a search for
// "Matthew 9:9-13" also surfaces resources tagged with "Mark 2:13-17"
// or "Luke 5:27-32" (Call of Levi). Each overlap label gets a
// "(parallel of Matt 9:9-13)" suffix when it only matched via a
// parallel, so the UI can show why the row came up.
export async function suggestResourcesByScripture(scriptureReference, {
  limit = 24,
  includeSynopticParallels = false,
} = {}) {
  const sermonRanges = parseScriptureRanges(scriptureReference);
  if (sermonRanges.length === 0) return [];

  // Expand with synoptic parallels if requested. Each added range
  // carries `.parallelOf` pointing back to the originating user range.
  const targetRanges = includeSynopticParallels
    ? expandWithSynopticParallels(sermonRanges)
    : sermonRanges;

  // Cheap book-level pre-filter for the SQL query — uses the EXPANDED
  // book set so Mark/Luke candidates make it past the SQL stage.
  const books = [...new Set(targetRanges.map((r) => r.book))];
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
      // Over-fetch so the JS verse-level filter has room to drop matches
      // that share a book but not a verse.
      .limit(Math.max(limit * 4, 80))
  );
  if (error) throw error;

  // Verse-level post-filter against the expanded target set.
  const matched = [];
  for (const r of data ?? []) {
    const resourceRanges = parseScriptureRanges(r.scripture_refs);
    const overlap = [];
    for (const rr of resourceRanges) {
      for (const tr of targetRanges) {
        if (rangesOverlap(rr, tr)) {
          // Tag the matched resource range with the parallel info
          // (if it matched via a parallel) so the UI can label it.
          overlap.push(
            tr.parallelOf
              ? { ...rr, _parallelOf: tr.parallelOf }
              : rr
          );
          break; // count each resource range at most once
        }
      }
    }
    if (overlap.length === 0) continue;
    matched.push({
      ...r,
      _overlap_ranges: overlap,
      _overlap_labels: overlap.map((o) =>
        o._parallelOf
          ? `${formatRange(o)} (parallel of ${o._parallelOf})`
          : formatRange(o)
      ),
    });
    if (matched.length >= limit) break;
  }
  return matched;
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
