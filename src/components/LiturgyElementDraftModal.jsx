import { useEffect, useState } from 'react';
import { draftLiturgyElement } from '../lib/claude';
import {
  loadInstructionsForElement,
  saveInstructionsForElement,
  ensureLiturgyTheme,
  regenerateLiturgyTheme,
} from '../lib/liturgyInstructions';
import { getElementLabel } from '../lib/worshipElements';

// Modal: Claude drafts a single liturgy element. Two ways the pastor
// can shape what Claude produces:
//
//   1) Pastor's standing instructions for this element type (loaded
//      from liturgy_element_instructions, editable in-modal, can be
//      saved as the new default with the "Save as my default for X"
//      checkbox).
//   2) The linked sermon's spoiler-safe theme (generated lazily if
//      not already cached). Pastor can skip including the theme.
//
// On "Apply", the drafted text is sent back to the parent (which
// updates the element body in DB + state).
//
// Props:
//   element         - the sermon_liturgy_sections row
//   scriptureRefs   - liturgy.scripture_refs string (multi-OK)
//   linkedSermon    - { id, title, scripture_reference, manuscript_text, liturgy_theme } or null
//   ownerUserId     - current user
//   onApply         - (newBody) => void
//   onClose         - () => void
export default function LiturgyElementDraftModal({
  element,
  scriptureRefs,
  linkedSermon: initialSermon,
  ownerUserId,
  onApply,
  onClose,
}) {
  const elementType = element.section_kind;
  const elementLabel = getElementLabel(elementType);

  const [linkedSermon, setLinkedSermon] = useState(initialSermon);
  const [instructions, setInstructions] = useState('');
  const [savedInstructions, setSavedInstructions] = useState('');
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [useTheme, setUseTheme] = useState(true);
  const [theme, setTheme] = useState(initialSermon?.liturgy_theme || '');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [drafting, setDrafting] = useState(false);
  const [refreshingTheme, setRefreshingTheme] = useState(false);
  const [error, setError] = useState(null);

  // Load saved instructions for this element type on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await loadInstructionsForElement(ownerUserId, elementType);
        if (cancelled) return;
        setInstructions(saved);
        setSavedInstructions(saved);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerUserId, elementType]);

  const handleRefreshTheme = async () => {
    if (!linkedSermon?.id) return;
    setRefreshingTheme(true);
    setError(null);
    try {
      const fresh = await regenerateLiturgyTheme(linkedSermon);
      setTheme(fresh);
      setLinkedSermon({ ...linkedSermon, liturgy_theme: fresh });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setRefreshingTheme(false);
    }
  };

  const handleDraft = async () => {
    setDrafting(true);
    setError(null);
    try {
      // Lazy-fetch theme if we want it and don't have it yet.
      let resolvedTheme = useTheme ? theme : '';
      if (useTheme && !resolvedTheme && linkedSermon) {
        resolvedTheme = await ensureLiturgyTheme(linkedSermon);
        setTheme(resolvedTheme);
      }

      // Persist updated instructions if asked.
      if (saveAsDefault && instructions !== savedInstructions) {
        await saveInstructionsForElement(
          ownerUserId,
          elementType,
          instructions
        );
        setSavedInstructions(instructions);
      }

      const newDraft = await draftLiturgyElement({
        elementType,
        elementLabel,
        scriptureRefs,
        sermonTheme: resolvedTheme,
        pastorInstructions: instructions,
      });
      setDraft(newDraft);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setDrafting(false);
    }
  };

  const handleApply = () => {
    if (!draft.trim()) return;
    onApply(draft);
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-3xl w-full my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-gray-100 flex items-baseline justify-between gap-2">
          <div>
            <h2 className="font-serif text-xl text-umc-900">
              ✨ Draft {elementLabel}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Claude drafts a single element. You'll review before it
              replaces the current text.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Scripture summary */}
          <div className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded px-3 py-2">
            <span className="font-medium">Scripture:</span>{' '}
            {scriptureRefs ? (
              scriptureRefs
            ) : (
              <span className="italic text-amber-700">
                No scripture set on this liturgy. Add one in the
                liturgy header for stronger drafts.
              </span>
            )}
          </div>

          {/* Sermon theme */}
          {linkedSermon ? (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <label className="text-xs font-medium text-gray-700 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={useTheme}
                    onChange={(e) => setUseTheme(e.target.checked)}
                  />
                  Use spoiler-safe theme from "{linkedSermon.title}"
                </label>
                <button
                  type="button"
                  onClick={handleRefreshTheme}
                  disabled={refreshingTheme || !linkedSermon?.manuscript_text}
                  className="text-[11px] text-umc-700 hover:text-umc-900 underline disabled:opacity-50"
                  title="Regenerate the theme summary (e.g. after manuscript edits)"
                >
                  {refreshingTheme ? 'Refreshing…' : '↻ Refresh theme'}
                </button>
              </div>
              {useTheme && theme && (
                <p className="text-xs text-gray-600 italic bg-amber-50 border border-amber-100 rounded px-3 py-2 whitespace-pre-wrap">
                  {theme}
                </p>
              )}
              {useTheme && !theme && (
                <p className="text-[11px] text-gray-500 italic">
                  Theme will be generated on first draft (one-time
                  Claude call, cached for next time).
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-500 italic">
              No sermon linked to this liturgy — draft will use scripture
              + your instructions only.
            </p>
          )}

          {/* Pastor instructions */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Your instructions for drafting a {elementLabel}
            </label>
            <textarea
              className="input w-full text-sm min-h-[100px]"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={`e.g. "Always include a Trinitarian formula. Use responsive format with Leader/People. Keep under 8 lines."`}
              disabled={loading || drafting}
            />
            <label className="mt-1.5 flex items-center gap-2 text-[11px] text-gray-700">
              <input
                type="checkbox"
                checked={saveAsDefault}
                onChange={(e) => setSaveAsDefault(e.target.checked)}
                disabled={loading || drafting}
              />
              Save as my default for {elementLabel}
              {savedInstructions !== instructions && savedInstructions && (
                <span className="text-gray-400">
                  (overrides your saved guidance)
                </span>
              )}
            </label>
          </div>

          {/* Draft button */}
          <div>
            <button
              type="button"
              onClick={handleDraft}
              disabled={drafting || loading}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {drafting ? 'Drafting…' : draft ? '↻ Draft again' : '✨ Draft with Claude'}
            </button>
          </div>

          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 whitespace-pre-wrap">
              {error}
            </p>
          )}

          {/* Draft output */}
          {draft && (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-gray-700">
                Draft (editable — tweak before applying)
              </label>
              <textarea
                className="input w-full font-serif text-sm leading-relaxed min-h-[200px]"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary text-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!draft.trim() || drafting}
            className="btn-primary text-sm disabled:opacity-50"
          >
            Apply to element
          </button>
        </div>
      </div>
    </div>
  );
}
