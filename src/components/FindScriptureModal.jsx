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
  // Optional steer for when the bare phrase is ambiguous ("the journey
  // to Egypt and back" → Exodus or Matthew 2?). Re-search applies it.
  const [context, setContext] = useState('');

  const runSearch = (ctx) => {
    setCandidates(null);
    setError(null);
    setLoading(true);
    findScriptureForPhrase({ phrase, sermonScripture, context: ctx, model })
      .then(setCandidates)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!open) return;
    setContext('');
    runSearch('');
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
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(context);
            }}
          >
            <input
              className="input text-xs py-1"
              placeholder={'Optional context — e.g., "I mean Jesus’ family’s flight to Egypt, not the Exodus"'}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              disabled={loading}
            />
            <button
              className="btn-secondary text-xs shrink-0 disabled:opacity-50"
              disabled={loading || !context.trim()}
              title="Re-run the search with your context — it overrides the surface reading of the phrase."
            >
              Search with context
            </button>
          </form>
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
