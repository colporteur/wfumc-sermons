import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { booksFromReference } from '../lib/scripture';
import { fetchSlideImageCountsByUser } from '../lib/sermonSlideImages';
import { fetchStashedBlockLiveCountsByUser } from '../lib/sermonStashedBlocks';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';

function fmtDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  return new Date(yyyymmdd + 'T00:00:00').toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const SORT_OPTIONS = [
  { value: 'preached_desc', label: 'Most recently preached' },
  { value: 'preached_asc', label: 'Oldest preached first' },
  { value: 'title_asc', label: 'Title A→Z' },
  { value: 'title_desc', label: 'Title Z→A' },
  { value: 'strength_desc', label: 'Strongest first' },
  { value: 'number_desc', label: 'Sermon # (high → low)' },
  { value: 'number_asc', label: 'Sermon # (low → high)' },
];

const PREACHED_OPTIONS = [
  { value: 'any', label: 'Any preaching status' },
  { value: 'wfumc_yes', label: 'Preached at WFUMC' },
  { value: 'wfumc_no', label: 'Never preached at WFUMC' },
  { value: 'never', label: 'Never preached anywhere' },
  { value: 'has_manuscript', label: 'Has manuscript' },
  { value: 'no_manuscript', label: 'No manuscript yet' },
];

const DEFAULT_FILTERS = {
  search: '',
  book: 'any',
  theme: '',
  minStrength: '',
  preached: 'any',
  sort: 'preached_desc',
};

// Sync filters with URL search params so they survive browser back/forward,
// reload, and the auth re-validation cycle on tab return.
function filtersFromSearch(params) {
  return {
    search: params.get('q') ?? '',
    book: params.get('book') ?? 'any',
    theme: params.get('theme') ?? '',
    minStrength: params.get('strength') ?? '',
    preached: params.get('preached') ?? 'any',
    sort: params.get('sort') ?? 'preached_desc',
  };
}

function searchFromFilters(f) {
  const out = {};
  if (f.search?.trim()) out.q = f.search;
  if (f.book && f.book !== 'any') out.book = f.book;
  if (f.theme) out.theme = f.theme;
  if (f.minStrength) out.strength = f.minStrength;
  if (f.preached && f.preached !== 'any') out.preached = f.preached;
  if (f.sort && f.sort !== 'preached_desc') out.sort = f.sort;
  return out;
}

