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
  // Split on ; / newline AND expand abbreviated chunks. The pastor
  // routinely writes refs like "Matthew 11:16-19; 25-30" where the
  // second chunk inherits "Matthew" and "11" from the first. Without
  // this expansion, sending "25-30" to Claude is ambiguous and
  // produces wrong results.
  const refs = expandRefChunks(scriptureRefs || '');

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

// Parse a free-form scripture-refs string into an array of fully-
// qualified references. Subsequent ;-separated chunks inherit the book
// (and optionally chapter) from the prior chunk when omitted, matching
// how pastors actually write composite refs like:
//
//   "Matthew 11:16-19; 25-30"     → ["Matthew 11:16-19", "Matthew 11:25-30"]
//   "Luke 15:1-7; 11-32"          → ["Luke 15:1-7", "Luke 15:11-32"]
//   "John 3:16; 4:14"             → ["John 3:16", "John 4:14"]
//   "Romans 8:28; Hosea 6:6"      → ["Romans 8:28", "Hosea 6:6"]
//   "Matt 9:9-13; Hos 6:6; 11:1"  → ["Matt 9:9-13", "Hos 6:6", "Hos 11:1"]
//
// Chunks that start with a letter (or leading 1/2/3 + letter, e.g.
// "1 John 4:7") reset both book and chapter. Chunks starting with a
// number+colon ("4:14") inherit the book only. Bare verse-range chunks
// ("25-30") inherit both.
export function expandRefChunks(input) {
  const chunks = (input || '')
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  let lastBook = null;
  let lastChapter = null;
  // Full ref pattern: optional 1/2/3 prefix, book name (letters + spaces),
  // chapter, optional ":verses".
  const FULL = /^(\d?\s*[A-Za-z][A-Za-z. ]*?)\s+(\d+)(?::(.+))?$/;
  // Chapter:verses with no book: "4:14" or "11:1-7"
  const CHAP_VERSES = /^(\d+):(.+)$/;
  // Bare verses: "25-30", "11", "1, 3-5"
  const VERSES_ONLY = /^[\d,\s-]+$/;
  for (const chunk of chunks) {
    const full = chunk.match(FULL);
    if (full) {
      lastBook = full[1].trim();
      lastChapter = full[2];
      out.push(chunk);
      continue;
    }
    const cv = chunk.match(CHAP_VERSES);
    if (cv && lastBook) {
      lastChapter = cv[1];
      out.push(`${lastBook} ${cv[1]}:${cv[2].trim()}`);
      continue;
    }
    if (VERSES_ONLY.test(chunk) && lastBook && lastChapter) {
      out.push(`${lastBook} ${lastChapter}:${chunk}`);
      continue;
    }
    // Couldn't categorize — pass through unchanged so Claude sees it as-is.
    // (Better than silently dropping a chunk the pastor wrote.)
    out.push(chunk);
  }
  return out;
}
