import { useEffect, useState } from 'react';
import { findScriptureForPhrase } from '../lib/claude';

// "Find Scripture" — highlight a phrase in the manuscript, and Claude
// identifies the passages behind it (allusions first, then thematic
// resonance; NRSVue). Each result card offers:
//   1. Insert slide marker  — <SLIDE #N – Reference> right after the
//      highlighted text (parent computes N)
//   2. Insert verse text    — the NRSVue text + reference into the
//      manuscript after the highlighted text
// Any insert closes the modal (the frozen selection is stale after a
// manuscript change).
//
// Props:
//   open           - boolean
//   onClose        - () => void
//   phrase         - the frozen highlighted text
//   sermonScripture- the sermon's scripture_reference (context)
//   model          - model id from the Workspace picker (null = default)
//   onInsertMarker - (reference) => void
//   onInsertVerse  - ({ reference, text }) => void
export default function FindScriptureModal({
  open,
  onClose,
  phrase,
  sermonScripture,
  model,
  onInsertMarker,
  onInsertVerse,
}) {
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCandidates(null);
    setError(null);
    setLoading(true);
    findScriptureForPhrase({ phrase, sermonScripture, model })
      .then((c) => {
        if (!cancelled) setCandidates(c);
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

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl my-8">
        <div className="flex items-start justify-between border-b px-4 py-3 gap-3">
          <div className="min-w-0">
            <h2 className="font-serif text-lg text-umc-900">Find Scripture</h2>
            <p className="text-xs text-gray-500 truncate" title={phrase}>
              "{phrase}"
            </p>
          </div>
          <button type="button" className="btn-secondary text-xs shrink-0" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="px-4 py-3 space-y-2 max-h-[70vh] overflow-y-auto">
          {loading && (
            <p className="text-sm text-gray-500 animate-pulse">
              Tracing the phrase into the text…
            </p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {candidates &&
            candidates.map((c, i) => (
              <div key={i} className="border rounded-md p-2 space-y-1">
                <p className="text-sm font-medium text-umc-900">{c.reference}</p>
                <p className="text-sm font-serif">{c.text}</p>
                {c.rationale && (
                  <p className="text-xs text-gray-500 italic">{c.rationale}</p>
                )}
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => onInsertMarker(c.reference)}
                    title="Insert a slide marker with this reference right after the highlighted text — the Slides panel's batch NRSVue fill can build the slide from it."
                  >
                    Insert slide marker
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => onInsertVerse({ reference: c.reference, text: c.text })}
                    title="Insert the NRSVue text + reference into the manuscript after the highlighted text."
                  >
                    Insert verse text
                  </button>
                </div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