export default function SermonList() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sermons, setSermons] = useState([]);
  // Set of sermon IDs (from THIS user's preachings) that are flagged
  // as preached at our church. Used for the WFUMC badge + filter.
  const [wfumcSermonIds, setWfumcSermonIds] = useState(new Set());
  // Max preaching date per sermon — used for "most recently preached"
  // sorting and the displayed date on each row.
  const [latestPreachedBySermon, setLatestPreachedBySermon] = useState(
    new Map()
  );
  // Number of slide-deck images uploaded per sermon. Used for the
  // 🖼️ badge on each row in the list.
  const [slideImageCounts, setSlideImageCounts] = useState(new Map());
  // Number of LIVE (used_at IS NULL) stashed blocks per sermon, for
  // the 📌 badge — flags sermons that have unworked-in material
  // waiting for next preaching.
  const [stashedBlockCounts, setStashedBlockCounts] = useState(new Map());
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(
    () => filtersFromSearch(searchParams),
    [searchParams]
  );

  const updateFilter = (key, value) => {
    const next = { ...filters, [key]: value };
    // `replace: true` keeps the back button useful (one history entry
    // per page visit, not per keystroke).
    setSearchParams(searchFromFilters(next), { replace: true });
  };

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [sermonRes, preachRes, slideCountsMap, stashedCountsMap] =
          await Promise.all([
            withTimeout(
              supabase
                .from('sermons')
                .select('*')
                .eq('owner_user_id', user.id)
                .order('created_at', { ascending: false })
            ),
            // Pull EVERY preaching the user owns (not just is_at_our_church)
            // so we can compute most-recent + WFUMC-flag in one pass.
            withTimeout(
              supabase
                .from('preachings')
                .select('sermon_id, preached_at, is_at_our_church')
                .eq('owner_user_id', user.id)
            ),
            // Slide-image counts for the 🖼️ badge per sermon.
            fetchSlideImageCountsByUser(user.id).catch(() => new Map()),
            // Live (un-archived) stashed-block counts for the 📌 badge.
            fetchStashedBlockLiveCountsByUser(user.id).catch(
              () => new Map()
            ),
          ]);
        if (sermonRes.error) throw sermonRes.error;
        if (preachRes.error) throw preachRes.error;
        if (!cancelled) {
          setSermons(sermonRes.data ?? []);
          const wfumc = new Set();
          const latest = new Map();
          for (const p of preachRes.data ?? []) {
            if (p.is_at_our_church) wfumc.add(p.sermon_id);
            if (p.preached_at) {
              const cur = latest.get(p.sermon_id);
              if (!cur || p.preached_at > cur) {
                latest.set(p.sermon_id, p.preached_at);
              }
            }
          }
          setWfumcSermonIds(wfumc);
          setLatestPreachedBySermon(latest);
          setSlideImageCounts(slideCountsMap || new Map());
          setStashedBlockCounts(stashedCountsMap || new Map());
        }
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

  // Annotate each sermon with its parsed list of bible books AND its
  // effective last-preached date (max from preachings, falling back to
  // the canonical sermons.preached_at when no preachings exist).
  const sermonsWithBooks = useMemo(
    () =>
      sermons.map((s) => {
        const fromPreachings = latestPreachedBySermon.get(s.id) ?? null;
        const effectiveDate =
          fromPreachings && (!s.preached_at || fromPreachings > s.preached_at)
            ? fromPreachings
            : s.preached_at ?? fromPreachings ?? null;
        return {
          ...s,
          books: booksFromReference(s.scripture_reference),
          lastPreachedAt: effectiveDate,
        };
      }),
    [sermons, latestPreachedBySermon]
  );

  // Build the dropdown of unique books found across the library
  const allBooks = useMemo(() => {
    const set = new Set();
    for (const s of sermonsWithBooks) {
      for (const b of s.books) set.add(b);
    }
    return Array.from(set).sort();
  }, [sermonsWithBooks]);

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const themeQ = filters.theme.trim().toLowerCase();
    const minStr = filters.minStrength
      ? Number(filters.minStrength)
      : null;
    return sermonsWithBooks.filter((s) => {
      if (q) {
        const blob = [
          s.title,
          s.scripture_reference,
          s.theme,
          s.notes,
          s.manuscript_text,
          s.major_stories,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!blob.includes(q)) return false;
      }
      if (themeQ) {
        if (!(s.theme || '').toLowerCase().includes(themeQ)) return false;
      }
      if (filters.book !== 'any') {
        if (!s.books.includes(filters.book)) return false;
      }
      if (minStr != null && !Number.isNaN(minStr)) {
        if (s.strength == null || s.strength < minStr) return false;
      }
      const inWfumc = wfumcSermonIds.has(s.id);
      if (filters.preached === 'wfumc_yes' && !inWfumc) return false;
      if (filters.preached === 'wfumc_no' && inWfumc) return false;
      if (filters.preached === 'never') {
        // "Never preached anywhere" — no preached_at AND not in wfumcSermonIds
        if (s.preached_at || inWfumc) return false;
      }
      if (filters.preached === 'has_manuscript' && !s.manuscript_text)
        return false;
      if (filters.preached === 'no_manuscript' && s.manuscript_text)
        return false;
      return true;
    });
  }, [sermonsWithBooks, filters, wfumcSermonIds]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const cmp = (a, b, dir = 1) => (a === b ? 0 : a < b ? -dir : dir);
    switch (filters.sort) {
      case 'preached_asc':
        arr.sort((a, b) => {
          // For "oldest preached first" use the FIRST preaching, which we
          // approximate via sermons.preached_at (set by the user/import).
          // Falls back to lastPreachedAt if first wasn't set explicitly.
          const ad = a.preached_at || a.lastPreachedAt;
          const bd = b.preached_at || b.lastPreachedAt;
          if (!ad && !bd) return 0;
          if (!ad) return 1;
          if (!bd) return -1;
          return cmp(ad, bd, 1);
        });
        break;
      case 'title_asc':
        arr.sort((a, b) => cmp((a.title || '').toLowerCase(), (b.title || '').toLowerCase(), 1));
        break;
      case 'title_desc':
        arr.sort((a, b) => cmp((a.title || '').toLowerCase(), (b.title || '').toLowerCase(), -1));
        break;
      case 'strength_desc':
        arr.sort((a, b) => {
          const aa = a.strength == null ? -1 : a.strength;
          const bb = b.strength == null ? -1 : b.strength;
          return cmp(aa, bb, -1);
        });
        break;
      case 'number_desc':
        arr.sort((a, b) => cmp(a.original_sermon_number ?? -1, b.original_sermon_number ?? -1, -1));
        break;
      case 'number_asc':
        arr.sort((a, b) => cmp(a.original_sermon_number ?? Infinity, b.original_sermon_number ?? Infinity, 1));
        break;
      case 'preached_desc':
      default:
        // Most recently preached: use the MAX preaching date
        // (lastPreachedAt is computed from the preachings table).
        arr.sort((a, b) => {
          if (!a.lastPreachedAt && !b.lastPreachedAt) return 0;
          if (!a.lastPreachedAt) return 1;
          if (!b.lastPreachedAt) return -1;
          return cmp(a.lastPreachedAt, b.lastPreachedAt, -1);
        });
        break;
    }
    return arr;
  }, [filtered, filters.sort]);

  const filtersActive =
    filters.search.trim() ||
    filters.book !== 'any' ||
    filters.theme.trim() ||
    filters.minStrength ||
    filters.preached !== 'any';

  if (loading) return <LoadingSpinner label="Loading sermons…" />;
  if (error) {
    return (
      <div className="card text-center space-y-3">
        <p className="text-sm text-red-700">Couldn't load sermons.</p>
        <p className="text-xs text-gray-500">{error}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="btn-primary"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-serif text-umc-900">Sermon Archive</h1>
          <p className="text-sm text-gray-600 mt-1">
            Every sermon you've preached, indexed and searchable.
          </p>
        </div>
        <div className="flex items-center gap-2 whitespace-nowrap">
          <Link
            to="/sermons/new/workspace"
            className="btn-primary"
            title="Start a new sermon directly in the chat-revise Workspace with Claude."
          >
            ✨ Draft in Workspace
          </Link>
          <Link
            to="/sermons/new"
            className="btn-secondary"
            title="Use the full New Sermon form (theme, lectionary year, eulogy flag, manuscript upload, etc.)."
          >
            + New sermon
          </Link>
        </div>
      </div>

      <div className="card space-y-3">
        <input
          type="text"
          className="input"
          placeholder="Search by title, scripture, theme, notes, or manuscript text…"
          value={filters.search}
          onChange={(e) => updateFilter('search', e.target.value)}
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="label text-xs">Bible book</label>
            <select
              className="input text-sm"
              value={filters.book}
              onChange={(e) => updateFilter('book', e.target.value)}
            >
              <option value="any">Any book</option>
              {allBooks.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label text-xs">Theme contains</label>
            <input
              type="text"
              className="input text-sm"
              value={filters.theme}
              onChange={(e) => updateFilter('theme', e.target.value)}
              placeholder="e.g., Easter"
            />
          </div>
          <div>
            <label className="label text-xs">Min strength</label>
            <select
              className="input text-sm"
              value={filters.minStrength}
              onChange={(e) => updateFilter('minStrength', e.target.value)}
            >
              <option value="">Any rating</option>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n} value={n}>
                  {n}+
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label text-xs">Preaching status</label>
            <select
              className="input text-sm"
              value={filters.preached}
              onChange={(e) => updateFilter('preached', e.target.value)}
            >
              {PREACHED_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600">Sort:</label>
            <select
              className="text-sm border border-gray-300 rounded px-2 py-1"
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
          <div className="flex items-center gap-3">
            {filtersActive && (
              <button
                type="button"
                onClick={() => setSearchParams({}, { replace: true })}
                className="text-xs text-umc-700 underline hover:text-umc-900"
              >
                Reset filters
              </button>
            )}
            <p className="text-xs text-gray-500">
              {sorted.length === sermons.length
                ? `${sermons.length} sermon${sermons.length === 1 ? '' : 's'}`
                : `${sorted.length} of ${sermons.length}`}
            </p>
          </div>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="card text-center text-gray-500">
          {sermons.length === 0
            ? "No sermons in the archive yet."
            : 'No sermons match the current filters.'}
        </div>
      ) : (
        <ul className="space-y-3">
          {sorted.map((s) => (
            <li key={s.id}>
              <Link
                to={`/sermons/${s.id}`}
                className="card block hover:border-umc-300 hover:shadow-md transition"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      {s.original_sermon_number && (
                        <span className="text-xs text-gray-400 font-mono">
                          #{s.original_sermon_number}
                        </span>
                      )}
                      <h2 className="font-serif text-lg text-umc-900 truncate">
                        {s.title || (
                          <span className="italic text-gray-400">Untitled sermon</span>
                        )}
                      </h2>
                      {s.is_eulogy && (
                        <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded bg-gray-100 text-gray-600">
                          Eulogy
                        </span>
                      )}
                      {wfumcSermonIds.has(s.id) && (
                        <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded bg-umc-50 text-umc-900">
                          WFUMC
                        </span>
                      )}
                      {slideImageCounts.get(s.id) > 0 && (
                        <span
                          className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded bg-amber-50 text-amber-900 border border-amber-200"
                          title={`${slideImageCounts.get(s.id)} slide image${slideImageCounts.get(s.id) === 1 ? '' : 's'} uploaded. Click sermon to view the deck.`}
                        >
                          🖼️ {slideImageCounts.get(s.id)}
                        </span>
                      )}
                      {stashedBlockCounts.get(s.id) > 0 && (
                        <span
                          className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded bg-purple-50 text-purple-900 border border-purple-200"
                          title={`${stashedBlockCounts.get(s.id)} stashed block${stashedBlockCounts.get(s.id) === 1 ? '' : 's'} waiting for next preaching. Click sermon to view.`}
                        >
                          📌 {stashedBlockCounts.get(s.id)}
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-gray-600 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      {s.scripture_reference && (
                        <span>{s.scripture_reference}</span>
                      )}
                      {s.theme && (
                        <span className="italic text-gray-500">{s.theme}</span>
                      )}
                      {s.lectionary_year && (
                        <span className="text-gray-500">
                          {s.lectionary_year}
                        </span>
                      )}
                      {s.lastPreachedAt && (
                        <span className="text-gray-500">
                          Last: {fmtDate(s.lastPreachedAt)}
                        </span>
                      )}
                      {s.strength != null && (
                        <span className="text-umc-700 font-medium">
                          {s.strength}/10
                        </span>
                      )}
                    </div>
                    {s.manuscript_text ? (
                      <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                        {s.manuscript_text.slice(0, 200)}
                        {s.manuscript_text.length > 200 ? '…' : ''}
                      </p>
                    ) : s.major_stories ? (
                      <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                        {s.major_stories}
                      </p>
                    ) : null}
                  </div>
                  <span className="text-gray-400 mt-1">→</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
