import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { parseEnex } from '../lib/enex';
import { classifyResources, isGenericTitle } from '../lib/claude';
import { listMyLibraries } from '../lib/libraries';
import {
  uploadResourceImage,
  attachImageIfNew,
} from '../lib/resourceImages';
import { useAuth } from '../contexts/AuthContext.jsx';

const TYPE_CHOICES = [
  { value: 'story', label: 'Story' },
  { value: 'quote', label: 'Quote' },
  { value: 'illustration', label: 'Illustration' },
  { value: 'joke', label: 'Joke' },
  { value: 'note', label: 'Note' },
  { value: 'photo', label: 'Photo' },
];

const EXTERNAL_SOURCE = 'evernote';

// Import Evernote .enex files into the resource library.
//
// Flow: drop file → parse → preview table → (optional) Claude classify
// → bulk insert with progress. Re-importing the same file is safe
// because we dedupe on (owner, source, hash).
export default function ImportResources() {
  const { user } = useAuth();
  const [phase, setPhase] = useState('pick'); // pick | preview | importing | done
  const [error, setError] = useState(null);
  const [parsing, setParsing] = useState(false);
  const fileInputRef = useRef(null);
  const [parsed, setParsed] = useState([]); // raw notes from enex
  // per-row state, keyed by hash
  const [rows, setRows] = useState({}); // { hash: { selected, type } }
  const [libraries, setLibraries] = useState([]);
  const [libraryId, setLibraryId] = useState('');
  const [classifying, setClassifying] = useState(false);
  const [classifyMsg, setClassifyMsg] = useState(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState({
    inserted: 0,
    skipped: 0,
    imagesUploaded: 0,
    imagesSkipped: 0,
    errors: [],
  });

  useEffect(() => {
    listMyLibraries()
      .then((libs) => setLibraries(libs))
      .catch(() => setLibraries([]));
  }, []);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setParsing(true);
    try {
      const text = await file.text();
      const notes = await parseEnex(text);
      setParsed(notes);
      // Initialize rows: all selected, default type 'note', editable
      // title seeded from the parsed note (blank when generic so the
      // user notices and either lets Claude propose or types one).
      const initRows = {};
      for (const n of notes) {
        initRows[n.hash] = {
          selected: true,
          type: 'note',
          title: isGenericTitle(n.title) ? '' : n.title,
        };
      }
      setRows(initRows);
      setPhase('preview');
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const updateRow = (hash, patch) => {
    setRows((r) => ({ ...r, [hash]: { ...r[hash], ...patch } }));
  };

  const setAll = (patch) => {
    setRows((r) => {
      const next = {};
      for (const k of Object.keys(r)) next[k] = { ...r[k], ...patch };
      return next;
    });
  };

  const runClassify = async () => {
    setClassifying(true);
    setClassifyMsg(null);
    setError(null);
    try {
      const items = parsed
        .filter((n) => rows[n.hash]?.selected)
        .map((n) => ({
          id: n.hash,
          title: n.title,
          snippet: n.content,
        }));
      if (items.length === 0) {
        setClassifyMsg('Nothing selected to classify.');
        return;
      }
      const result = await classifyResources(items);
      let titledCount = 0;
      setRows((r) => {
        const next = { ...r };
        for (const [hash, info] of Object.entries(result)) {
          if (!next[hash]) continue;
          const patch = { type: info.type };
          // Only fill in a Claude-proposed title if the user hasn't
          // already typed one in.
          if (info.title && !next[hash].title?.trim()) {
            patch.title = info.title;
            titledCount += 1;
          }
          next[hash] = { ...next[hash], ...patch };
        }
        return next;
      });
      setClassifyMsg(
        `Classified ${Object.keys(result).length} notes` +
          (titledCount > 0 ? ` · titled ${titledCount} previously-untitled` : '') +
          '.'
      );
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setClassifying(false);
    }
  };

  const runImport = async () => {
    if (!user?.id) return;
    const selected = parsed.filter((n) => rows[n.hash]?.selected);
    if (selected.length === 0) {
      setError('Nothing selected to import.');
      return;
    }
    setImporting(true);
    setPhase('importing');
    setError(null);
    setProgress({ done: 0, total: selected.length });
    const errors = [];
    let inserted = 0;
    let skipped = 0;
    let imagesUploaded = 0;
    let imagesSkipped = 0;

    // Per-note loop — gives us the resource id back so we can attach
    // images, and lets us report errors per note instead of per chunk.
    for (let i = 0; i < selected.length; i++) {
      const n = selected[i];
      try {
        const { data: created, error: err } = await withTimeout(
          supabase
            .from('resources')
            .upsert(
              {
                owner_user_id: user.id,
                library_id: libraryId || null,
                resource_type: rows[n.hash]?.type || 'note',
                // Prefer per-row title (user edit OR Claude-proposed),
                // fall back to parsed title — but never save the
                // generic "Untitled Note" placeholder.
                title:
                  (rows[n.hash]?.title && rows[n.hash].title.trim()) ||
                  (isGenericTitle(n.title) ? null : n.title) ||
                  null,
                content: n.content || '',
                source: null,
                source_url: n.sourceUrl || null,
                themes: n.tags ?? [],
                scripture_refs: null,
                tone: null,
                notes: null,
                external_source: EXTERNAL_SOURCE,
                external_guid: n.hash,
                original_created_at: n.createdAt || null,
              },
              {
                onConflict: 'owner_user_id,external_source,external_guid',
                ignoreDuplicates: false,
              }
            )
            .select('id')
            .single(),
          30000
        );
        if (err) throw err;
        inserted += 1;

        // Attach images. Each is dedupe-keyed by content_hash within the
        // resource — re-running a .enex won't pile up duplicate images.
        for (let j = 0; j < (n.images?.length ?? 0); j++) {
          const img = n.images[j];
          try {
            // Wrap blob with name + type so storage helpers pick a sane
            // extension & content type.
            const file = new File(
              [img.blob],
              img.fileName || `image-${j}.${img.mime.split('/')[1] || 'bin'}`,
              { type: img.mime }
            );
            const path = await uploadResourceImage({
              file,
              ownerUserId: user.id,
              resourceId: created.id,
            });
            const result = await attachImageIfNew({
              resourceId: created.id,
              ownerUserId: user.id,
              imagePath: path,
              sortOrder: j,
              contentHash: img.contentHash,
            });
            if (result.skipped) imagesSkipped += 1;
            else imagesUploaded += 1;
          } catch (imgErr) {
            errors.push({
              chunk: `${n.title || '(untitled)'} — image ${j + 1}`,
              message: imgErr.message || String(imgErr),
            });
          }
        }
      } catch (e) {
        errors.push({
          chunk: `${n.title || '(untitled)'}`,
          message: e.message || String(e),
        });
        skipped += 1;
      }
      setProgress({ done: i + 1, total: selected.length });
    }

    setResults({ inserted, skipped, imagesUploaded, imagesSkipped, errors });
    setImporting(false);
    setPhase('done');
  };

  const reset = () => {
    setPhase('pick');
    setParsed([]);
    setRows({});
    setError(null);
    setProgress({ done: 0, total: 0 });
    setResults({
      inserted: 0,
      skipped: 0,
      imagesUploaded: 0,
      imagesSkipped: 0,
      errors: [],
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm">
        <Link to="/" className="text-gray-500 hover:text-gray-700">
          ← Sermon archive
        </Link>
        <span className="text-gray-300">·</span>
        <Link to="/resources" className="text-gray-500 hover:text-gray-700">
          Resources
        </Link>
      </div>

      <div>
        <h1 className="font-serif text-2xl text-umc-900">Import resources</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Drop in an Evernote <code>.enex</code> export to bring notes into
          your library. Re-importing the same file is safe — duplicates are
          detected by content hash.
        </p>
      </div>

      {error && (
        <div className="card border-red-200 bg-red-50">
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {phase === 'pick' && (
        <div className="card text-center py-10 space-y-4">
          <p className="text-sm text-gray-600">
            In Evernote: right-click a notebook → <strong>Export Notebook…</strong> → choose <strong>ENEX</strong>.
          </p>
          <label
            className={`btn-primary inline-block cursor-pointer ${
              parsing ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
            {parsing ? 'Parsing…' : '📂 Choose .enex file'}
            <input
              ref={fileInputRef}
              type="file"
              accept=".enex,application/xml,text/xml"
              className="hidden"
              onChange={handleFile}
              disabled={parsing}
            />
          </label>
        </div>
      )}

      {phase === 'preview' && (
        <PreviewStep
          parsed={parsed}
          rows={rows}
          libraries={libraries}
          libraryId={libraryId}
          setLibraryId={setLibraryId}
          updateRow={updateRow}
          setAll={setAll}
          onClassify={runClassify}
          classifying={classifying}
          classifyMsg={classifyMsg}
          onImport={runImport}
          onCancel={reset}
        />
      )}

      {phase === 'importing' && (
        <div className="card text-center py-10 space-y-3">
          <p className="text-sm text-gray-700">
            Importing… {progress.done} of {progress.total}
          </p>
          <div className="w-full bg-gray-200 rounded h-2">
            <div
              className="bg-umc-700 h-2 rounded transition-all"
              style={{
                width: progress.total
                  ? `${(progress.done / progress.total) * 100}%`
                  : '0%',
              }}
            />
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="card space-y-3">
          <h2 className="font-serif text-lg text-umc-900">Import complete</h2>
          <p className="text-sm text-gray-700">
            Processed <strong>{results.inserted}</strong> resources
            {results.skipped > 0 && (
              <>
                {' '}· <span className="text-red-600">{results.skipped} failed</span>
              </>
            )}
            .
          </p>
          {(results.imagesUploaded > 0 || results.imagesSkipped > 0) && (
            <p className="text-sm text-gray-600">
              Uploaded <strong>{results.imagesUploaded}</strong> images
              {results.imagesSkipped > 0 && (
                <>
                  {' '}·{' '}
                  <span className="text-gray-500">
                    {results.imagesSkipped} already existed
                  </span>
                </>
              )}
              .
            </p>
          )}
          {results.errors.length > 0 && (
            <details className="text-xs text-gray-600">
              <summary className="cursor-pointer">Show errors</summary>
              <ul className="mt-2 space-y-1 font-mono">
                {results.errors.map((e, i) => (
                  <li key={i}>
                    Chunk {e.chunk}: {e.message}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex gap-2">
            <Link to="/resources" className="btn-primary">
              View resources
            </Link>
            <button onClick={reset} className="btn-secondary">
              Import another file
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewStep({
  parsed,
  rows,
  libraries,
  libraryId,
  setLibraryId,
  updateRow,
  setAll,
  onClassify,
  classifying,
  classifyMsg,
  onImport,
  onCancel,
}) {
  const selectedCount = parsed.filter((n) => rows[n.hash]?.selected).length;

  return (
    <>
      <div className="card space-y-3">
        <p className="text-sm text-gray-700">
          Found <strong>{parsed.length}</strong> notes. Pick which to import,
          set a target library, and (optionally) ask Claude to classify them.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Import into library</label>
            <select
              className="input"
              value={libraryId}
              onChange={(e) => setLibraryId(e.target.value)}
            >
              <option value="">Just me (private)</option>
              {libraries.map((lib) => (
                <option key={lib.id} value={lib.id}>
                  {lib.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Bulk actions</label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setAll({ selected: true })}
                className="btn-secondary text-xs"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setAll({ selected: false })}
                className="btn-secondary text-xs"
              >
                Deselect all
              </button>
              <button
                type="button"
                onClick={onClassify}
                disabled={classifying || selectedCount === 0}
                className="btn-secondary text-xs disabled:opacity-50"
              >
                {classifying
                  ? 'Classifying…'
                  : `✨ Classify ${selectedCount} with Claude`}
              </button>
            </div>
            {classifyMsg && (
              <p className="text-xs text-gray-500 mt-1">{classifyMsg}</p>
            )}
          </div>
        </div>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="text-left px-3 py-2 w-10">
                <span className="sr-only">Include</span>
              </th>
              <th className="text-left px-3 py-2">Title</th>
              <th className="text-left px-3 py-2 w-32">Type</th>
              <th className="text-left px-3 py-2 hidden md:table-cell">Tags</th>
              <th className="text-left px-3 py-2 w-24 hidden md:table-cell">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {parsed.map((n) => {
              const row = rows[n.hash] || { selected: true, type: 'note' };
              return (
                <tr
                  key={n.hash}
                  className={row.selected ? '' : 'opacity-50'}
                >
                  <td className="px-3 py-2 align-top">
                    <input
                      type="checkbox"
                      checked={!!row.selected}
                      onChange={(e) =>
                        updateRow(n.hash, { selected: e.target.checked })
                      }
                      className="h-4 w-4 rounded border-gray-300 text-umc-700"
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <input
                      type="text"
                      className="input text-sm py-1 font-medium"
                      value={row.title ?? ''}
                      onChange={(e) =>
                        updateRow(n.hash, { title: e.target.value })
                      }
                      placeholder={
                        isGenericTitle(n.title)
                          ? 'Untitled — type or use Claude'
                          : n.title
                      }
                    />
                    {n.images?.length > 0 && (
                      <div className="mt-1">
                        <span className="text-[10px] uppercase tracking-wide text-pink-700">
                          {n.images.length} image{n.images.length === 1 ? '' : 's'}
                        </span>
                      </div>
                    )}
                    <p className="text-xs text-gray-600 line-clamp-2 mt-1">
                      {n.content}
                    </p>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <select
                      className="input text-xs py-1"
                      value={row.type}
                      onChange={(e) =>
                        updateRow(n.hash, { type: e.target.value })
                      }
                    >
                      {TYPE_CHOICES.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2 align-top hidden md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {n.tags.slice(0, 4).map((t) => (
                        <span
                          key={t}
                          className="px-1.5 py-0.5 text-[10px] rounded bg-umc-100 text-umc-900"
                        >
                          {t}
                        </span>
                      ))}
                      {n.tags.length > 4 && (
                        <span className="text-[10px] text-gray-500">
                          +{n.tags.length - 4}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-gray-500 hidden md:table-cell">
                    {n.createdAt
                      ? new Date(n.createdAt).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'short',
                        })
                      : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card sticky bottom-2 flex items-center justify-between">
        <p className="text-sm text-gray-600">
          {selectedCount} of {parsed.length} selected
        </p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={onImport}
            disabled={selectedCount === 0}
            className="btn-primary disabled:opacity-50"
          >
            Import {selectedCount} resource{selectedCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </>
  );
}
