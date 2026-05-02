import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { listMyLibraries } from '../lib/libraries';
import {
  publicResourceImageUrl,
  listResourceImages,
} from '../lib/resourceImages';
import { booksFromReference } from '../lib/scripture';
import {
  analyzeResource,
  analyzeResourceWithImages,
} from '../lib/claude';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';

// Sentinel value used in the dropdowns to mean "show only items missing
// this field". Picked something unlikely to clash with real values.
const MISSING = '__missing__';

const TYPE_OPTIONS = [
  { value: 'any', label: 'All types' },
  { value: 'story', label: 'Stories' },
  { value: 'quote', label: 'Quotes' },
  { value: 'illustration', label: 'Illustrations' },
  { value: 'joke', label: 'Jokes' },
  { value: 'note', label: 'Notes' },
  { value: 'photo', label: 'Photos' },
];

const TYPE_BADGE = {
  story: { label: 'Story', cls: 'bg-blue-100 text-blue-800' },
  quote: { label: 'Quote', cls: 'bg-purple-100 text-purple-800' },
  illustration: { label: 'Illustration', cls: 'bg-amber-100 text-amber-800' },
  joke: { label: 'Joke', cls: 'bg-green-100 text-green-800' },
  note: { label: 'Note', cls: 'bg-gray-200 text-gray-700' },
  photo: { label: 'Photo', cls: 'bg-pink-100 text-pink-800' },
};


const SORT_OPTIONS = [
  { value: 'created_desc', label: 'Newest first' },
  { value: 'created_asc', label: 'Oldest first' },
  { value: 'title_asc', label: 'Title A→Z' },
];

const DEFAULT_FILTERS = {
  search: '',
  type: 'any',
  theme: '',
  book: '',
  tone: '',
  // 'all' = every library you can see (incl. personal); 'personal' = only
  // your library_id-null resources; or a specific library uuid.
  library: 'all',
  sort: 'created_desc',
};

// Pull filter values from URL search params, falling back to defaults.
// Keeping filter state in the URL means: navigating to a resource detail
// and pressing browser-back returns you to the same filtered view; reload
// preserves filters; the auth re-validation flicker doesn't reset them;
// and filtered views are shareable / bookmarkable.
function filtersFromSearch(params) {
  return {
    search: params.get('q') ?? '',
    type: params.get('type') ?? 'any',
    theme: params.get('theme') ?? '',
    book: params.get('book') ?? '',
    tone: params.get('tone') ?? '',
    library: params.get('lib') ?? 'all',
    sort: params.get('sort') ?? 'created_desc',
  };
}

function searchFromFilters(f) {
  const out = {};
  if (f.search?.trim()) out.q = f.search;
  if (f.type && f.type !== 'any') out.type = f.type;
  if (f.theme) out.theme = f.theme;
  if (f.book) out.book = f.book;
  if (f.tone) out.tone = f.tone;
  if (f.library && f.library !== 'all') out.lib = f.library;
  if (f.sort && f.sort !== 'created_desc') out.sort = f.sort;
  return out;
}

