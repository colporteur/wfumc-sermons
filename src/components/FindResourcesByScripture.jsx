// "Find by scripture & themes" search card mounted on top of the
// Resources list. Two complementary match channels, unioned (OR):
//
//   1. Verse overlap — parse the scripture input via scripture.js's
//      parseScriptureRanges + rangesOverlap, then check each resource's
//      scripture_refs for ANY shared verse.
//   2. Theme match — Claude suggests themes from the scripture, the
//      pastor edits the list, then matches resources by themes. With
//      "semantic" on, Claude widens the candidate-theme set to include
//      synonyms / closely-related themes the pastor actually uses.
//
// The component owns its own input + theme state and reports the
// matched-ids set up to the parent (ResourceList) so the parent can
// restrict its existing filter pipeline.

import { useCallback, useMemo, useState } from 'react';
import {
  findSemanticallyMatchingThemes,
  suggestThemesFromScripture,
} from '../lib/claude';
import {
  parseScriptureRanges,
  rangesOverlap,
} from '../lib/scripture';

export default function FindResourcesByScripture({
  resources,
  scriptureRef,
  themes,
  semantic,
  onChange, // ({ scriptureRef, themes, semantic, matchedIdsByMode }) => void
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [themeInput, setThemeInput] = useState('');

  // Unique theme strings actually used across the pastor's resources.
  // Used as the CANDIDATE list for semantic matching.
  const allThemesInLibrary = useMemo(() => {
    const set = new Set();
    for (const r of resources || []) {
      for (const t of r.themes || []) {
        const v = String(t || '').trim();
        if (v) set.add(v);
      }
    }
    return Array.from(set).sort();
  }, [resources]);

  // --- compute matches ---------------------------------------------

  const computeMatches = useCallback(
    async ({ ref, themesList, useSemantic }) => {
      // matchedIdsByMode: { byScripture: Set, byThemes: Set }
      const out = { byScripture: new Set(), byThemes: new Set() };

      // Channel 1: verse overlap.
      if (ref && ref.trim()) {
        const targets = parseScriptureRanges(ref);
        if (targets.length > 0) {
          for (const r of resources) {
            if (!r.scripture_refs) continue;
            const rRanges = parseScriptureRanges(r.scripture_refs);
            let hit = false;
            for (const rr of rRanges) {
              for (const tr of targets) {
                if (rangesOverlap(rr, tr)) {
                  hit = true;
                  break;
                }
              }
              if (hit) break;
            }
            if (hit) out.byScripture.add(r.id);
          }
        }
      }

      // Channel 2: theme match.
      const cleanThemes = (themesList || [])
        .map((s) => String(s || '').trim())
        .filter(Boolean);
      if (cleanThemes.length > 0) {
        let matchSet = new Set(cleanThemes.map((s) => s.toLowerCase()));
        if (useSemantic) {
          try {
            const expanded = await findSemanticallyMatchingThemes(
              cleanThemes,
              allThemesInLibrary
            );
            for (const t of expanded) matchSet.add(t.toLowerCase());
          } catch (e) {
            // Soft-fail: fall back to literal matching only.
            // eslint-disable-next-line no-console
            console.warn('Semantic theme match failed:', e);
          }
        }
        for (const r of resources) {
          const rThemes = (r.themes || []).map((t) =>
            String(t || '').trim().toLowerCase()
          );
          if (rThemes.some((t) => matchSet.has(t))) {
            out.byThemes.add(r.id);
          }
        }
      }
      return out;
    },
    [resources, allThemesInLibrary]
  );

  // --- handlers ----------------------------------------------------

  const runSearch = async (
    nextRef = scriptureRef,
    nextThemes = themes,
    nextSemantic = semantic
  ) => {
    setBusy(true);
    setError(null);
    try {
      const matched = await computeMatches({
        ref: nextRef,
        themesList: nextThemes,
        useSemantic: nextSemantic,
      });
      onChange({
        scriptureRef: nextRef,
        themes: nextThemes,
        semantic: nextSemantic,
        matched,
      });
    } catch (e) {
      setError(e.message || 'Search failed');
    } finally {
      setBusy(false);
    }
  };

  const handleSuggestThemes = async () => {
    if (!scriptureRef.trim()) {
      setError('Enter a scripture reference first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const proposed = await suggestThemesFromScripture(scriptureRef);
      // Replace existing themes with the new proposals; pastor can edit.
      onChange({
        scriptureRef,
        themes: proposed,
        semantic,
        matched: null, // don't auto-run search; let pastor edit themes first
      });
    } catch (e) {
      setError(e.message || 'Theme suggestion failed');
    } finally {
      setBusy(false);
    }
  };

  const handleAddTheme = () => {
    const t = themeInput.trim();
    if (!t) return;
    if (themes.includes(t)) {
      setThemeInput('');
      return;
    }
    onChange({
      scriptureRef,
      themes: [...themes, t],
      semantic,
      matched: null,
    });
    setThemeInput('');
  };

  const handleRemoveTheme = (t) => {
    onChange({
      scriptureRef,
      themes: themes.filter((x) => x !== t),
      semantic,
      matched: null,
    });
  };

  const handleClear = () => {
    onChange({
      scriptureRef: '',
      themes: [],
      semantic: false,
      matched: { byScripture: new Set(), byThemes: new Set() },
    });
  };

  const hasInput = !!(scriptureRef.trim() || themes.length > 0);

  return (
    <div className="card space-y-3 border-umc-200">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-serif text-lg text-umc-900">
          Find by scripture & themes
        </h2>
        {hasInput && (
          <button
            type="button"
            onClick={handleClear}
            className="text-xs text-gray-500 hover:text-gray-800 underline"
            disabled={busy}
          >
            Clear
          </button>
        )}
      </div>

      {/* Scripture row */}
      <div>
        <label className="label" htmlFor="find-scripture">
          Scripture reference
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            id="find-scripture"
            type="text"
            className="input flex-1 min-w-[200px]"
            placeholder='e.g. "Matthew 9:9-13, 18-26"'
            value={scriptureRef}
            onChange={(e) =>
              onChange({
                scriptureRef: e.target.value,
                themes,
                semantic,
                matched: null,
              })
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runSearch();
              }
            }}
            disabled={busy}
          />
          <button
            type="button"
            onClick={handleSuggestThemes}
            disabled={busy || !scriptureRef.trim()}
            className="btn-secondary text-xs"
            title="Ask Claude for themes this passage opens up"
          >
            {busy ? '…' : '✨ Suggest themes'}
          </button>
        </div>
      </div>

      {/* Themes row */}
      <div>
        <label className="label">Themes</label>
        <div className="flex flex-wrap gap-2 mb-2">
          {themes.length === 0 ? (
            <span className="text-xs text-gray-400">
              No themes — type one below, or click ✨ Suggest themes.
            </span>
          ) : (
            themes.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-full bg-umc-50 text-umc-900 px-2.5 py-1 text-xs"
              >
                {t}
                <button
                  type="button"
                  onClick={() => handleRemoveTheme(t)}
                  className="text-umc-900 hover:text-red-600"
                  aria-label={`Remove theme ${t}`}
                  disabled={busy}
                >
                  ✕
                </button>
              </span>
            ))
          )}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            className="input flex-1"
            placeholder="Add a theme and press Enter"
            value={themeInput}
            onChange={(e) => setThemeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddTheme();
              }
            }}
            disabled={busy}
          />
          <button
            type="button"
            onClick={handleAddTheme}
            disabled={busy || !themeInput.trim()}
            className="btn-secondary text-xs"
          >
            Add
          </button>
        </div>
      </div>

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-3 pt-2 border-t">
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={semantic}
            onChange={(e) =>
              onChange({
                scriptureRef,
                themes,
                semantic: e.target.checked,
                matched: null,
              })
            }
            disabled={busy}
          />
          Semantic match (synonyms + closely-related themes)
        </label>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => runSearch()}
          disabled={busy || !hasInput}
          className="btn-primary text-sm disabled:opacity-50"
        >
          {busy ? 'Searching…' : 'Find resources'}
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}
    </div>
  );
}
