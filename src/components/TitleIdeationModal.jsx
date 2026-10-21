import { useEffect, useRef, useState } from 'react';
import { brainstormSermonTitles } from '../lib/claude';

// Title/retitle ideation modal — opened from SermonDetail (the "✨ Title
// ideas" button in the header and in the metadata editor). Sends the
// current manuscript + scripture to Claude and gets back 8 registers ×
// 5 candidate titles. Clicking a candidate loads it into the editable
// "Your pick" box at the top; tweak it, then "Use this title".
//
// Props:
//   open          - boolean
//   onClose       - () => void
//   sermon        - sermon row (manuscript_text, scripture_reference, title, theme)
//   currentTitle  - the title currently in the draft (shown for comparison)
//   onPick        - (title) => void — parent applies it to the draft title
//                   (and shuffles the old title into previous_titles)
export default function TitleIdeationModal({
  open,
  onClose,
  sermon,
  currentTitle,
  onPick,
}) {
  const [loading, setLoading] = useState(false);
  const [sections, setSections] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(''); // editable pick
  const [appliedTitle, setAppliedTitle] = useState(null);
  const pickInputRef = useRef(null);

  const generate = () => {
    let cancelled = false;
    setSections(null);
    setError(null);
    setLoading(true);
    brainstormSermonTitles({ sermon })
      .then((s) => !cancelled && setSections(s))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  };

  // Generate fresh each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setSelected('');
    setAppliedTitle(null);
    return generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const choose = (t) => {
    setSelected(t);
    setAppliedTitle(null);
    // Put the cursor in the box so editing is one keystroke away.
    requestAnimationFrame(() => {
      const el = pickInputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  };

  const apply = () => {
    const t = selected.trim();
    if (!t) return;
    onPick(t);
    setAppliedTitle(t);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-y-auto p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl my-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div>
            <h2 className="font-serif text-lg text-umc-900">Title ideas</h2>
            <p className="text-xs text-gray-500">
              5 candidates in each of 8 registers, drawn from the manuscript
              {sermon?.scripture_reference
                ? ` and ${sermon.scripture_reference}`
                : ''}
              . Click one to load it below, edit if you like, then use it.
              Nothing saves until you save the sermon details.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={generate}
              disabled={loading}
              title="Ask for a fresh batch"
            >
              {loading ? 'Thinking…' : '↻ Regenerate'}
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

        {/* Your pick — editable */}
        <div className="border-b bg-amber-50/60 px-4 py-3 space-y-2">
          <div className="text-xs text-gray-600">
            Current title:{' '}
            <span className="font-serif text-gray-800">
              {currentTitle?.trim() || <em className="text-gray-400">none</em>}
            </span>
          </div>
          <label className="label mb-0" htmlFor="title-pick">
            Your pick
          </label>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              id="title-pick"
              ref={pickInputRef}
              type="text"
              className="input flex-1 font-serif"
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setAppliedTitle(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && apply()}
              placeholder="Click a title below, or type your own…"
            />
            <button
              type="button"
              className="btn-primary text-sm whitespace-nowrap disabled:opacity-50"
              onClick={apply}
              disabled={!selected.trim() || selected.trim() === appliedTitle}
              title="Replace the current title (the old one moves to Previous titles)"
            >
              Use this title
            </button>
          </div>
          {appliedTitle && (
            <p className="text-xs text-emerald-700">
              Title set to “{appliedTitle}”. The old title moved to Previous
              titles. Close and click Save changes to keep it.
            </p>
          )}
        </div>

        {/* Candidates */}
        <div className="px-4 py-3 max-h-[60vh] overflow-y-auto">
          {loading && (
            <p className="text-sm text-gray-500 animate-pulse">
              Reading the manuscript and turning titles over…
            </p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {sections && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
              {sections.map((sec) => (
                <div key={sec.key}>
                  <h3
                    className="text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1"
                    title={sec.guide}
                  >
                    {sec.category}
                  </h3>
                  <ul className="space-y-0.5">
                    {sec.titles.map((t, j) => {
                      const isSel = t === selected;
                      return (
                        <li key={j}>
                          <button
                            type="button"
                            onClick={() => choose(t)}
                            onDoubleClick={() => {
                              choose(t);
                              onPick(t);
                              setAppliedTitle(t);
                            }}
                            className={
                              'w-full text-left font-serif text-sm rounded px-2 py-1 ' +
                              (isSel
                                ? 'bg-amber-100 ring-1 ring-amber-300'
                                : 'hover:bg-amber-50')
                            }
                            title="Click to load into Your pick · double-click to use as-is"
                          >
                            {t}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
