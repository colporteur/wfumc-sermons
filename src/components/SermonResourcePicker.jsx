// Inline picker used by the "Draft in Workspace" entry page so the
// pastor can pick one or more resources to start the sermon from.
//
// Two complementary sources of candidates:
//   1. Scripture-overlap suggestions — when scripture is filled in,
//      surface resources whose scripture_refs overlap that passage.
//      Refreshes when scripture changes (debounced).
//   2. Free-text search — bottom box, searches title / content /
//      source / themes across the whole library.
//
// The component owns nothing persistent — it just emits the current
// selection (array of resource objects) up to the parent via onChange.
// The parent decides what to do at submit time.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  searchResources,
  suggestResourcesByScripture,
} from '../lib/workspaceResources';

const TYPE_BADGE = {
  story: 'bg-blue-100 text-blue-800',
  quote: 'bg-purple-100 text-purple-800',
  illustration: 'bg-amber-100 text-amber-800',
  joke: 'bg-green-100 text-green-800',
  note: 'bg-gray-200 text-gray-700',
  photo: 'bg-pink-100 text-pink-800',
  exegesis: 'bg-cyan-100 text-cyan-800',
};

export default function SermonResourcePicker({
  scriptureRef,
  selected, // array of resource objects, owned by parent
  onChange,
  disabled = false,
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);
  // When ticked, scripture-overlap suggestions also include resources
  // tagged with parallel passages in Mark / Luke / John (per Aland's
  // synopsis). Off by default — only changes the suggestions list, not
  // free-text search.
  const [synopticParallels, setSynopticParallels] = useState(false);
  // Track which scripture ref we last fetched for so a stale callback
  // doesn't overwrite a newer fetch result.
  const lastScriptureRef = useRef('');

  const selectedIds = useMemo(
    () => new Set(selected.map((r) => r.id)),
    [selected]
  );

  // --- scripture-overlap suggestions, debounced -------------------
  // Re-fires when either the scripture reference or the synoptic-
  // parallels flag changes so the list reflects the current toggle.
  useEffect(() => {
    const ref = (scriptureRef || '').trim();
    lastScriptureRef.current = ref;
    if (!ref) {
      setSuggestions([]);
      return;
    }
    setSuggestionsLoading(true);
    setError(null);
    const handle = setTimeout(async () => {
      try {
        const rows = await suggestResourcesByScripture(ref, {
          limit: 20,
          includeSynopticParallels: synopticParallels,
        });
        // Guard against an older request resolving after a newer one.
        if (lastScriptureRef.current !== ref) return;
        setSuggestions(rows || []);
      } catch (e) {
        if (lastScriptureRef.current !== ref) return;
        setError(e.message || 'Failed to load suggestions');
      } finally {
        if (lastScriptureRef.current === ref) {
          setSuggestionsLoading(false);
        }
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [scriptureRef, synopticParallels]);

  // --- free-text search, debounced --------------------------------
  useEffect(() => {
    const q = searchTerm.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    setError(null);
    const handle = setTimeout(async () => {
      try {
        const rows = await searchResources(q, { limit: 20 });
        setSearchResults(rows || []);
      } catch (e) {
        setError(e.message || 'Search failed');
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [searchTerm]);

  const add = useCallback(
    (resource) => {
      if (!resource || selectedIds.has(resource.id)) return;
      onChange([...selected, resource]);
    },
    [onChange, selected, selectedIds]
  );

  const remove = useCallback(
    (resourceId) => {
      onChange(selected.filter((r) => r.id !== resourceId));
    },
    [onChange, selected]
  );

  // Hide rows already in the selected chip strip — keeps the lists
  // tidy and avoids confusing double-adds.
  const visibleSuggestions = useMemo(
    () => suggestions.filter((r) => !selectedIds.has(r.id)),
    [suggestions, selectedIds]
  );
  const visibleSearch = useMemo(
    () => searchResults.filter((r) => !selectedIds.has(r.id)),
    [searchResults, selectedIds]
  );

  return (
    <div className="space-y-3">
      {/* Selected chips */}
      {selected.length === 0 ? (
        <p className="text-xs text-gray-500 italic">
          No resources selected. Pick from suggestions or search below.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {selected.map((r) => {
            const badgeCls = TYPE_BADGE[r.resource_type] || TYPE_BADGE.note;
            return (
              <li
                key={r.id}
                className="inline-flex items-center gap-2 max-w-full bg-umc-50 border border-umc-200 rounded pl-2 pr-1 py-1"
                title={r.content?.slice(0, 200)}
              >
                <span
                  className={`text-[9px] uppercase tracking-wide px-1 rounded ${badgeCls}`}
                >
                  {r.resource_type}
                </span>
                <span className="text-xs text-umc-900 truncate max-w-xs">
                  {r.title || '(untitled)'}
                </span>
                <button
                  type="button"
                  onClick={() => remove(r.id)}
                  disabled={disabled}
                  className="text-umc-900 hover:text-red-600 text-sm leading-none px-1"
                  aria-label="Remove"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </p>
      )}

      {/* Scripture-overlap suggestions */}
      <div>
        <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
          <p className="text-xs text-gray-600 font-medium">
            Suggested by scripture overlap
            {scriptureRef ? ` — ${scriptureRef}` : ''}
          </p>
          <label
            className="inline-flex items-center gap-1.5 text-[11px] text-gray-700 cursor-pointer"
            title="Also include resources tagged with parallel passages in Matthew, Mark, Luke, or John (per Aland's synopsis)."
          >
            <input
              type="checkbox"
              checked={synopticParallels}
              onChange={(e) => setSynopticParallels(e.target.checked)}
              disabled={disabled || !scriptureRef.trim()}
              className="rounded"
            />
            Match synoptic parallels
          </label>
        </div>
        {!scriptureRef.trim() ? (
          <p className="text-xs text-gray-400 italic">
            Enter a scripture reference above to see suggestions.
          </p>
        ) : suggestionsLoading ? (
          <p className="text-xs text-gray-400">Loading…</p>
        ) : visibleSuggestions.length === 0 ? (
          <p className="text-xs text-gray-400 italic">
            {suggestions.length > 0
              ? 'All overlapping resources already selected.'
              : 'No resources match this scripture yet.'}
          </p>
        ) : (
          <ResourceRowList rows={visibleSuggestions} onPick={add} disabled={disabled} />
        )}
      </div>

      {/* Free-text search */}
      <div>
        <p className="text-xs text-gray-600 font-medium mb-1">
          Or search the full library
        </p>
        <input
          type="search"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search by title, content, theme, source…"
          className="input text-sm"
          disabled={disabled}
        />
        {searchTerm.trim() && (
          <div className="mt-2">
            {searching ? (
              <p className="text-xs text-gray-400">Searching…</p>
            ) : visibleSearch.length === 0 ? (
              <p className="text-xs text-gray-400 italic">
                {searchResults.length > 0
                  ? 'All matches already selected.'
                  : 'No matches.'}
              </p>
            ) : (
              <ResourceRowList rows={visibleSearch} onPick={add} disabled={disabled} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ResourceRowList({ rows, onPick, disabled }) {
  return (
    <ul className="border border-gray-200 rounded divide-y divide-gray-100 max-h-64 overflow-y-auto">
      {rows.map((r) => {
        const badgeCls = TYPE_BADGE[r.resource_type] || TYPE_BADGE.note;
        return (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onPick(r)}
              disabled={disabled}
              className="w-full text-left px-3 py-2 hover:bg-gray-50 disabled:opacity-50 text-sm"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`text-[9px] uppercase tracking-wide px-1 rounded ${badgeCls}`}
                >
                  {r.resource_type}
                </span>
                <span className="font-medium text-umc-900 truncate flex-1">
                  {r.title || '(untitled)'}
                </span>
                {r.scripture_refs && (
                  <span className="text-[11px] text-gray-500 truncate max-w-[200px]">
                    {r.scripture_refs}
                  </span>
                )}
              </div>
              {/* When the lib annotated this row with which range(s)
                  matched, show them — especially useful for parallel
                  matches that include "(parallel of Matt 9:9-13)". */}
              {Array.isArray(r._overlap_labels) && r._overlap_labels.length > 0 && (
                <p className="text-[11px] text-emerald-700 mt-0.5">
                  matches {r._overlap_labels.join(', ')}
                </p>
              )}
              {r.content && (
                <p className="text-xs text-gray-600 mt-0.5 line-clamp-2">
                  {r.content}
                </p>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
