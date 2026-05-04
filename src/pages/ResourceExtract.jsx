import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext.jsx';
import { extractResourcesFromSource } from '../lib/claude';
import { extractPdfText } from '../lib/pdfText';
import { listMyLibraries } from '../lib/libraries';

// Extract resources from arbitrary source material (paste, .txt, .pdf).
//
// Three input modes pick the source. Hit Extract → Claude returns
// proposed resources. Pastor reviews + tweaks each one (or unchecks
// the ones to skip), picks a target library, then Imports. Each row
// inserted gets auto_generated=true and auto_source_label set so the
// pastor can spot them later in the library.

const MODE_OPTIONS = [
  { value: 'paste', label: 'Paste text' },
  { value: 'txt', label: 'Upload .txt' },
  { value: 'pdf', label: 'Upload .pdf' },
];

const TYPE_OPTIONS = ['story', 'quote', 'illustration', 'joke'];

export default function ResourceExtract() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Stage: 'input' (pick source + run Claude) -> 'review' (pick + tweak) -> 'done'
  const [stage, setStage] = useState('input');

  const [mode, setMode] = useState('paste');
  const [pasted, setPasted] = useState('');
  const [sourceLabel, setSourceLabel] = useState(''); // user-friendly label
  const [extracting, setExtracting] = useState(false);
  const [parsedText, setParsedText] = useState(''); // text fed to Claude
  const [parseStatus, setParseStatus] = useState(null);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  // Review state
  const [proposals, setProposals] = useState([]); // [{ checked, ...resource }]
  const [libraries, setLibraries] = useState([]);
  const [libraryId, setLibraryId] = useState('');
  const [importing, setImporting] = useState(false);
  const [importedCount, setImportedCount] = useState(0);

  useEffect(() => {
    listMyLibraries().then(setLibraries).catch(() => setLibraries([]));
  }, []);

  // ---- File handlers ----

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setParseStatus(null);
    setParsedText('');
    setSourceLabel(file.name);
    try {
      if (mode === 'txt') {
        const text = await file.text();
        if (!text.trim()) throw new Error('That file is empty.');
        setParsedText(text);
        setParseStatus(
          `Loaded ${text.length.toLocaleString()} characters from ${file.name}.`
        );
      } else if (mode === 'pdf') {
        setParseStatus('Reading the PDF…');
        const { text, pageCount } = await extractPdfText(file);
        if (!text.trim()) {
          throw new Error(
            "Couldn't pull any text out of that PDF. It might be image-only (scanned) — try OCR first."
          );
        }
        setParsedText(text);
        setParseStatus(
          `Loaded ${text.length.toLocaleString()} characters from ${pageCount}-page PDF (${file.name}).`
        );
      }
    } catch (err) {
      setError(err.message || String(err));
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // ---- Extract ----

  const handleExtract = async () => {
    setError(null);
    let text = '';
    let label = sourceLabel.trim();
    if (mode === 'paste') {
      text = pasted.trim();
      if (!text) {
        setError('Paste some text first.');
        return;
      }
      if (!label) label = 'Pasted text';
    } else {
      text = parsedText;
      if (!text) {
        setError('Upload a file first.');
        return;
      }
    }
    setExtracting(true);
    try {
      const items = await extractResourcesFromSource({
        sourceText: text,
        sourceLabel: label,
      });
      if (items.length === 0) {
        setError(
          "Claude didn't find anything worth extracting from this source. Try a different chunk?"
        );
        setExtracting(false);
        return;
      }
      // Pre-check every proposal; pastor unchecks ones to skip.
      setProposals(
        items.map((it) => ({
          checked: true,
          title: it.proposed_title || '',
          content: it.content || '',
          resource_type: it.type || 'story',
          themes: (it.themes || []).join(', '),
          scripture_refs: it.scripture_refs || '',
          tone: it.tone || '',
        }))
      );
      setSourceLabel(label); // commit the label we'll save with each row
      setStage('review');
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setExtracting(false);
    }
  };

  // ---- Import ----

  const updateProposal = (i, patch) => {
    setProposals((prev) =>
      prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p))
    );
  };

  const handleImport = async () => {
    setError(null);
    const toImport = proposals.filter((p) => p.checked);
    if (toImport.length === 0) {
      setError('Nothing checked to import.');
      return;
    }
    setImporting(true);
    try {
      const rows = toImport.map((p) => ({
        owner_user_id: user.id,
        resource_type: p.resource_type,
        title: p.title.trim() || null,
        content: p.content,
        source: null,
        source_url: null,
        themes: p.themes
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean),
        scripture_refs: p.scripture_refs.trim() || null,
        tone: p.tone.trim() || null,
        notes: null,
        library_id: libraryId || null,
        auto_generated: true,
        auto_source_label: sourceLabel || null,
      }));
      const { data, error: insErr } = await withTimeout(
        supabase.from('resources').insert(rows).select('id')
      );
      if (insErr) throw insErr;
      setImportedCount(data?.length ?? rows.length);
      setStage('done');
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setImporting(false);
    }
  };

  const reset = () => {
    setStage('input');
    setProposals([]);
    setSourceLabel('');
    setParsedText('');
    setParseStatus(null);
    setPasted('');
    setError(null);
    setImportedCount(0);
    if (fileRef.current) fileRef.current.value = '';
  };

  // ---- Render ----

  return (
    <div className="space-y-6">
      <Link
        to="/resources"
        className="inline-block text-sm text-gray-500 hover:text-gray-700"
      >
        ← Back to resources
      </Link>

      <div>
        <h1 className="text-2xl font-serif text-umc-900">
          Extract resources from a source
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          Upload or paste reading material, and Claude will pull out discrete
          stories, quotes, and illustrations you might use in a future sermon.
          Imported resources are tagged ✨ Auto-generated so you can spot
          them later.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      {stage === 'input' && (
        <div className="card space-y-4">
          <div>
            <label className="label">Source</label>
            <div className="flex gap-2 flex-wrap">
              {MODE_OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className={`text-sm px-3 py-1 rounded border cursor-pointer ${
                    mode === o.value
                      ? 'bg-umc-700 text-white border-umc-700'
                      : 'bg-white text-gray-700 border-gray-300 hover:border-umc-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="mode"
                    value={o.value}
                    checked={mode === o.value}
                    onChange={() => {
                      setMode(o.value);
                      setParsedText('');
                      setParseStatus(null);
                      if (fileRef.current) fileRef.current.value = '';
                    }}
                    className="hidden"
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </div>

          {mode === 'paste' ? (
            <>
              <div>
                <label className="label">Source label (optional)</label>
                <input
                  type="text"
                  className="input"
                  value={sourceLabel}
                  onChange={(e) => setSourceLabel(e.target.value)}
                  placeholder='e.g., "Henri Nouwen, The Inner Voice of Love, ch. 2"'
                />
                <p className="text-xs text-gray-500 mt-1">
                  Recorded on each imported resource so you can find them
                  later. Leave blank for "Pasted text".
                </p>
              </div>
              <div>
                <label className="label">Paste the text</label>
                <textarea
                  className="input min-h-[300px] font-mono text-sm"
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder="Paste the article, chapter, or passage here…"
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="label">
                  Upload {mode === 'pdf' ? '.pdf' : '.txt'} file
                </label>
                <input
                  ref={fileRef}
                  type="file"
                  accept={mode === 'pdf' ? '.pdf,application/pdf' : '.txt,text/plain'}
                  onChange={handleFile}
                  className="block text-sm"
                />
                {parseStatus && (
                  <p className="text-xs text-umc-700 mt-2">{parseStatus}</p>
                )}
              </div>
              {parsedText && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-gray-600 hover:text-gray-900">
                    Preview extracted text ({parsedText.length.toLocaleString()} chars)
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-y-auto bg-gray-50 border border-gray-200 rounded p-2 text-[11px] whitespace-pre-wrap font-mono">
                    {parsedText.slice(0, 5000)}
                    {parsedText.length > 5000 ? '\n…[truncated preview]' : ''}
                  </pre>
                </details>
              )}
            </>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleExtract}
              disabled={
                extracting ||
                (mode === 'paste' ? !pasted.trim() : !parsedText)
              }
              className="btn-primary disabled:opacity-50"
            >
              {extracting ? '✨ Asking Claude…' : '✨ Extract with Claude'}
            </button>
          </div>
          {extracting && (
            <p className="text-xs text-gray-500 italic">
              This can take 30-90 seconds for longer sources.
            </p>
          )}
        </div>
      )}

      {stage === 'review' && (
        <>
          <div className="card flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-umc-900">
                <strong>{proposals.length}</strong> proposal
                {proposals.length === 1 ? '' : 's'} from{' '}
                <em>{sourceLabel}</em>
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Uncheck anything you don't want. Edit titles, themes, or
                scripture refs in place.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-600">
                Library:
                <select
                  value={libraryId}
                  onChange={(e) => setLibraryId(e.target.value)}
                  className="input ml-2 inline-block w-auto text-sm"
                >
                  <option value="">Personal (no library)</option>
                  {libraries.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <ul className="space-y-3">
            {proposals.map((p, i) => (
              <li
                key={i}
                className={`card ${p.checked ? '' : 'opacity-50'}`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={p.checked}
                    onChange={(e) =>
                      updateProposal(i, { checked: e.target.checked })
                    }
                    className="h-4 w-4 mt-1 rounded border-gray-300 text-umc-700"
                  />
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <div className="md:col-span-2">
                        <label className="label">Title</label>
                        <input
                          type="text"
                          className="input"
                          value={p.title}
                          onChange={(e) =>
                            updateProposal(i, { title: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <label className="label">Type</label>
                        <select
                          className="input"
                          value={p.resource_type}
                          onChange={(e) =>
                            updateProposal(i, { resource_type: e.target.value })
                          }
                        >
                          {TYPE_OPTIONS.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="label">Content</label>
                      <textarea
                        className="input min-h-[100px] text-sm"
                        value={p.content}
                        onChange={(e) =>
                          updateProposal(i, { content: e.target.value })
                        }
                      />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                      <div>
                        <label className="label">Themes (comma-separated)</label>
                        <input
                          type="text"
                          className="input"
                          value={p.themes}
                          onChange={(e) =>
                            updateProposal(i, { themes: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <label className="label">Scripture refs</label>
                        <input
                          type="text"
                          className="input"
                          value={p.scripture_refs}
                          onChange={(e) =>
                            updateProposal(i, { scripture_refs: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <label className="label">Tone</label>
                        <input
                          type="text"
                          className="input"
                          value={p.tone}
                          onChange={(e) =>
                            updateProposal(i, { tone: e.target.value })
                          }
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={reset}
              className="btn-secondary"
              disabled={importing}
            >
              ← Start over
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={importing}
              className="btn-primary disabled:opacity-50"
            >
              {importing
                ? 'Importing…'
                : `Import ${proposals.filter((p) => p.checked).length} resource${
                    proposals.filter((p) => p.checked).length === 1 ? '' : 's'
                  }`}
            </button>
          </div>
        </>
      )}

      {stage === 'done' && (
        <div className="card text-center space-y-3 py-10">
          <p className="text-lg text-umc-900">
            ✓ Imported {importedCount} resource{importedCount === 1 ? '' : 's'}.
          </p>
          <p className="text-sm text-gray-600">
            They're tagged <em>✨ Auto-generated</em> so you can find them
            later. You can clear that tag from each resource's detail page
            once you've reviewed it.
          </p>
          <div className="flex justify-center gap-2">
            <button type="button" onClick={reset} className="btn-secondary">
              Extract another source
            </button>
            <button
              type="button"
              onClick={() => navigate('/resources?auto=true')}
              className="btn-primary"
            >
              View imported resources
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
