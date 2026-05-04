import { useState, useRef } from 'react';
import { Link } from 'react-router-dom';

// PDF split utility — break a big PDF into smaller chunks the pastor
// can feed into the resource extractor one at a time.
//
// Flow: upload PDF, see total page count, type page ranges
// (e.g., "1-30, 31-60, 61-end"), click Split, get a download for each
// resulting piece.
//
// Uses pdf-lib (lazy-loaded). Pure client-side — never uploads anywhere.

export default function PdfSplit() {
  const [file, setFile] = useState(null);
  const [pageCount, setPageCount] = useState(0);
  const [rangesText, setRangesText] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [pieces, setPieces] = useState([]); // [{ filename, blobUrl, fromPage, toPage }]
  const fileRef = useRef(null);

  const handleFile = async (e) => {
    setError(null);
    setPieces((prev) => {
      // Revoke any old object URLs to free memory.
      for (const p of prev) URL.revokeObjectURL(p.blobUrl);
      return [];
    });
    setPageCount(0);
    setRangesText('');
    const f = e.target.files?.[0];
    if (!f) {
      setFile(null);
      return;
    }
    setFile(f);
    try {
      const { PDFDocument } = await import('pdf-lib');
      const buf = await f.arrayBuffer();
      const doc = await PDFDocument.load(buf, { updateMetadata: false });
      setPageCount(doc.getPageCount());
      // Sensible default split: every 30 pages.
      const suggestion = suggestRanges(doc.getPageCount(), 30);
      setRangesText(suggestion);
    } catch (err) {
      setError(err.message || 'Could not read that PDF.');
      setFile(null);
    }
  };

  const handleSplit = async () => {
    setError(null);
    if (!file) {
      setError('Pick a PDF first.');
      return;
    }
    let ranges;
    try {
      ranges = parseRanges(rangesText, pageCount);
    } catch (err) {
      setError(err.message);
      return;
    }
    if (ranges.length === 0) {
      setError('Enter at least one page range.');
      return;
    }
    setWorking(true);
    try {
      const { PDFDocument } = await import('pdf-lib');
      const srcBuf = await file.arrayBuffer();
      const src = await PDFDocument.load(srcBuf, { updateMetadata: false });

      const baseName = file.name.replace(/\.pdf$/i, '');
      const newPieces = [];
      for (const [from, to] of ranges) {
        const out = await PDFDocument.create();
        // pdf-lib uses 0-based indices; the user thinks in 1-based.
        const indices = [];
        for (let p = from - 1; p < to; p++) indices.push(p);
        const copied = await out.copyPages(src, indices);
        for (const p of copied) out.addPage(p);
        const bytes = await out.save();
        const blob = new Blob([bytes], { type: 'application/pdf' });
        const blobUrl = URL.createObjectURL(blob);
        newPieces.push({
          filename: `${baseName} — pages ${from}-${to}.pdf`,
          blobUrl,
          fromPage: from,
          toPage: to,
        });
      }
      setPieces(newPieces);
    } catch (err) {
      setError(err.message || 'Split failed.');
    } finally {
      setWorking(false);
    }
  };

  const reset = () => {
    for (const p of pieces) URL.revokeObjectURL(p.blobUrl);
    setPieces([]);
    setFile(null);
    setPageCount(0);
    setRangesText('');
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="space-y-6">
      <Link
        to="/resources/extract"
        className="inline-block text-sm text-gray-500 hover:text-gray-700"
      >
        ← Back to extract
      </Link>

      <div>
        <h1 className="text-2xl font-serif text-umc-900">Split a PDF</h1>
        <p className="text-sm text-gray-600 mt-1">
          Big PDFs can hit token limits when sent through the resource
          extractor. Split into smaller pieces here, then run extract on each
          piece separately. Splitting happens in your browser — the file
          never leaves your machine.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      <div className="card space-y-4">
        <div>
          <label className="label">Upload PDF</label>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,application/pdf"
            onChange={handleFile}
            className="block text-sm"
          />
          {pageCount > 0 && (
            <p className="text-xs text-umc-700 mt-2">
              {file?.name} · <strong>{pageCount}</strong> pages
            </p>
          )}
        </div>

        {pageCount > 0 && (
          <>
            <div>
              <label className="label">Page ranges</label>
              <input
                type="text"
                className="input font-mono"
                value={rangesText}
                onChange={(e) => setRangesText(e.target.value)}
                placeholder="e.g., 1-30, 31-60, 61-end"
              />
              <p className="text-xs text-gray-500 mt-1">
                Comma-separated. Use <code>end</code> as a shortcut for the
                last page. Each range becomes one downloadable PDF. Examples:{' '}
                <code>1-50</code> ·{' '}
                <code>1-30, 31-60, 61-end</code> · <code>1, 5-10</code>
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={reset}
                className="btn-secondary"
                disabled={working}
              >
                Clear
              </button>
              <button
                type="button"
                onClick={handleSplit}
                disabled={working || !rangesText.trim()}
                className="btn-primary disabled:opacity-50"
              >
                {working ? 'Splitting…' : '✂ Split PDF'}
              </button>
            </div>
          </>
        )}
      </div>

      {pieces.length > 0 && (
        <div className="card space-y-2">
          <h2 className="font-serif text-lg text-umc-900">
            Split into {pieces.length} piece{pieces.length === 1 ? '' : 's'}
          </h2>
          <p className="text-xs text-gray-500">
            Download each piece below. From the Extract page, upload the piece
            you want to mine for resources.
          </p>
          <ul className="mt-2 space-y-2">
            {pieces.map((p, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 border border-gray-200 rounded px-3 py-2"
              >
                <span className="text-sm text-umc-900">
                  Pages {p.fromPage}–{p.toPage}
                </span>
                <a
                  href={p.blobUrl}
                  download={p.filename}
                  className="btn-primary text-sm"
                >
                  Download
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Suggest a default range string like "1-30, 31-60, 61-90" for an
// N-page PDF and a chunk size.
function suggestRanges(n, chunk) {
  if (n <= chunk) return `1-${n}`;
  const parts = [];
  for (let start = 1; start <= n; start += chunk) {
    const end = Math.min(start + chunk - 1, n);
    parts.push(`${start}-${end}`);
  }
  return parts.join(', ');
}

// Parse "1-30, 31-end, 35" → [[1,30],[31,N],[35,35]]. Throws on
// out-of-range or unparseable input.
function parseRanges(text, total) {
  if (!text || !text.trim()) return [];
  const out = [];
  for (const raw of text.split(/[,;]/)) {
    const part = raw.trim().toLowerCase();
    if (!part) continue;
    let from, to;
    if (part.includes('-')) {
      const [a, b] = part.split('-').map((s) => s.trim());
      from = parseSpec(a, total);
      to = parseSpec(b, total);
    } else {
      from = parseSpec(part, total);
      to = from;
    }
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new Error(`Couldn't parse range "${part}".`);
    }
    if (from < 1 || to > total || from > to) {
      throw new Error(
        `Range "${part}" is out of bounds (PDF has ${total} pages).`
      );
    }
    out.push([from, to]);
  }
  return out;
}

function parseSpec(s, total) {
  if (s === 'end' || s === 'last') return total;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : NaN;
}
