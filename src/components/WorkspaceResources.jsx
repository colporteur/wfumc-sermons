import { useEffect, useState } from 'react';
import {
  searchResources,
  suggestResourcesByScripture,
} from '../lib/workspaceResources';

// Resource picker that lives at the top of SermonWorkspace. Lets the
// pastor:
//   - See which resources are currently selected for the next Claude turn
//   - Search resources by free text and add results
//   - Auto-suggest resources whose scripture overlaps the sermon's
//     scripture reference (button) — same matcher the worship planner
//     uses on its intelligence panel
//   - Remove individual resources from the selection
//
// Selection state is owned by the parent (SermonWorkspace) so it can
// pass the resources into reviseSermonManuscript().
//
// Collapsible: starts expanded if there's a scripture but no selection
// yet (an invitation to pick some), collapsed otherwise — keeps the
// chat + manuscript area visually dominant during a long revision
// session.
export default function WorkspaceResources({
  scriptureReference,
  selectedResources,
  setSelectedResources,
}) {
  const [collapsed, setCollapsed] = useState(
    () => selectedResources.length > 0
  );

  const [suggestions, setSuggestions] = useState(null); // null = not run yet
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);

  const [error, setError] = useState(null);

  // Debounced free-text search.
  useEffect(() => {
    const q = searchQ.trim();
    if (q.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const rows = await searchResources(q);
        setSearchResults(rows);
      } catch (e) {
        setError(e.message || String(e));
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [searchQ]);

  const handleRunSuggestions = async () => {
    if (!scriptureReference) {
      setError(
        'Set a scripture reference on this sermon first — the matcher needs a starting point.'
      );
      return;
    }
    setLoadingSuggestions(true);
    setError(null);
    try {
      const rows = await suggestResourcesByScripture(scriptureReference);
      setSuggestions(rows);
      setCollapsed(false);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoadingSuggestions(false);
    }
  };

  const isSelected = (id) => selectedResources.some((r) => r.id === id);

  const addOne = (r) => {
    if (isSelected(r.id)) return;
    setSelectedResources([...selectedResources, r]);
  };

  const removeOne = (id) => {
    setSelectedResources(selectedResources.filter((r) => r.id !== id));
  };

  const clearAll = () => {
    if (
      selectedResources.length > 0 &&
      !window.confirm('Remove all selected resources from the next Claude turn?')
    ) {
      return;
    }
    setSelectedResources([]);
  };

  return (
    <div className="card space-y-2">
      {/* Header bar — always visible */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-baseline gap-2 text-left"
        >
          <span className="font-serif text-lg text-umc-900">
            Resources for next turn
          </span>
          <span className="text-sm text-gray-500">
            {selectedResources.length === 0
              ? '(none selected)'
              : `(${selectedResources.length} selected)`}
          </span>
          <span className="text-xs text-gray-400">
            {collapsed ? '▼ expand' : '▲ collapse'}
          </span>
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleRunSuggestions}
            disabled={loadingSuggestions || !scriptureReference}
            className="btn-secondary text-xs disabled:opacity-50"
            title={
              !scriptureReference
                ? 'Set a scripture reference on this sermon to enable scripture-based suggestions.'
                : 'Find resources whose scripture refs overlap this sermon.'
            }
          >
            {loadingSuggestions
              ? 'Suggesting…'
              : 'Suggest from scripture'}
          </button>
          {selectedResources.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="text-xs text-gray-500 hover:text-red-700 underline"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Selected chips — always visible, even when collapsed */}
      {selectedResources.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedResources.map((r) => (
            <span
              key={r.id}
              className="inline-flex items-center gap-1 bg-umc-50 border border-umc-200 rounded-full px-2 py-0.5 text-xs text-umc-900"
            >
              <span className="truncate max-w-[14rem]" title={r.title}>
                {r.title || '(untitled)'}
              </span>
              <button
                type="button"
                onClick={() => removeOne(r.id)}
                className="text-umc-700 hover:text-red-700"
                title="Remove from this turn"
                aria-label="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </p>
      )}

      {!collapsed && (
        <div className="border-t border-gray-100 pt-3 space-y-3">
          {/* Free-text search */}
          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
              Search resources
            </label>
            <input
              type="text"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="Title, content, or scripture…"
              className="input w-full text-sm"
            />
            {searching && (
              <p className="text-xs text-gray-500 italic mt-1">Searching…</p>
            )}
            {!searching && searchQ.trim().length >= 2 && searchResults.length === 0 && (
              <p className="text-xs text-gray-500 italic mt-1">No matches.</p>
            )}
            {searchResults.length > 0 && (
              <ResourceList
                rows={searchResults}
                isSelected={isSelected}
                onAdd={addOne}
                onRemove={removeOne}
                showOverlap={false}
              />
            )}
          </div>

          {/* Scripture-overlap suggestions */}
          {suggestions !== null && (
            <div>
              <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
                Scripture overlap suggestions
                {suggestions.length === 0 && (
                  <span className="ml-2 normal-case text-gray-400">
                    nothing matched
                  </span>
                )}
              </label>
              {suggestions.length > 0 && (
                <ResourceList
                  rows={suggestions}
                  isSelected={isSelected}
                  onAdd={addOne}
                  onRemove={removeOne}
                  showOverlap
                />
              )}
            </div>
          )}

          {selectedResources.length === 0 &&
            suggestions === null &&
            searchQ.trim().length < 2 && (
              <p className="text-xs text-gray-500 italic">
                Search above, or click "Suggest from scripture" to surface
                stories, illustrations, and quotes whose scripture refs
                overlap your sermon. Selected resources get sent to
                Claude with the manuscript on the next revision turn.
              </p>
            )}
        </div>
      )}
    </div>
  );
}

function ResourceList({ rows, isSelected, onAdd, onRemove, showOverlap }) {
  return (
    <ul className="mt-2 max-h-72 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded">
      {rows.map((r) => {
        const selected = isSelected(r.id);
        const snippet = (r.content || '').replace(/\s+/g, ' ').slice(0, 140);
        return (
          <li key={r.id} className="p-2 flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-umc-900 font-medium truncate">
                {r.title || '(untitled)'}
                {r.resource_type && (
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-500">
                    {r.resource_type}
                  </span>
                )}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {snippet}
                {r.content && r.content.length > 140 && '…'}
              </p>
              <p className="text-[10px] text-gray-400 mt-0.5 flex flex-wrap gap-x-2">
                {r.scripture_refs && <span>Scripture: {r.scripture_refs}</span>}
                {Array.isArray(r.themes) && r.themes.length > 0 && (
                  <span>Themes: {r.themes.join(', ')}</span>
                )}
                {showOverlap && r._overlap_books?.length > 0 && (
                  <span className="text-green-700">
                    Matches: {r._overlap_books.join(', ')}
                  </span>
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() => (selected ? onRemove(r.id) : onAdd(r))}
              className={
                'shrink-0 text-xs rounded px-2 py-1 ' +
                (selected
                  ? 'bg-umc-50 text-umc-900 border border-umc-200 hover:bg-red-50 hover:text-red-700'
                  : 'btn-secondary')
              }
              title={selected ? 'Remove from selection' : 'Add to selection'}
            >
              {selected ? '✓ Selected' : '+ Add'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