export default function ResourceList() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [resources, setResources] = useState([]);
  // Map of resource_id → first image_path (for thumbnails). We fetch
  // resource_images separately, taking the lowest sort_order per resource.
  const [thumbsByResource, setThumbsByResource] = useState({});
  const [libraries, setLibraries] = useState([]);
  const [searchParams, setSearchParams] = useSearchParams();
  // Filters are derived from the URL on every render. Filter changes
  // write to the URL via setSearchParams, which automatically becomes
  // the source of truth.
  const filters = useMemo(
    () => filtersFromSearch(searchParams),
    [searchParams]
  );
  // Selection state for bulk actions (move-to-library, bulk analyze)
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkLibraryId, setBulkLibraryId] = useState('');
  const [bulkMoving, setBulkMoving] = useState(false);
  const [bulkError, setBulkError] = useState(null);
  // Bulk analyze state
  const [bulkAnalyzing, setBulkAnalyzing] = useState(false);
  const [bulkAnalyzeOverwrite, setBulkAnalyzeOverwrite] = useState(false);
  const [bulkAnalyzeProgress, setBulkAnalyzeProgress] = useState({
    done: 0,
    total: 0,
    label: '',
  });

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  const updateFilter = (key, value) => {
    const next = { ...filters, [key]: value };
    // `replace: true` so back/forward isn't cluttered with one history
    // entry per keystroke when the user types in the search box.
    setSearchParams(searchFromFilters(next), { replace: true });
  };

  const runBulkMove = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const targetLibraryId = bulkLibraryId || null;
    const targetLabel = targetLibraryId
      ? libraries.find((l) => l.id === targetLibraryId)?.name || 'that library'
      : 'private (just you)';
    if (
      !window.confirm(
        `Move ${ids.length} resource${ids.length === 1 ? '' : 's'} to ${targetLabel}?`
      )
    ) {
      return;
    }
    setBulkMoving(true);
    setBulkError(null);
    try {
      const { data, error: err } = await withTimeout(
        supabase
          .from('resources')
          .update({ library_id: targetLibraryId })
          .in('id', ids)
          .select('id, library_id'),
        30000
      );
      if (err) throw err;
      const updatedIds = new Set((data ?? []).map((r) => r.id));
      setResources((prev) =>
        prev.map((r) =>
          updatedIds.has(r.id) ? { ...r, library_id: targetLibraryId } : r
        )
      );
      clearSelection();
    } catch (e) {
      setBulkError(e.message || String(e));
    } finally {
      setBulkMoving(false);
    }
  };

  // Bulk Analyze with Claude. For each selected resource:
  //   - if it has any images → use vision (returns title/content/themes/
  //     scripture/tone)
  //   - else → text analyzer (themes/scripture/tone)
  //
  // Existing values are kept by default (only blanks fill in). Themes
  // always merge as a deduped union. With overwrite=true, every Claude
  // suggestion replaces the current value.
  const runBulkAnalyze = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Analyze ${ids.length} resource${ids.length === 1 ? '' : 's'} with Claude? ` +
          (bulkAnalyzeOverwrite
            ? 'Existing values will be REPLACED with Claude suggestions.'
            : 'Only empty fields will be filled in (themes always merge).')
      )
    ) {
      return;
    }
    setBulkAnalyzing(true);
    setBulkError(null);
    setBulkAnalyzeProgress({ done: 0, total: ids.length, label: '' });

    const errors = [];
    let succeeded = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const resource = resources.find((r) => r.id === id);
      if (!resource) continue;
      const shortLabel =
        (resource.title || resource.content || '(untitled)').slice(0, 50);
      setBulkAnalyzeProgress({
        done: i,
        total: ids.length,
        label: shortLabel,
      });
      try {
        // Decide vision vs text by checking if there are any images.
        const imgs = await listResourceImages(id).catch(() => []);
        let suggestion;
        if (imgs.length > 0) {
          suggestion = await analyzeResourceWithImages({
            images: imgs.map((img) => ({
              image_path: img.image_path,
              caption: img.caption,
            })),
            existing: {
              title: resource.title,
              content: resource.content,
              source: resource.source,
              themes: resource.themes,
              scripture_refs: resource.scripture_refs,
              tone: resource.tone,
              resource_type: resource.resource_type,
            },
          });
        } else {
          // Text analyzer needs content; skip if completely empty.
          if (!resource.content?.trim()) {
            errors.push(`"${shortLabel}": no content or images to analyze`);
            continue;
          }
          const textResult = await analyzeResource({
            content: resource.content,
            type: resource.resource_type,
            title: resource.title || undefined,
            source: resource.source || undefined,
          });
          // Pad out the shape so the merge logic below handles it
          // uniformly (text analyzer doesn't propose title/content).
          suggestion = {
            title: '',
            content: '',
            themes: textResult.themes,
            scripture_refs: textResult.scripture_refs,
            tone: textResult.tone,
          };
        }

        // Merge with current. Themes always union; other fields obey
        // the overwrite checkbox.
        const themeUnion = Array.from(
          new Set(
            [...(resource.themes ?? []), ...(suggestion.themes ?? [])]
              .map((t) => t.trim().toLowerCase())
              .filter(Boolean)
          )
        );
        const pick = (curVal, sugVal) => {
          if (bulkAnalyzeOverwrite) return sugVal || null;
          if (curVal && String(curVal).trim()) return curVal;
          return sugVal || null;
        };
        const update = {
          title: pick(resource.title, suggestion.title),
          content:
            pick(resource.content, suggestion.content) ||
            resource.content ||
            '',
          scripture_refs: pick(resource.scripture_refs, suggestion.scripture_refs),
          tone: pick(resource.tone, suggestion.tone),
          themes: themeUnion,
        };
        const { data, error: updErr } = await withTimeout(
          supabase
            .from('resources')
            .update(update)
            .eq('id', id)
            .select()
            .single(),
          30000
        );
        if (updErr) throw updErr;
        // Update local state in place so the user sees the change without
        // a full reload.
        setResources((prev) =>
          prev.map((r) => (r.id === id ? data : r))
        );
        succeeded += 1;
      } catch (e) {
        errors.push(`"${shortLabel}": ${e.message || String(e)}`);
      }
    }

    setBulkAnalyzeProgress({ done: ids.length, total: ids.length, label: '' });
    setBulkAnalyzing(false);
    if (errors.length > 0) {
      setBulkError(
        `Analyzed ${succeeded} · ${errors.length} failed:\n${errors.join('\n')}`
      );
    } else {
      // Clean exit: clear selection so the bar collapses.
      clearSelection();
    }
  };

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // No owner filter — RLS returns rows you own AND rows in libraries
        // you're a member of. The pooled-library design means co-members
        // see each other's contributions.
        const [resRes, imgRes, libsResult] = await Promise.all([
          withTimeout(
            supabase
              .from('resources')
              .select('*')
              .order('created_at', { ascending: false })
          ),
          // Pull every image visible to us; we'll pick the first per
          // resource for thumbnails. RLS limits this to images of
          // resources we can see.
          withTimeout(
            supabase
              .from('resource_images')
              .select('resource_id, image_path, sort_order, created_at')
              .order('sort_order', { ascending: true })
              .order('created_at', { ascending: true })
          ),
          listMyLibraries().catch(() => []),
        ]);
        if (resRes.error) throw resRes.error;
        if (imgRes.error) throw imgRes.error;
        if (cancelled) return;
        setResources(resRes.data ?? []);
        // First image per resource (data is already sorted).
        const thumbs = {};
        for (const img of imgRes.data ?? []) {
          if (!thumbs[img.resource_id]) thumbs[img.resource_id] = img.image_path;
        }
        setThumbsByResource(thumbs);
        setLibraries(libsResult);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Unique theme tags across all resources, for the theme dropdown.
  const allThemes = useMemo(() => {
    const set = new Set();
    for (const r of resources) {
      for (const t of r.themes ?? []) {
        if (t) set.add(t);
      }
    }
    return Array.from(set).sort();
  }, [resources]);

  // Per-resource list of books extracted from scripture_refs. Cache it
  // once per resources change so we don't re-parse every render.
  const booksByResource = useMemo(() => {
    const map = new Map();
    for (const r of resources) {
      map.set(r.id, booksFromReference(r.scripture_refs ?? ''));
    }
    return map;
  }, [resources]);

  const allBooks = useMemo(() => {
    const set = new Set();
    for (const books of booksByResource.values()) {
      for (const b of books) set.add(b);
    }
    return Array.from(set).sort();
  }, [booksByResource]);

  const allTones = useMemo(() => {
    const set = new Set();
    for (const r of resources) {
      const t = (r.tone ?? '').trim();
      if (t) set.add(t);
    }
    return Array.from(set).sort();
  }, [resources]);

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const themeQ = filters.theme.trim().toLowerCase();
    const bookQ = filters.book.trim();
    const toneQ = filters.tone.trim().toLowerCase();
    let out = resources.filter((r) => {
      if (filters.type !== 'any' && r.resource_type !== filters.type) return false;
      if (filters.library === 'personal' && r.library_id) return false;
      if (
        filters.library !== 'all' &&
        filters.library !== 'personal' &&
        r.library_id !== filters.library
      ) {
        return false;
      }
      // Theme filter: MISSING → no themes; specific value → exact match
      if (themeQ === MISSING) {
        if ((r.themes ?? []).length > 0) return false;
      } else if (themeQ) {
        if (!(r.themes ?? []).some((t) => t.toLowerCase() === themeQ))
          return false;
      }
      // Book filter: MISSING → no recognizable book in scripture_refs;
      // specific value → that book appears in the parsed list
      if (bookQ === MISSING) {
        if ((booksByResource.get(r.id) ?? []).length > 0) return false;
      } else if (bookQ) {
        const books = booksByResource.get(r.id) ?? [];
        if (!books.includes(bookQ)) return false;
      }
      // Tone filter: MISSING → empty tone; specific value → exact match
      if (toneQ === MISSING) {
        if ((r.tone ?? '').trim().length > 0) return false;
      } else if (toneQ) {
        if ((r.tone ?? '').trim().toLowerCase() !== toneQ) return false;
      }
      if (q) {
        const hay = [
          r.title,
          r.content,
          r.source,
          r.scripture_refs,
          r.tone,
          r.notes,
          ...(r.themes ?? []),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    out = out.slice().sort((a, b) => {
      switch (filters.sort) {
        case 'created_asc':
          return (a.created_at ?? '').localeCompare(b.created_at ?? '');
        case 'title_asc':
          return (a.title ?? '').localeCompare(b.title ?? '');
        case 'created_desc':
        default:
          return (b.created_at ?? '').localeCompare(a.created_at ?? '');
      }
    });
    return out;
  }, [resources, filters]);

  if (loading) return <LoadingSpinner label="Loading resources…" />;

  return (
    <div className="space-y-4">
      <Link
        to="/"
        className="inline-block text-sm text-gray-500 hover:text-gray-700"
      >
        ← Sermon archive
      </Link>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-serif text-2xl text-umc-900">Resources</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Stories, quotes, illustrations, photos, and notes for sermon prep.
          </p>
        </div>
        <div className="flex gap-3 items-center">
          <Link
            to="/import-resources"
            className="text-sm text-gray-500 hover:text-gray-700 underline whitespace-nowrap"
          >
            Import from Evernote
          </Link>
          <Link
            to="/libraries"
            className="text-sm text-gray-500 hover:text-gray-700 underline whitespace-nowrap"
          >
            Manage libraries
          </Link>
          <Link to="/resources/new" className="btn-primary text-sm whitespace-nowrap">
            + New resource
          </Link>
        </div>
      </div>

      {error && (
        <div className="card border-red-200 bg-red-50">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Filters */}
      <div className="card space-y-3">
        <div>
          <label className="label">Search</label>
          <input
            type="text"
            className="input"
            placeholder="Search title, content, source, theme…"
            value={filters.search}
            onChange={(e) => updateFilter('search', e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <label className="label">Library</label>
            <select
              className="input"
              value={filters.library}
              onChange={(e) => updateFilter('library', e.target.value)}
            >
              <option value="all">All visible</option>
              <option value="personal">My private only</option>
              {libraries.map((lib) => (
                <option key={lib.id} value={lib.id}>
                  {lib.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Type</label>
            <select
              className="input"
              value={filters.type}
              onChange={(e) => updateFilter('type', e.target.value)}
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Sort</label>
            <select
              className="input"
              value={filters.sort}
              onChange={(e) => updateFilter('sort', e.target.value)}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Theme</label>
            <select
              className="input"
              value={filters.theme}
              onChange={(e) => updateFilter('theme', e.target.value)}
            >
              <option value="">Any theme</option>
              <option value={MISSING}>(none — missing themes)</option>
              {allThemes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Book of Bible</label>
            <select
              className="input"
              value={filters.book}
              onChange={(e) => updateFilter('book', e.target.value)}
            >
              <option value="">Any book</option>
              <option value={MISSING}>(none — missing scripture)</option>
              {allBooks.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Tone</label>
            <select
              className="input"
              value={filters.tone}
              onChange={(e) => updateFilter('tone', e.target.value)}
            >
              <option value="">Any tone</option>
              <option value={MISSING}>(none — missing tone)</option>
              {allTones.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>
            Showing {filtered.length} of {resources.length}
          </span>
          {(filters.search ||
            filters.type !== 'any' ||
            filters.theme ||
            filters.book ||
            filters.tone ||
            (filters.library && filters.library !== 'all')) && (
            <button
              type="button"
              onClick={() => setSearchParams({}, { replace: true })}
              className="underline hover:text-gray-700"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      {resources.length === 0 ? (
        <div className="card text-center space-y-3 py-10">
          <p className="text-gray-500">
            No resources yet. Save your first story, quote, or illustration to get started.
          </p>
          <Link to="/resources/new" className="btn-primary inline-block">
            + New resource
          </Link>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card text-center py-10 text-sm text-gray-500">
          No resources match those filters.
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((r) => {
            const badge = TYPE_BADGE[r.resource_type] ?? TYPE_BADGE.note;
            const lib = libraries.find((l) => l.id === r.library_id);
            const isMine = r.owner_user_id === user?.id;
            // Show thumbnail for any resource that has at least one image,
            // not just photo type.
            const thumbUrl = thumbsByResource[r.id]
              ? publicResourceImageUrl(thumbsByResource[r.id])
              : null;
            const checked = selectedIds.has(r.id);
            return (
              <li key={r.id} className="relative">
                {/* Checkbox sits outside the Link so clicking it doesn't
                    navigate. Stacked at the corner of the card. */}
                <label
                  className="absolute top-3 left-3 z-10 cursor-pointer p-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSelected(r.id)}
                    className="h-4 w-4 rounded border-gray-300 text-umc-700"
                  />
                </label>
                <Link
                  to={`/resources/${r.id}`}
                  className={`card block pl-12 hover:border-umc-700 transition-colors ${
                    checked ? 'border-umc-700 bg-umc-50/30' : ''
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {thumbUrl && (
                      <img
                        src={thumbUrl}
                        alt={r.title || 'photo resource'}
                        loading="lazy"
                        className="h-20 w-20 object-cover rounded shrink-0 bg-gray-100"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span
                          className={`px-2 py-0.5 text-[10px] uppercase tracking-wide rounded ${badge.cls}`}
                        >
                          {badge.label}
                        </span>
                        {r.title && (
                          <h2 className="font-serif text-lg text-umc-900 truncate">
                            {r.title}
                          </h2>
                        )}
                        {lib ? (
                          <span className="text-[10px] uppercase tracking-wide text-gray-500">
                            in {lib.name}
                          </span>
                        ) : (
                          <span className="text-[10px] uppercase tracking-wide text-gray-400">
                            private
                          </span>
                        )}
                        {!isMine && (
                          <span className="text-[10px] uppercase tracking-wide text-umc-700">
                            shared
                          </span>
                        )}
                      </div>
                      {r.content && (
                        <p className="mt-2 text-sm text-gray-700 line-clamp-3 whitespace-pre-wrap">
                          {r.content}
                        </p>
                      )}
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
                        {r.source && <span>— {r.source}</span>}
                        {r.scripture_refs && (
                          <span className="text-gray-600">
                            {r.scripture_refs}
                          </span>
                        )}
                        {r.tone && <span className="italic">{r.tone}</span>}
                      </div>
                      {(r.themes ?? []).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {r.themes.map((t) => (
                            <span
                              key={t}
                              className="px-2 py-0.5 text-[10px] rounded bg-umc-100 text-umc-900"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {/* Floating bulk-action bar — appears when at least one resource
          is selected. Lets the pastor move many resources to a library
          (or back to private) in one shot. */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-4 inset-x-4 sm:left-1/2 sm:-translate-x-1/2 sm:max-w-3xl z-20 card shadow-xl bg-white border-umc-700 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-sm font-medium text-umc-900">
              {selectedIds.size} selected
            </span>
            <button
              type="button"
              onClick={clearSelection}
              disabled={bulkMoving || bulkAnalyzing}
              className="btn-secondary text-sm"
            >
              Clear
            </button>
          </div>

          {/* Move-to-library row */}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              className="input text-sm py-1 flex-1 min-w-[200px]"
              value={bulkLibraryId}
              onChange={(e) => setBulkLibraryId(e.target.value)}
              disabled={bulkMoving || bulkAnalyzing}
            >
              <option value="">Move to: Just me (private)</option>
              {libraries.map((lib) => (
                <option key={lib.id} value={lib.id}>
                  Move to: {lib.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={runBulkMove}
              disabled={bulkMoving || bulkAnalyzing}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {bulkMoving ? 'Moving…' : 'Apply move'}
            </button>
          </div>

          {/* Analyze-with-Claude row */}
          <div className="border-t border-gray-100 pt-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={bulkAnalyzeOverwrite}
                  onChange={(e) => setBulkAnalyzeOverwrite(e.target.checked)}
                  disabled={bulkAnalyzing}
                  className="h-4 w-4 rounded border-gray-300 text-umc-700"
                />
                <span>
                  Overwrite existing values
                  <span className="block text-[10px] text-gray-500 leading-tight">
                    {bulkAnalyzeOverwrite
                      ? 'Replace whatever\'s there'
                      : 'Only fill empty fields (themes always merge)'}
                  </span>
                </span>
              </label>
              <button
                type="button"
                onClick={runBulkAnalyze}
                disabled={bulkAnalyzing || bulkMoving}
                className="btn-primary text-sm disabled:opacity-50"
              >
                {bulkAnalyzing
                  ? `Analyzing ${bulkAnalyzeProgress.done}/${bulkAnalyzeProgress.total}…`
                  : `✨ Analyze ${selectedIds.size} with Claude`}
              </button>
            </div>
            {bulkAnalyzing && bulkAnalyzeProgress.label && (
              <p className="text-xs text-gray-500 truncate">
                Working on: {bulkAnalyzeProgress.label}
              </p>
            )}
            {bulkAnalyzing && bulkAnalyzeProgress.total > 0 && (
              <div className="w-full bg-gray-200 rounded h-1.5">
                <div
                  className="bg-umc-700 h-1.5 rounded transition-all"
                  style={{
                    width: `${(bulkAnalyzeProgress.done / bulkAnalyzeProgress.total) * 100}%`,
                  }}
                />
              </div>
            )}
          </div>

          {bulkError && (
            <p className="text-sm text-red-600 whitespace-pre-wrap">{bulkError}</p>
          )}
        </div>
      )}
    </div>
  );
}
