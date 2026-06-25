// "Revise selected portion with Claude" modal.
//
// Opened from SermonWorkspace when the pastor highlights a snippet of
// the manuscript and clicks the ✨ button. Shows the highlighted
// snippet, lets the pastor type an instruction, calls Claude API for a
// snippet-only revision, and offers Replace / Copy on the result.
//
// Self-contained: parent passes in the snippet, optional surrounding
// context (so Claude's revision flows with what's before/after), the
// sermon metadata, and an `onReplace(newSnippet)` callback that
// splices the result into the manuscript at the selection range.

import { useEffect, useRef, useState } from 'react';
import { reviseManuscriptSnippet } from '../lib/claude';

export default function SelectionReviseModal({
  open,
  onClose,
  snippet,
  contextBefore = '',
  contextAfter = '',
  fullManuscript = '',
  sermon,
  voiceSystemPrompt = '',
  onReplace,
  // Forwarded straight to reviseManuscriptSnippet. Workspace passes the
  // pastor's manuscript-model choice here so the highlight-and-revise
  // flow uses the same model as the chat-revise flow.
  model = null,
}) {
  const [instruction, setInstruction] = useState('');
  const [includeFullManuscript, setIncludeFullManuscript] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef(null);

  // Reset state every time the modal opens with a fresh snippet.
  useEffect(() => {
    if (!open) return;
    setInstruction('');
    setIncludeFullManuscript(false);
    setError(null);
    setResult(null);
    setCopied(false);
    // Autofocus the instruction field a beat after open so the user can
    // just start typing.
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open, snippet]);

  if (!open) return null;

  const handleGenerate = async () => {
    if (!instruction.trim()) {
      setError('Type an instruction for Claude first.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const revised = await reviseManuscriptSnippet({
        snippet,
        instruction: instruction.trim(),
        contextBefore,
        contextAfter,
        sermon,
        voiceSystemPrompt,
        // Only send the full manuscript if the user opted in AND we
        // actually have one to send.
        fullManuscript:
          includeFullManuscript && fullManuscript ? fullManuscript : '',
        model,
      });
      setResult(revised);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleReplace = () => {
    if (!result || typeof onReplace !== 'function') return;
    onReplace(result);
    onClose();
  };

  const handleCopy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API may fail in some browsers — fall back to a hint.
      setError(
        "Couldn't copy automatically. Select the text below and press Cmd/Ctrl+C."
      );
    }
  };

  const handleTryAgain = () => {
    setResult(null);
    setError(null);
    setCopied(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  // Send instruction on Enter (Shift+Enter for newline).
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!busy && !result) handleGenerate();
    }
  };

  const snippetWordCount = (snippet || '').trim().split(/\s+/).filter(Boolean).length;
  const resultWordCount = result
    ? result.trim().split(/\s+/).filter(Boolean).length
    : 0;
  const fullManuscriptWordCount = (fullManuscript || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const canIncludeFull =
    fullManuscriptWordCount > 0 &&
    fullManuscript.trim() !== (snippet || '').trim();

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-start sm:items-center justify-center p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full my-4 p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-serif text-xl text-umc-900">
              ✨ Revise selected portion
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Claude will rewrite just the highlighted snippet ({snippetWordCount}{' '}
              word{snippetWordCount === 1 ? '' : 's'}). The surrounding manuscript
              stays exactly as you have it.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-gray-400 hover:text-gray-700 text-2xl leading-none disabled:opacity-30"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Selected snippet preview */}
        <div className="border border-gray-200 rounded bg-gray-50 p-3 max-h-40 overflow-y-auto">
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
            Selected
          </div>
          <p className="text-sm font-serif text-gray-800 whitespace-pre-wrap">
            {snippet}
          </p>
        </div>

        {/* Instruction input */}
        <div>
          <label className="label text-xs">Tell Claude what to change</label>
          <textarea
            ref={inputRef}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
            className="input min-h-[80px] text-sm"
            placeholder="e.g. Make this more conversational. / Tighten — cut about a third of the words. / Add a brief metaphor about a long road. / Rephrase in active voice."
          />
          <p className="text-[10px] text-gray-400 mt-1">
            Tip: press Enter to send, Shift+Enter for a newline.
          </p>
        </div>

        {canIncludeFull && (
          <label className="flex items-start gap-2 cursor-pointer text-xs text-gray-700">
            <input
              type="checkbox"
              checked={includeFullManuscript}
              onChange={(e) => setIncludeFullManuscript(e.target.checked)}
              disabled={busy}
              className="mt-0.5 h-3.5 w-3.5 rounded border-gray-300 text-umc-700"
            />
            <span>
              Include full manuscript as background
              <span className="text-gray-400 ml-1">
                (~{fullManuscriptWordCount.toLocaleString()} words — gives Claude
                the full arc of the sermon; uses more tokens but still only
                rewrites the snippet)
              </span>
            </span>
          </label>
        )}

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </p>
        )}

        {result && (
          <div className="border border-green-300 rounded bg-green-50/40 p-3 max-h-64 overflow-y-auto">
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] uppercase tracking-wide text-green-700">
                Claude's revision ({resultWordCount} word
                {resultWordCount === 1 ? '' : 's'})
              </div>
              {copied && (
                <span className="text-[10px] text-green-700">copied!</span>
              )}
            </div>
            <p className="text-sm font-serif text-gray-900 whitespace-pre-wrap">
              {result}
            </p>
          </div>
        )}

        {/* Footer buttons depend on whether a result has been produced. */}
        <div className="flex justify-end gap-2 pt-1 flex-wrap">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="btn-secondary text-sm"
          >
            Cancel
          </button>

          {!result ? (
            <button
              type="button"
              onClick={handleGenerate}
              disabled={busy || !instruction.trim()}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {busy ? 'Asking Claude…' : '✨ Revise with Claude'}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleTryAgain}
                disabled={busy}
                className="btn-secondary text-sm"
                title="Edit the instruction and ask Claude again"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={handleCopy}
                disabled={busy}
                className="btn-secondary text-sm"
                title="Copy the revised snippet to clipboard so you can paste it manually"
              >
                {copied ? '✓ Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={handleReplace}
                disabled={busy || typeof onReplace !== 'function'}
                className="btn-primary text-sm disabled:opacity-50"
                title="Replace the highlighted portion of the manuscript with this revision"
              >
                Replace selection
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
