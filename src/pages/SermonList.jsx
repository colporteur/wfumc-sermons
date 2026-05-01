import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { booksFromReference } from '../lib/scripture';
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

export default function SermonList() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sermons, setSermons] = useState([]);
  // Set of sermon IDs (from THIS user's preachings) that are flagged
  // as preached at our church. Used for the WFUMC badge + filter.
  const [wfumcSermonIds, setWfumcSermonIds] = useState(new Set());
  const [filters, setFilters] = useState(DEFAULT_FILTERS);

  const updateFilter = (key, value) =>
    setFilters((f) => ({ ...f, [key]: value }));

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [sermonRes, preachRes] = await Promise.all([
          withTimeout(
            supabase
              .from('sermons')
              .select('*')
              .eq('owner_user_id', user.id)
              .order('preached_at', { ascending: false, nullsFirst: false })
              .order('created_at', { ascending: false })
          ),
          withTimeout(
            supabase
              .from('preachings')
              .select('sermon_id')
              .eq('owner_user_id', user.id)
              .eq('is_at_our_church', true)
          ),
        ]);
        if (sermonRes.error) throw sermonRes.error;
        if (preachRes.error) throw preachRes.error;
        if (!cancelled) {
          setSermons(sermonRes.data ?? []);
          setWfumcSermonIds(
            new Set((preachRes.data ?? []).map((p) => p.sermon_id))
          );
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

  // Annotate each sermon with its parsed list of bible books once
  const sermonsWithBooks = useMemo(
    () =>
      sermons.map((s) => ({
        ...s,
        books: booksFromReference(s.scripture_reference),
      })),
    [sermons]
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
          if (!a.preached_at && !b.preached_at) return 0;
          if (!a.preached_at) return 1;
          if (!b.preached_at) return -1;
          return cmp(a.preached_at, b.preached_at, 1);
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
        arr.sort((a, b) => {
          if (!a.preached_at && !b.preached_at) return 0;
          if (!a.preached_at) return 1;
          if (!b.preached_at) return -1;
          return cmp(a.preached_at, b.preached_at, -1);
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
        <Link to="/sermons/new" className="btn-primary whitespace-nowrap">
          + New sermon
        </Link>
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
                onClick={() => setFilters(DEFAULT_FILTERS)}
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
                      {s.preached_at && (
                        <span className="text-gray-500">
                          {fmtDate(s.preached_at)}
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
