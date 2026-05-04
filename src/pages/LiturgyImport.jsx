import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { parseEnex } from '../lib/enex';
import { parseLiturgyIntoSections } from '../lib/claude';
import { matchLiturgyToSermons } from '../lib/liturgyMatch';
import { useAuth } from '../contexts/AuthContext.jsx';

const EXTERNAL_SOURCE = 'evernote';

// Import Evernote .enex liturgies into sermon_liturgies.
//
// Flow:
//   1. Upload .enex → parse to notes
//   2. Preview table (checkbox per liturgy, optional title edit)
//   3. Toggle: parse with Claude (split into sections + flag announcements)
//   4. Import: per liturgy → insert row → (optional) Claude parse →
//      insert sections → match against sermons → insert links
//   5. Done: summary + link to review queue for pending links
//
// Re-importing the same .enex is safe — the (owner, external_source,
// external_guid) unique index dedupes.
export default function LiturgyImport() {
  const { user } = useAuth();
  const [phase, setPhase] = useState('pick'); // pick | preview | importing | done
  const [error, setError] = useState(null);
  const [parsing, setParsing] = useState(false);
  const fileInputRef = useRef(null);
  const [parsed, setParsed] = useState([]); // raw notes from .enex
  const [rows, setRows] = useState({}); // { hash: { selected, title } }
  const [parseWithClaude, setParseWithClaude] = useState(true);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [results, setResults] = useState({
    inserted: 0,
    skipped: 0,
    sectionsParsed: 0,
    sectionsSkipped: 0,
    autoLinks: 0,
    pendingLinks: 0,
    errors: [],
  });
  const [sermons, setSermons] = useState([]); // for matcher

  // Pre-fetch the user's sermons so the matcher can run client-side.
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        const { data, error: err } = await withTimeout(
          supabase
            .from('sermons')
            .select('id, title, scripture_reference')
            .eq('owner_user_id', user.id)
        );
        if (err) throw err;
        setSermons(data ?? []);
      } catch (e) {
        // Non-fatal — matching just won't work.
        // eslint-disable-next-line no-console
        console.warn('Failed to load sermons for matcher:', e.message);
      }
    })();
  }, [user?.id]);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setParsing(true);
    try {
      const text = await file.text();
      const notes = await parseEnex(text);
      setParsed(notes);
      const initRows = {};
      for (const n of notes) {
        initRows[n.hash] = {
          selected: true,
          title: n.title || '(untitled)',
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

  const updateRow = (hash, patch) =>
    setRows((r) => ({ ...r, [hash]: { ...r[hash], ...patch } }));

  const toggleAll = (selected) =>
    setRows((r) => {
      const next = {};
      for (const k of Object.keys(r)) next[k] = { ...r[k], selected };
      return next;
    });

  const handleImport = async () => {
    setError(null);
    const toImport = parsed.filter((n) => rows[n.hash]?.selected);
    if (toImport.length === 0) {
      setError('Nothing selected to import.');
      return;
    }
    setImporting(true);
    setPhase('importing');
    const localResults = {
      inserted: 0,
      skipped: 0,
      sectionsParsed: 0,
      sectionsSkipped: 0,
      autoLinks: 0,
      pendingLinks: 0,
      errors: [],
    };
    setProgress({ done: 0, total: toImport.length, current: '' });

    for (let i = 0; i < toImport.length; i++) {
      const note = toImport[i];
      const row = rows[note.hash];
      setProgress({
        done: i,
        total: toImport.length,
        current: row?.title || note.title || '(untitled)',
      });
      try {
        // 1. Insert the top-level liturgy row.
        const liturgyPayload = {
          owner_user_id: user.id,
          title: (row?.title || note.title || '(untitled)').trim(),
          raw_body: note.content || '',
          external_source: EXTERNAL_SOURCE,
          external_guid: note.hash,
          original_created_at: note.created || null,
        };
        const { data: insertedLiturgy, error: insErr } = await withTimeout(
          supabase
            .from('sermon_liturgies')
            .insert(liturgyPayload)
            .select('id, title')
            .single()
        );
        if (insErr) {
          // Duplicate (re-import of same .enex) → skip silently.
          if (
            String(insErr.message || '')
              .toLowerCase()
              .includes('duplicate')
          ) {
            localResults.skipped++;
            continue;
          }
          throw insErr;
        }
        localResults.inserted++;
        const liturgyId = insertedLiturgy.id;

        // 2. Optional Claude section parsing.
        if (parseWithClaude && note.content?.trim()) {
          try {
            const sections = await parseLiturgyIntoSections({
              liturgyTitle: insertedLiturgy.title,
              liturgyBody: note.content,
            });
            if (sections.length > 0) {
              const { error: secErr } = await withTimeout(
                supabase.from('sermon_liturgy_sections').insert(
                  sections.map((s) => ({
                    liturgy_id: liturgyId,
                    owner_user_id: user.id,
                    section_kind: s.section_kind,
                    title: s.title,
                    body: s.body,
                    sort_order: s.sort_order,
                    is_announcement: s.is_announcement,
                  }))
                )
              );
              if (secErr) throw secErr;
              localResults.sectionsParsed += sections.length;
            }
          } catch (sectionErr) {
            // Don't bail the whole import — record the error and move on.
            // The pastor can re-parse from the liturgy detail page.
            localResults.sectionsSkipped++;
            localResults.errors.push(
              `${row?.title || note.title}: section parse failed (${sectionErr.message})`
            );
          }
        }

        // 3. Auto-link against sermons — but ONLY high-confidence matches.
        // Lower-confidence candidates clutter the review queue (a single
        // ENEX file produced 71 of them in early use). Pastor finds new
        // links on demand via the "Find by title" / "Find by scripture"
        // buttons on the liturgy / sermon detail pages.
        const matches = matchLiturgyToSermons(
          {
            title: insertedLiturgy.title,
            scripture_refs: '',
          },
          sermons
        ).filter((m) => m.confidence === 'high');
        if (matches.length > 0) {
          const linkRows = matches.map((m) => ({
            liturgy_id: liturgyId,
            sermon_id: m.sermon_id,
            owner_user_id: user.id,
            link_kind: m.link_kind,
            confidence: m.confidence,
            approved: true,
          }));
          const { error: linkErr } = await withTimeout(
            supabase.from('sermon_liturgy_links').insert(linkRows)
          );
          if (linkErr) throw linkErr;
          localResults.autoLinks += matches.length;
        }
      } catch (err) {
        localResults.errors.push(
          `${row?.title || note.title}: ${err.message || String(err)}`
        );
      }
    }
    setProgress({ done: toImport.length, total: toImport.length, current: '' });
    setResults(localResults);
    setImporting(false);
    setPhase('done');
  };

  // ---- Render ----

  return (
    <div className="space-y-6">
      <Link
        to="/liturgies"
        className="inline-block text-sm text-gray-500 hover:text-gray-700"
      >
        ← Back to liturgies
      </Link>

      <div>
        <h1 className="text-2xl font-serif text-umc-900">Import liturgies</h1>
        <p className="text-sm text-gray-600 mt-1">
          Upload an Evernote <code>.enex</code> export of liturgical notes.
          Each note becomes a liturgy linked (where possible) to one or more
          sermons by title or scripture. Optionally Claude can parse each
          liturgy into sections (call to worship, prayer, scripture, etc.) so
          you can re-use individual pieces in future bulletins.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      {phase === 'pick' && (
        <div className="card space-y-3">
          <label className="label">Choose .enex file</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".enex,application/xml"
            onChange={handleFile}
            disabled={parsing}
            className="block text-sm"
          />
          {parsing && (
            <p className="text-xs text-gray-500 italic">Parsing…</p>
          )}
        </div>
      )}

      {phase === 'preview' && (
        <>
          <div className="card flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-umc-900">
                <strong>{parsed.length}</strong> liturgies parsed.{' '}
                <strong>
                  {Object.values(rows).filter((r) => r.selected).length}
                </strong>{' '}
                selected.
              </p>
              <label className="text-xs text-gray-700 mt-1 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={parseWithClaude}
                  onChange={(e) => setParseWithClaude(e.target.checked)}
                />
                Parse each liturgy into sections with Claude during import
                (~10–30 sec per liturgy)
              </label>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => toggleAll(true)}
                className="btn-secondary text-sm"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => toggleAll(false)}
                className="btn-secondary text-sm"
              >
                Select none
              </button>
              <button
                type="button"
                onClick={handleImport}
                className="btn-primary text-sm"
              >
                Import selected
              </button>
            </div>
          </div>

          <ul className="space-y-2">
            {parsed.map((n) => {
              const r = rows[n.hash] || {};
              return (
                <li
                  key={n.hash}
                  className={`card ${r.selected ? '' : 'opacity-50'}`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={!!r.selected}
                      onChange={(e) =>
                        updateRow(n.hash, { selected: e.target.checked })
                      }
                      className="h-4 w-4 mt-1 rounded border-gray-300 text-umc-700"
                    />
                    <div className="flex-1 min-w-0">
                      <input
                        type="text"
                        className="input text-sm font-medium"
                        value={r.title ?? ''}
                        onChange={(e) =>
                          updateRow(n.hash, { title: e.target.value })
                        }
                      />
                      <p className="mt-1 text-xs text-gray-500">
                        {(n.content || '').slice(0, 200)}
                        {(n.content || '').length > 200 ? '…' : ''}
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {phase === 'importing' && (
        <div className="card space-y-3">
          <p className="text-sm text-umc-900">
            Importing {progress.done + 1} of {progress.total}…
          </p>
          {progress.current && (
            <p className="text-xs text-gray-500 italic">
              Current: {progress.current}
            </p>
          )}
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div
              className="bg-umc-700 h-2 rounded-full transition-all"
              style={{
                width: `${(progress.done / Math.max(1, progress.total)) * 100}%`,
              }}
            />
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="card space-y-3 py-8">
          <p className="text-lg text-umc-900 text-center">
            ✓ Import complete.
          </p>
          <ul className="text-sm text-gray-700 max-w-md mx-auto space-y-1">
            <li>Inserted: <strong>{results.inserted}</strong> liturgies</li>
            {results.skipped > 0 && (
              <li>Skipped (duplicates): {results.skipped}</li>
            )}
            {results.sectionsParsed > 0 && (
              <li>Parsed into <strong>{results.sectionsParsed}</strong> sections</li>
            )}
            {results.sectionsSkipped > 0 && (
              <li>Section parse failed for {results.sectionsSkipped} liturgies (you can re-parse from the detail page)</li>
            )}
            {results.autoLinks > 0 && (
              <li>Auto-linked to sermons: <strong>{results.autoLinks}</strong></li>
            )}
            {results.pendingLinks > 0 && (
              <li>
                <strong>{results.pendingLinks}</strong> link suggestions pending review →{' '}
                <Link to="/liturgies/review" className="text-umc-700 underline">
                  Review now
                </Link>
              </li>
            )}
            {results.errors.length > 0 && (
              <li className="text-red-700 mt-2">
                {results.errors.length} errors:
                <ul className="list-disc ml-5 mt-1 text-xs">
                  {results.errors.slice(0, 5).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                  {results.errors.length > 5 && (
                    <li>…and {results.errors.length - 5} more</li>
                  )}
                </ul>
              </li>
            )}
          </ul>
          <div className="flex justify-center gap-2 pt-2">
            <Link to="/liturgies" className="btn-primary text-sm">
              View liturgies
            </Link>
            <button
              type="button"
              onClick={() => {
                setPhase('pick');
                setParsed([]);
                setRows({});
                setResults({
                  inserted: 0,
                  skipped: 0,
                  sectionsParsed: 0,
                  sectionsSkipped: 0,
                  autoLinks: 0,
                  pendingLinks: 0,
                  errors: [],
                });
              }}
              className="btn-secondary text-sm"
            >
              Import another file
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
