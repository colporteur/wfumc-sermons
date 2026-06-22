import { useState } from 'react';
import { lookupScriptureNRSVUe } from '../lib/claude';
import { splitIntoSentences } from '../lib/paragraphs';

// Click-to-insert scripture sentence panel for liturgy element editing.
// Mirrors the Slides Insert Sentence machinery: load the scripture in
// NRSVUe (via Claude), split into sentences, and click any sentence to
// drop it into the element body at the cursor position.
//
// Multiple scripture refs are supported — semicolon-separated entries
// in scriptureRefs each get their own "Load" button so the pastor can
// pull from whichever one(s) they want.
//
// Props:
//   scriptureRefs - "Matthew 9:9-13; Hosea 6:6" (free-form)
//   onInsert      - (sentenceText) => void  (parent appends to body)
//
// Returns null when scriptureRefs is empty (panel has nothing to do).
export default function InsertScriptureSentencePanel({
  scriptureRefs,
  onInsert,
}) {
  const refs = (scriptureRefs || '')
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const [open, setOpen] = useState(false);
  const [loadingRef, setLoadingRef] = useState(null);
  // { [ref]: { sentences: string[], rawText: string, error: string|null } }
  const [loaded, setLoaded] = useState({});

  if (refs.length === 0) return null;

  const handleLoad = async (ref) => {
    setLoadingRef(ref);
    try {
      const rawText = await lookupScriptureNRSVUe(ref);
      // lookupScriptureNRSVUe returns prose + blank line + reference line
      // at the end. Strip the trailing reference line before splitting.
      const lines = rawText.split('\n');
      while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
      // Drop the last non-blank line if it looks like the reference.
      const lastLine = lines[lines.length - 1] || '';
      const bodyOnly =
        lastLine.toLowerCase().includes(ref.toLowerCase().slice(0, 6))
          ? lines.slice(0, -1).join('\n').trim()
          : rawText.trim();
      const sentences = splitIntoSentences(bodyOnly);
      setLoaded((prev) => ({
        ...prev,
        [ref]: { sentences, rawText, error: null },
      }));
    } catch (e) {
      setLoaded((prev) => ({
        ...prev,
        [ref]: { sentences: [], rawText: '', error: e.message || String(e) },
      }));
    } finally {
      setLoadingRef(null);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-umc-700 hover:text-umc-900 underline"
        title="Insert a sentence from the liturgy's scripture into this element"
      >
        📖 Insert from scripture
      </button>
    );
  }

  return (
    <div className="border border-umc-200 bg-umc-50 rounded p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-umc-900">
          Pick a sentence from scripture
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-gray-500 hover:text-gray-800 underline"
        >
          Close
        </button>
      </div>

      <div className="space-y-3">
        {refs.map((ref) => {
          const entry = loaded[ref];
          return (
            <div key={ref} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-700">
                  {ref}
                </span>
                <button
                  type="button"
                  onClick={() => handleLoad(ref)}
                  disabled={loadingRef === ref}
                  className="text-[11px] text-umc-700 hover:text-umc-900 underline disabled:opacity-50"
                >
                  {loadingRef === ref
                    ? 'Loading…'
                    : entry
                      ? '↻ Reload'
                      : 'Load (NRSVUe)'}
                </button>
              </div>
              {entry?.error && (
                <p className="text-xs text-red-700">{entry.error}</p>
              )}
              {entry?.sentences?.length > 0 && (
                <ul className="space-y-1">
                  {entry.sentences.map((sent, idx) => (
                    <li
                      key={idx}
                      className="flex items-start gap-2 border border-gray-200 bg-white rounded p-2"
                    >
                      <button
                        type="button"
                        onClick={() => onInsert(sent)}
                        className="text-[11px] text-umc-700 hover:text-umc-900 underline shrink-0 mt-0.5"
                      >
                        Insert
                      </button>
                      <p className="text-sm text-gray-800 font-serif leading-relaxed flex-1">
                        {sent}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {entry && entry.sentences.length === 0 && !entry.error && (
                <p className="text-xs text-gray-500 italic">
                  Loaded but no sentences detected.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
