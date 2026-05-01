import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';

const TYPE_OPTIONS = [
  { value: 'any', label: 'All types' },
  { value: 'story', label: 'Stories' },
  { value: 'quote', label: 'Quotes' },
  { value: 'illustration', label: 'Illustrations' },
  { value: 'joke', label: 'Jokes' },
  { value: 'note', label: 'Notes' },
];

const TYPE_BADGE = {
  story: { label: 'Story', cls: 'bg-blue-100 text-blue-800' },
  quote: { label: 'Quote', cls: 'bg-purple-100 text-purple-800' },
  illustration: { label: 'Illustration', cls: 'bg-amber-100 text-amber-800' },
  joke: { label: 'Joke', cls: 'bg-green-100 text-green-800' },
  note: { label: 'Note', cls: 'bg-gray-200 text-gray-700' },
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
  sort: 'created_desc',
};

export default function ResourceList() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [resources, setResources] = useState([]);
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
        const { data, error: err } = await withTimeout(
          supabase
            .from('resources')
            .select('*')
            .eq('owner_user_id', user.id)
            .order('created_at', { ascending: false })
        );
        if (err) throw err;
        if (cancelled) return;
        setResources(data ?? []);
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

  const filtered = useMemo(() => {
    const q = filters.search.trim().toLowerCase();
    const themeQ = filters.theme.trim().toLowerCase();
    let out = resources.filter((r) => {
      if (filters.type !== 'any' && r.resource_type !== filters.type) return false;
      if (themeQ && !(r.themes ?? []).some((t) => t.toLowerCase() === themeQ))
        return false;
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
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl text-umc-900">Resources</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Stories, quotes, illustrations, and notes for sermon prep.
          </p>
        </div>
        <Link to="/resources/new" className="btn-primary text-sm whitespace-nowrap">
          + New resource
        </Link>
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
            <label className="label">Theme</label>
            <select
              className="input"
              value={filters.theme}
              onChange={(e) => updateFilter('theme', e.target.value)}
            >
              <option value="">Any theme</option>
              {allThemes.map((t) => (
                <option key={t} value={t}>
                  {t}
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
        </div>
        <div className="flex items-center justify-between text-xs text-gray-500">
          <span>
            Showing {filtered.length} of {resources.length}
          </span>
          {(filters.search || filters.type !== 'any' || filters.theme) && (
            <button
              type="button"
              onClick={() => setFilters(DEFAULT_FILTERS)}
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
            return (
              <li key={r.id}>
                <Link
                  to={`/resources/${r.id}`}
                  className="card block hover:border-umc-700 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
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
                      </div>
                      <p className="mt-2 text-sm text-gray-700 line-clamp-3 whitespace-pre-wrap">
                        {r.content}
                      </p>
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
    </div>
  );
}
