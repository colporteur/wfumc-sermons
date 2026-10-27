import { useEffect, useRef, useState } from 'react';
import { lookupScriptureNRSVUe } from '../lib/claude';
import { expandRefChunks } from './InsertScriptureSentencePanel.jsx';

// "📖 Insert Scripture" — type (or pick) a reference, pull the NRSVue
// text via Claude, review/edit it, and drop it into the manuscript at
// the cursor. Unlike "Find Scripture", no highlight is needed: the
// pastor already knows which passage he wants.
//
// Props:
//   open             - boolean
//   onClose          - () => void
//   sermonScripture  - the sermon's scripture_reference (offered as quick picks)
//   insertionLabel   - short description of where the text will land
//   onInsert         - ({ reference, text, style }) => void
//                      style is 'paragraph' | 'inline'
const STYLE_KEY = 'wfumc.insertScripture.style';

function readStyle() {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    return v === 'inline' ? 'inline' : 'paragraph';
  } catch {
    return 'paragraph';
  }
}

function saveStyle(v) {
  try {
    localStorage.setItem(STYLE_KEY, v);
  } catch {
    /* storage unavailable — fine */
  }
}

// lookupScriptureNRSVUe returns: prose, blank line, reference line.
// Split those apart so the reference can be formatted separately.
function splitLookup(raw, fallbackRef) {
  const blocks = (raw || '')
    .trim()
    .split(/\n[ \t]*\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
  if (blocks.length > 1) {
    const last = blocks[blocks.length - 1];
    const looksLikeRef =
      !last.includes('\n') && last.length <= 80 && /\d/.test(last);
    if (looksLikeRef) {
      return {
        text: blocks.slice(0, -1).join(' ').replace(/\s+/g, ' ').trim(),
        reference: last,
      };
    }
  }
  return {
    text: blocks.join(' ').replace(/\s+/g, ' ').trim(),
    reference: fallbackRef,
  };
}

export default function InsertScriptureModal({
  open,
  onClose,
  sermonScripture,
  insertionLabel,
  onInsert,
}) {
  const [refInput, setRefInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { reference, text }
  const [style, setStyle] = useState(readStyle);
  const inputRef = useRef(null);

  const quickPicks = expandRefChunks(sermonScripture || '');

  useEffect(() => {
    if (!open) return;
    setRefInput('');
    setResult(null);
    setError(null);
    setLoading(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const fetchPassage = async (ref) => {
    const r = (ref ?? refInput).trim();
    if (!r) return;
    setRefInput(r);
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const raw = await lookupScriptureNRSVUe(r);
      setResult(splitLookup(raw, r));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const chooseStyle = (v) => {
    setStyle(v);
    saveStyle(v);
  };

  const preview =
    result &&
    (style === 'inline'
      ? `“${result.text}” (${result.reference})`
      : `${result.text} (${result.reference})`);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl my-8">
        <div className="flex items-start justify-between border-b px-4 py-3 gap-3">
          <div className="min-w-0">
            <h2 className="font-serif text-lg text-umc-900">Insert Scripture</h2>
            <p className="text-xs text-gray-500">
              NRSVue text, inserted {insertionLabel}
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary text-xs shrink-0"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 max-h-[70vh] overflow-y-auto">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              fetchPassage();
            }}
          >
            <input
              ref={inputRef}
              className="input text-sm py-1"
              placeholder="e.g., John 3:16-17 or Psalm 23"
              value={refInput}
              onChange={(e) => setRefInput(e.target.value)}
              disabled={loading}
            />
            <button
              className="btn-primary text-xs shrink-0 disabled:opacity-50"
              disabled={loading || !refInput.trim()}
            >
              {loading ? 'Loading…' : 'Get text'}
            </button>
          </form>

          {quickPicks.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-gray-500">This sermon:</span>
              {quickPicks.map((r) => (
                <button
                  key={r}
                  type="button"
                  disabled={loading}
                  onClick={() => fetchPassage(r)}
                  className="text-[11px] px-2 py-0.5 rounded border border-umc-300 text-umc-800 hover:bg-umc-50 disabled:opacity-50"
                >
                  {r}
                </button>
              ))}
            </div>
          )}

          {loading && (
            <p className="text-sm text-gray-500 animate-pulse">
              Fetching the NRSVue text…
            </p>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}

          {result && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-gray-500 shrink-0">
                  Reference
                </label>
                <input
                  className="input text-xs py-1"
                  value={result.reference}
                  onChange={(e) =>
                    setResult({ ...result, reference: e.target.value })
                  }
                />
              </div>
              <textarea
                className="input w-full text-sm font-serif leading-relaxed"
                rows={Math.min(12, Math.max(4, Math.ceil(result.text.length / 70)))}
                value={result.text}
                onChange={(e) => setResult({ ...result, text: e.target.value })}
              />
              <p className="text-[11px] text-gray-500">
                Check the wording before inserting — it comes from Claude, not
                a licensed Bible text. Edit above if anything is off.
              </p>

              <div className="flex items-center gap-3 text-xs text-gray-700">
                <span className="text-gray-500">Insert as:</span>
                <label className="inline-flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="insert-style"
                    checked={style === 'paragraph'}
                    onChange={() => chooseStyle('paragraph')}
                  />
                  Its own paragraph
                </label>
                <label className="inline-flex items-center gap-1 cursor-pointer">
                  <input
                    type="radio"
                    name="insert-style"
                    checked={style === 'inline'}
                    onChange={() => chooseStyle('inline')}
                  />
                  Inline quotation
                </label>
              </div>

              <div className="border border-gray-200 bg-gray-50 rounded p-2">
                <p className="text-[11px] text-gray-500 mb-1">Preview</p>
                <p className="text-sm font-serif text-gray-800">{preview}</p>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  className="btn-primary text-sm disabled:opacity-50"
                  disabled={!result.text.trim()}
                  onClick={() =>
                    onInsert({
                      reference: result.reference.trim(),
                      text: result.text.trim(),
                      style,
                    })
                  }
                >
                  Insert into manuscript
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
