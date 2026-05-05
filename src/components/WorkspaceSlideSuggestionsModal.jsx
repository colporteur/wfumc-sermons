import { useState } from 'react';
import { suggestSlidesForManuscript } from '../lib/claude';
import { paragraphPreview } from '../lib/paragraphs';
import { SLIDE_TYPES } from '../lib/workspaceSlides';

// Modal that asks Claude for a batch of slide suggestions, then lets
// the pastor accept / edit / reject each one before they land in the
// workspace_slides table.
//
// Flow:
//   1. Open modal → "Generate suggestions" button (or auto-run on open).
//      The button is the entry point so the pastor can adjust the
//      "skip already-anchored paragraphs" toggle first if needed.
//   2. Claude runs against the manuscript with paragraph indices.
//      Loading state with a spinner.
//   3. Suggestions render as a list of cards. Each has:
//        - Accept checkbox (default ON)
//        - Type, title, body, notes, anchor preview, rationale
//        - "Edit" toggle to tweak title/body/notes/anchor before accept
//   4. Bulk actions: Select all / None.
//   5. "Add N slides" creates the accepted (possibly edited) suggestions.
//
// Props:
//   open                 — boolean
//   onClose              — close handler
//   sermon               — sermon row (for title/scripture context)
//   manuscript           — current manuscript text
//   skipParagraphIdxs    — paragraph indices that already have slides
//   paragraphs           — [{idx, text}] from splitManuscriptParagraphs
//   onAccept(suggestions)— callback with the accepted suggestion objects;
//                          parent creates the slide rows and refreshes.
export default function WorkspaceSlideSuggestionsModal({
  open,
  onClose,
  sermon,
  manuscript,
  skipParagraphIdxs = [],
  paragraphs = [],
  onAccept,
}) {
  const [skipExisting, setSkipExisting] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [suggestions, setSuggestions] = useState(null); // null = not generated yet
  const [accepting, setAccepting] = useState(false);

  if (!open) return null;

  const handleClose = () => {
    setSuggestions(null);
    setError(null);
    setLoading(false);
    onClose();
  };

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setSuggestions(null);
    try {
      const items = await suggestSlidesForManuscript({
        sermon,
        manuscript,
        skipParagraphIdxs: skipExisting ? skipParagraphIdxs : [],
      });
      // Annotate each item with UI state: accepted (default true), and a
      // local id for React keys.
      const decorated = items.map((it, i) => ({
        ...it,
        _localId: `s${i}`,
        accepted: true,
        editing: false,
      }));
      setSuggestions(decorated);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const updateSuggestion = (id, patch) => {
    setSuggestions((prev) =>
      prev.map((s) => (s._localId === id ? { ...s, ...patch } : s))
    );
  };

  const acceptedCount = (suggestions || []).filter((s) => s.accepted).length;

  const setAllAccepted = (val) => {
    setSuggestions((prev) =>
      prev.map((s) => ({ ...s, accepted: val }))
    );
  };

  const handleAccept = async () => {
    if (!suggestions) return;
    const accepted = suggestions.filter((s) => s.accepted);
    if (accepted.length === 0) {
      setError('Nothing selected.');
      return;
    }
    setAccepting(true);
    setError(null);
    try {
      // Strip the UI-only fields before handing back to the parent.
      const cleaned = accepted.map((s) => ({
        slide_type: s.slide_type,
        title: s.title,
        body: s.body,
        notes: s.notes,
        anchor_paragraph_idx: s.anchor_paragraph_idx,
        anchor_paragraph_text: s.anchor_paragraph_text,
      }));
      await onAccept(cleaned);
      handleClose();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-stretch sm:items-center justify-center p-0 sm:p-4"
      onClick={handleClose}
    >
      <div
        className="bg-white w-full sm:max-w-3xl sm:rounded-lg shadow-xl flex flex-col max-h-screen sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-200 flex items-baseline justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="font-serif text-lg text-umc-900 truncate">
              Suggest slides
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Claude will read the manuscript and propose a batch of
              slides — title, scripture, pull quotes, content, and image
              concepts. You decide which to accept.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-700 text-sm"
          >
            Close
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </p>
          )}

          {!suggestions && !loading && (
            <div className="space-y-3">
              {skipParagraphIdxs.length > 0 && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={skipExisting}
                    onChange={(e) => setSkipExisting(e.target.checked)}
                  />
                  <span>
                    Skip paragraphs that already have a slide anchored
                    ({skipParagraphIdxs.length} so far)
                  </span>
                </label>
              )}
              <p className="text-xs text-gray-500">
                Claude is told to aim for ONE slide per major beat, not
                one per paragraph. Expect roughly 8-15 suggestions for a
                normal-length manuscript. The list below will let you
                accept, edit, or reject each one before they land in
                your slide deck.
              </p>
              <button
                type="button"
                onClick={handleGenerate}
                className="btn-primary text-sm"
              >
                Generate suggestions
              </button>
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-sm text-gray-500 italic">
              <Spinner /> Asking Claude for suggestions… this can take 30-60
              seconds for a long manuscript.
            </div>
          )}

          {suggestions && suggestions.length === 0 && (
            <p className="text-sm text-gray-500 italic">
              Claude didn't propose any new slides — either every major
              beat already has a slide, or the manuscript is too short
              for slide-level suggestions.
            </p>
          )}

          {suggestions && suggestions.length > 0 && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="text-gray-600">
                  {acceptedCount} of {suggestions.length} selected
                </span>
                <span className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => setAllAccepted(true)}
                    className="text-umc-700 hover:text-umc-900 underline"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={() => setAllAccepted(false)}
                    className="text-gray-600 hover:text-gray-900 underline"
                  >
                    Select none
                  </button>
                  <button
                    type="button"
                    onClick={handleGenerate}
                    className="text-gray-600 hover:text-gray-900 underline"
                  >
                    Re-run
                  </button>
                </span>
              </div>

              <ul className="space-y-2">
                {suggestions.map((s, i) => (
                  <SuggestionCard
                    key={s._localId}
                    index={i}
                    suggestion={s}
                    paragraphs={paragraphs}
                    onUpdate={(patch) => updateSuggestion(s._localId, patch)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={handleClose}
            disabled={accepting}
            className="btn-secondary text-sm"
          >
            Cancel
          </button>
          {suggestions && suggestions.length > 0 && (
            <button
              type="button"
              onClick={handleAccept}
              disabled={accepting || acceptedCount === 0}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {accepting
                ? 'Adding…'
                : `Add ${acceptedCount} slide${acceptedCount === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SuggestionCard({ index, suggestion, paragraphs, onUpdate }) {
  const s = suggestion;
  const editing = s.editing;
  const typeLabel =
    SLIDE_TYPES.find((t) => t.value === s.slide_type)?.label || s.slide_type;
  const anchorPara =
    s.anchor_paragraph_idx !== null
      ? paragraphs.find((p) => p.idx === s.anchor_paragraph_idx)
      : null;

  return (
    <li
      className={
        'rounded border px-3 py-2 ' +
        (s.accepted
          ? 'border-umc-200 bg-umc-50/30'
          : 'border-gray-200 bg-white opacity-70')
      }
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={s.accepted}
          onChange={(e) => onUpdate({ accepted: e.target.checked })}
          className="mt-1"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-xs text-gray-500">#{index + 1}</span>
              {editing ? (
                <select
                  value={s.slide_type}
                  onChange={(e) => onUpdate({ slide_type: e.target.value })}
                  className="text-xs border border-gray-300 rounded px-1 py-0.5"
                >
                  {SLIDE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-[10px] uppercase tracking-wide text-gray-500">
                  {typeLabel}
                </span>
              )}
              {!editing && s.title && (
                <span className="text-sm font-medium text-umc-900">
                  {s.title}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => onUpdate({ editing: !editing })}
              className="text-[10px] text-gray-600 hover:text-umc-900 underline"
            >
              {editing ? 'Done editing' : 'Edit'}
            </button>
          </div>

          {editing ? (
            <div className="mt-2 space-y-1">
              <input
                type="text"
                value={s.title}
                onChange={(e) => onUpdate({ title: e.target.value })}
                placeholder="Title"
                className="input w-full text-sm"
              />
              <textarea
                value={s.body}
                onChange={(e) => onUpdate({ body: e.target.value })}
                rows={3}
                placeholder="Body"
                className="input w-full text-sm"
              />
              <textarea
                value={s.notes}
                onChange={(e) => onUpdate({ notes: e.target.value })}
                rows={2}
                placeholder="Speaker notes"
                className="input w-full text-xs"
              />
              <select
                value={
                  s.anchor_paragraph_idx === null
                    ? ''
                    : String(s.anchor_paragraph_idx)
                }
                onChange={(e) => {
                  const v = e.target.value;
                  const idx = v === '' ? null : Number(v);
                  onUpdate({
                    anchor_paragraph_idx: idx,
                    anchor_paragraph_text:
                      idx === null ? null : paragraphs[idx]?.text || null,
                  });
                }}
                className="input w-full text-xs"
              >
                <option value="">Unanchored</option>
                {paragraphs.map((p) => (
                  <option key={p.idx} value={String(p.idx)}>
                    ¶{p.idx + 1}: {paragraphPreview(p.text, 60)}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <>
              {s.body && (
                <p className="text-xs text-gray-700 mt-1 whitespace-pre-wrap">
                  {s.body}
                </p>
              )}
              {s.notes && (
                <p className="text-[10px] text-gray-500 italic mt-1">
                  Notes: {s.notes}
                </p>
              )}
              {s.rationale && (
                <p className="text-[10px] text-gray-400 mt-1">
                  Why: {s.rationale}
                </p>
              )}
              {anchorPara ? (
                <p className="text-[10px] text-green-700 mt-1">
                  Anchor: ¶{anchorPara.idx + 1} ·{' '}
                  <span className="text-gray-500">
                    {paragraphPreview(anchorPara.text)}
                  </span>
                </p>
              ) : (
                <p className="text-[10px] text-gray-400 mt-1">Unanchored</p>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"
      aria-hidden="true"
    />
  );
}
