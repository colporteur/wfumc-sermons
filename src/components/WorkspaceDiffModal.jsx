import { useMemo } from 'react';
import { diffWords, diffStats } from '../lib/wordDiff';

// Color-coded inline word diff between two manuscript versions.
//
// Red strikethrough = text that was removed.
// Green = text that was added.
// Plain = unchanged text shown in context.
//
// Renders inline (not side-by-side) so the changes are visible inside
// the surrounding paragraphs, which is what makes them easy to read.
//
// Props:
//   open           — whether the modal is open
//   onClose        — close handler
//   title          — short title shown in the modal header
//   beforeText     — old manuscript
//   afterText      — new manuscript
export default function WorkspaceDiffModal({
  open,
  onClose,
  title,
  beforeText,
  afterText,
}) {
  // Computing the diff can be slow for very large manuscripts; only do
  // it when the modal is actually open (and memoize on the inputs).
  const segments = useMemo(() => {
    if (!open) return [];
    return diffWords(beforeText || '', afterText || '');
  }, [open, beforeText, afterText]);

  const stats = useMemo(
    () => diffStats(beforeText || '', afterText || ''),
    [beforeText, afterText]
  );

  if (!open) return null;

  const deltaLabel =
    stats.delta === 0
      ? 'no change in word count'
      : stats.delta > 0
      ? `+${stats.delta} words`
      : `${stats.delta} words`;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-stretch sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-4xl sm:rounded-lg shadow-xl flex flex-col max-h-screen sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-200 flex items-baseline justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="font-serif text-lg text-umc-900 truncate">
              {title || 'Manuscript diff'}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {stats.oldWords} → {stats.newWords} words ({deltaLabel}). Red
              strikethrough = removed; green = added.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-sm"
          >
            Close
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {segments.length === 0 ? (
            <p className="text-sm text-gray-500 italic">
              The two versions are identical.
            </p>
          ) : (
            <div
              className="text-sm font-serif leading-relaxed whitespace-pre-wrap break-words"
              // Use a stacking-friendly container so the colored spans
              // wrap naturally with the surrounding text.
            >
              {segments.map((s, i) => {
                if (s.type === 'eq') {
                  return <span key={i}>{s.text}</span>;
                }
                if (s.type === 'add') {
                  return (
                    <span
                      key={i}
                      className="bg-green-100 text-green-900 rounded px-0.5"
                    >
                      {s.text}
                    </span>
                  );
                }
                // del
                return (
                  <span
                    key={i}
                    className="bg-red-100 text-red-900 line-through rounded px-0.5"
                  >
                    {s.text}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="btn-primary text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
