import { useEffect, useState } from 'react';
import {
  brainstormReplacementIllustrations,
  buildReplaceIllustrationInstruction,
} from '../lib/claude';

// "Suggest Replacement Illustrations" — two-step modal in the Sermon
// Workspace.
//
//   Step 1: pastor pastes (or arrives with a manuscript selection of)
//           the illustration currently in the sermon → Claude
//           brainstorms 5-8 candidates that fill the same role.
//   Step 2: pastor picks one → "Replace illustration" hands a
//           detailed instruction to the normal revision pipeline
//           (parent runs it as a chat turn), which swaps the main
//           chunk AND rewrites any later callbacks. Snapshot, diff,
//           and Revert all apply as with any revision turn.
//
// Props:
//   open                - boolean
//   onClose             - () => void
//   sermon              - sermon row
//   manuscript          - current manuscript text
//   model               - model id from the Workspace picker (null = default)
//   initialIllustration - pre-fill (the pastor's current selection)
//   onReplace           - (instruction) => void — parent fires the
//                         revision turn and closes the modal
export default function ReplaceIllustrationModal({
  open,
  onClose,
  sermon,
  manuscript,
  model,
  initialIllustration = '',
  onReplace,
}) {
  const [illustration, setIllustration] = useState('');
  const [candidates, setCandidates] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Reset per open; adopt the manuscript selection when there is one.
  useEffect(() => {
    if (!open) return;
    setIllustration(initialIllustration || '');
    setCandidates(null);
    setSelectedIdx(null);
    setError(null);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const runBrainstorm = async () => {
    setLoading(true);
    setError(null);
    setCandidates(null);
    setSelectedIdx(null);
    try {
      const out = await brainstormReplacementIllustrations({
        sermon,
        manuscript,
        illustration,
        model,
      });
      setCandidates(out);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleReplace = () => {
    if (selectedIdx === null || !candidates?.[selectedIdx]) return;
    const instruction = buildReplaceIllustrationInstruction({
      oldIllustration: illustration,
      candidate: candidates[selectedIdx],
    });
    onReplace(instruction);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl my-8">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div>
            <h2 className="font-serif text-lg text-umc-900">
              Replace an illustration
            </h2>
            <p className="text-xs text-gray-500">
              Paste the illustration as it appears in the manuscript.
              Claude reads its role in the sermon and proposes stand-ins;
              replacing rewrites the main passage AND any later callbacks,
              as a normal revision turn (diff + revert apply).
            </p>
          </div>
          <button type="button" className="btn-secondary text-xs" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 max-h-[75vh] overflow-y-auto">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              Illustration currently in the sermon
            </label>
            <textarea
              className="input w-full text-sm font-serif"
              rows={5}
              value={illustration}
              onChange={(e) => setIllustration(e.target.value)}
              placeholder="Paste the illustration passage here (or highlight it in the manuscript before opening this)."
            />
            <button
              type="button"
              className="btn-primary text-sm mt-2 disabled:opacity-50"
              onClick={runBrainstorm}
              disabled={loading || !illustration.trim()}
            >
              {loading
                ? 'Reading its role & brainstorming…'
                : candidates
                ? '✨ Brainstorm again'
                : '✨ Suggest replacement illustrations'}
            </button>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          {candidates && (
            <div className="space-y-2">
              <p className="text-xs text-gray-500">
                Pick the one that fits, then Replace. Each fills the same
                role the current illustration plays.
              </p>
              {candidates.map((c, i) => (
                <label
                  key={i}
                  className={`block border rounded-md p-2 cursor-pointer ${
                    selectedIdx === i
                      ? 'border-umc-700 bg-umc-50'
                      : 'hover:bg-gray-50'
                  }`}
                >
                  <span className="flex items-start gap-2">
                    <input
                      type="radio"
                      name="replacement-candidate"
                      className="mt-1"
                      checked={selectedIdx === i}
                      onChange={() => setSelectedIdx(i)}
                    />
                    <span>
                      <span className="text-sm font-medium">{c.label}</span>
                      <span className="block text-sm font-serif mt-0.5">
                        {c.body}
                      </span>
                      {c.roleFit && (
                        <span className="block text-xs text-gray-500 mt-0.5 italic">
                          {c.roleFit}
                        </span>
                      )}
                    </span>
                  </span>
                </label>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  className="btn-primary text-sm disabled:opacity-50"
                  onClick={handleReplace}
                  disabled={selectedIdx === null}
                  title="Runs as a revision turn: swaps the main passage and rewrites later callbacks. You can View diff and Revert afterward."
                >
                  Replace illustration
                </button>
                <span className="text-xs text-gray-400">
                  Swaps the passage + rewrites later callbacks.
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
