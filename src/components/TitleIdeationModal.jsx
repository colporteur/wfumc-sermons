import { useEffect, useState } from 'react';
import { brainstormSermonTitles } from '../lib/claude';

// Title/retitle ideation modal — opened from the SermonDetail metadata
// editor's "✨ Title ideas" button. Generates 7 categories × 10
// candidate titles from the manuscript + scripture (the pastor's own
// ideation prompt), each with a Use button.
//
// Props:
//   open     - boolean
//   onClose  - () => void
//   sermon   - sermon row (manuscript_text, scripture_reference, title, theme)
//   onPick   - (title) => void — parent applies it to the draft title
//              (and shuffles the old title into previous_titles)
export default function TitleIdeationModal({ open, onClose, sermon, onPick }) {
  const [loading, setLoading] = useState(false);
  const [sections, setSections] = useState(null);
  const [error, setError] = useState(null);
  const [pickedTitle, setPickedTitle] = useState(null);

  // Generate on open (fresh each time the modal opens).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSections(null);
    setError(null);
    setPickedTitle(null);
    setLoading(true);
    brainstormSermonTitles({ sermon })
      .then((s) => {
        if (!cancelled) setSections(s);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const regenerate = () => {
    setSections(null);
    setError(null);
    setLoading(true);
    brainstormSermonTitles({ sermon })
      .then(setSections)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl my-8">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="font-serif text-lg text-umc-900">Title ideas</h2>
            <p className="text-xs text-gray-500">
              70 candidates across 7 registers, grounded in the manuscript
              {sermon?.scripture_reference
                ? ` and ${sermon.scripture_reference}`
                : ''}
              . "Use" drops one into the Title field — nothing saves until
              you save the metadata form.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={regenerate}
              disabled={loading}
            >
              {loading ? 'Thinking…' : 'Regenerate'}
            </button>
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>

        <div className="px-4 py-3 max-h-[70vh] overflow-y-auto space-y-4">
          {loading && (
            <p className="text-sm text-gray-500 animate-pulse">
              Reading the manuscript and turning titles over…
            </p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {pickedTitle && (
            <p className="text-sm text-emerald-700">
              Title set to "{pickedTitle}" — the old title moved to Previous
              titles. Keep browsing or close and save.
            </p>
          )}
          {sections &&
            sections.map((sec, i) => (
              <div key={i}>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1">
                  {sec.category}
                </h3>
                <ul className="space-y-1">
                  {sec.titles.map((t, j) => (
                    <li
                      key={j}
                      className="flex items-start gap-2 text-sm rounded px-2 py-1 hover:bg-amber-50"
                    >
                      <button
                        type="button"
                        className="btn-secondary text-xs shrink-0"
                        onClick={() => {
                          onPick(t);
                          setPickedTitle(t);
                        }}
                        title="Set as the sermon title (replaces the current draft title; the old one shifts to Previous titles)"
                      >
                        Use
                      </button>
                      <span className="font-serif">{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
