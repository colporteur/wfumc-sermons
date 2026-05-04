import { useEffect, useRef, useState } from 'react';
import { supabase, withTimeout } from '../lib/supabase';

// Generic typeahead picker over a Supabase table. Used to pick a
// sermon to link to a liturgy AND a liturgy to link to a sermon.
//
// Props:
//   table          — Supabase table name ('sermons' | 'sermon_liturgies')
//   selectColumns  — comma-separated columns to fetch
//   searchColumns  — comma-separated columns the typeahead matches against
//                    (uses PostgREST .or() with ilike on each)
//   labelFor       — (row) => display label
//   subLabelFor    — (row) => optional second-line label (e.g., scripture)
//   excludeIds     — Set of row.id to omit from results (already linked)
//   onPick         — (row) => void
//   placeholder    — input placeholder
//   minChars       — min characters before searching (default 2)
//   limit          — max results (default 10)
export default function TypeaheadSearch({
  table,
  selectColumns,
  searchColumns,
  labelFor,
  subLabelFor,
  excludeIds = new Set(),
  onPick,
  placeholder = 'Search…',
  minChars = 2,
  limit = 10,
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Debounced query
  useEffect(() => {
    if (!q.trim() || q.trim().length < minChars) {
      setResults([]);
      setLoading(false);
      return;
    }
    const safe = q.replace(/[%_]/g, '');
    const orClause = searchColumns
      .split(',')
      .map((c) => `${c.trim()}.ilike.%${safe}%`)
      .join(',');

    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const { data, error: err } = await withTimeout(
          supabase
            .from(table)
            .select(selectColumns)
            .or(orClause)
            .limit(limit + excludeIds.size + 5)
        );
        if (cancelled) return;
        if (err) throw err;
        const filtered = (data || []).filter((r) => !excludeIds.has(r.id));
        setResults(filtered.slice(0, limit));
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, table, selectColumns, searchColumns, limit, minChars, excludeIds]);

  // Close on outside click
  useEffect(() => {
    const handler = (e) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const showDropdown = open && q.trim().length >= minChars;

  return (
    <div ref={wrapRef} className="relative w-full">
      <input
        type="text"
        className="input text-sm"
        placeholder={placeholder}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {showDropdown && (
        <div className="absolute z-20 left-0 right-0 mt-1 bg-white border border-gray-200 rounded shadow-lg max-h-72 overflow-y-auto">
          {loading && (
            <p className="px-3 py-2 text-xs text-gray-500 italic">Searching…</p>
          )}
          {error && (
            <p className="px-3 py-2 text-xs text-red-600">{error}</p>
          )}
          {!loading && !error && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-gray-500 italic">
              No matches.
            </p>
          )}
          {!loading && results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                onPick(r);
                setQ('');
                setResults([]);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-umc-50 border-b border-gray-100 last:border-b-0"
            >
              <div className="text-sm text-umc-900 truncate">
                {labelFor(r)}
              </div>
              {subLabelFor && subLabelFor(r) && (
                <div className="text-[11px] text-gray-500 truncate">
                  {subLabelFor(r)}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
