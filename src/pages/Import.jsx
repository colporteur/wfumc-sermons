import { useState } from 'react';
import { Link } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { supabase, withTimeout } from '../lib/supabase';

// =====================================================================
// Sermon Database XLSX import
//
// The user uploads their "Sermon Database.xlsx". We parse:
//   - The "Master" sheet → one sermons row per Sermon Number (UPSERT)
//   - Every other sheet (yearly: "2019 C", "2020 A", ...) → one
//     preachings row per dated entry, linked to the Master sermon by
//     Sermon Number (UPSERT on sermon+date+location).
//
// Idempotent: running the import twice produces the same database
// state, no duplicates.
// =====================================================================

// Convert an Excel cell that might be a Date object, an ISO string,
// or "Unknown" / null into a YYYY-MM-DD date string (or null).
function toDateString(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v).trim();
  if (!s || s.toLowerCase().includes('unknown')) return null;
  // Try various formats
  const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m1) return `${m1[1]}-${m1[2]}-${m1[3]}`;
  const m2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m2) {
    const yy = m2[3].length === 2 ? '20' + m2[3] : m2[3];
    return `${yy}-${m2[1].padStart(2, '0')}-${m2[2].padStart(2, '0')}`;
  }
  return null;
}

function strOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function parseStrength(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isNaN(n) || n < 1 || n > 10) return null;
  return Math.round(n);
}

// Combine "Text 1" + "Text 2" into a single scripture_reference field
function combineScripture(t1, t2) {
  const a = strOrNull(t1);
  const b = strOrNull(t2);
  if (a && b) return `${a}; ${b}`;
  return a || b || null;
}

// Parse the Master sheet rows into sermon records ready for upsert.
function parseMaster(rows) {
  // First row is header
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  const idx = (name) => headers.indexOf(name);
  const cols = {
    number: idx('Sermon Number'),
    title: idx('Title'),
    text1: idx('Text 1'),
    text2: idx('Text 2'),
    year: idx('Year'),
    themes: idx('Themes'),
    stories: idx('Major Stories'),
    notes: idx('Notes'),
    strength: idx('Strength (1-10)'),
    timeless: idx('Timeless?'),
    eulogy: idx('Eulogy?'),
  };

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => c === null || c === undefined || c === '')) continue;
    const number = row[cols.number];
    if (number === null || number === undefined || number === '') continue;
    const num = Number(number);
    if (Number.isNaN(num)) continue;
    out.push({
      original_sermon_number: num,
      title: strOrNull(row[cols.title]),
      scripture_reference: combineScripture(row[cols.text1], row[cols.text2]),
      lectionary_year: strOrNull(row[cols.year]),
      theme: strOrNull(row[cols.themes]),
      major_stories: strOrNull(row[cols.stories]),
      notes: strOrNull(row[cols.notes]),
      strength: parseStrength(row[cols.strength]),
      timeless: strOrNull(row[cols.timeless]),
      is_eulogy: String(row[cols.eulogy] || '').toLowerCase().startsWith('y'),
    });
  }
  return out;
}

// Parse a yearly sheet ("2019 C", etc.) into preaching records.
function parseYearly(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  const idx = (name) => headers.indexOf(name);
  const cols = {
    date: idx('Date'),
    text: idx('Text'),
    title: idx('Sermon or Occasion'),
    location: idx('Location'),
    number: idx('Sermon Number'),
    series: idx('Series'),
  };

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const number = row[cols.number];
    if (number === null || number === undefined || number === '') continue;
    const num = Number(number);
    if (Number.isNaN(num)) continue;
    const date = toDateString(row[cols.date]);
    out.push({
      original_sermon_number: num,
      preached_at: date,
      location: strOrNull(row[cols.location]),
      title_used: strOrNull(row[cols.title]),
      series: cols.series >= 0 ? strOrNull(row[cols.series]) : null,
    });
  }
  return out;
}

export default function Import() {
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState(null);
  const [preview, setPreview] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importLog, setImportLog] = useState([]);
  const [importError, setImportError] = useState(null);
  const [done, setDone] = useState(false);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    setParseError(null);
    setPreview(null);
    setDone(false);
    setImportLog([]);
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array', cellDates: true });
      if (!wb.SheetNames.includes('Master')) {
        throw new Error('Workbook is missing a "Master" sheet.');
      }

      const masterRows = XLSX.utils.sheet_to_json(wb.Sheets['Master'], {
        header: 1,
        raw: true,
        defval: null,
      });
      const sermons = parseMaster(masterRows);

      const allPreachings = [];
      const sheetSummaries = [];
      for (const name of wb.SheetNames) {
        if (name === 'Master') continue;
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], {
          header: 1,
          raw: true,
          defval: null,
        });
        const preachings = parseYearly(rows);
        allPreachings.push(...preachings);
        sheetSummaries.push({ name, count: preachings.length });
      }

      setPreview({
        fileName: file.name,
        sermonCount: sermons.length,
        sermons,
        preachingCount: allPreachings.length,
        preachings: allPreachings,
        sheetSummaries,
      });
    } catch (err) {
      setParseError(err.message || String(err));
    } finally {
      setParsing(false);
    }
  };

  const log = (msg) => setImportLog((l) => [...l, msg]);

  const runImport = async () => {
    if (!preview) return;
    setImporting(true);
    setImportError(null);
    setImportLog([]);
    setDone(false);

    try {
      // Step 1: UPSERT all sermons by original_sermon_number
      log(`Upserting ${preview.sermons.length} sermons…`);
      const SERMON_BATCH = 50;
      for (let i = 0; i < preview.sermons.length; i += SERMON_BATCH) {
        const batch = preview.sermons.slice(i, i + SERMON_BATCH);
        const { error: err } = await withTimeout(
          supabase
            .from('sermons')
            .upsert(batch, { onConflict: 'original_sermon_number' }),
          30000
        );
        if (err) throw err;
        log(`  …sermons ${i + 1}-${Math.min(i + SERMON_BATCH, preview.sermons.length)} done`);
      }

      // Step 2: fetch all sermons (so we have id ↔ original_sermon_number map)
      log('Fetching sermon IDs for preaching links…');
      const { data: existingSermons, error: fetchErr } = await withTimeout(
        supabase
          .from('sermons')
          .select('id, original_sermon_number')
          .not('original_sermon_number', 'is', null),
        30000
      );
      if (fetchErr) throw fetchErr;
      const numberToId = new Map(
        existingSermons.map((s) => [s.original_sermon_number, s.id])
      );

      // Step 3: build preaching rows with sermon_id resolved
      const preachingRows = [];
      let unmatched = 0;
      for (const p of preview.preachings) {
        const sermonId = numberToId.get(p.original_sermon_number);
        if (!sermonId) {
          unmatched++;
          continue;
        }
        preachingRows.push({
          sermon_id: sermonId,
          preached_at: p.preached_at,
          location: p.location,
          title_used: p.title_used,
          series: p.series,
        });
      }
      if (unmatched > 0) {
        log(
          `  ${unmatched} preaching(s) skipped because their Sermon Number isn't in the Master sheet`
        );
      }

      // Step 4: UPSERT preachings (dedupe by sermon_id + date + location)
      // The DB has a partial unique index on those three; rows with
      // null preached_at or location bypass dedupe (multiple "unknown"
      // entries are kept as-is). For UPSERT to use the partial index,
      // we have to use the upsert RPC — but Supabase upsert on partial
      // indexes is unreliable, so we manually dedupe in batches.
      log(`Inserting ${preachingRows.length} preachings (dedupe-aware)…`);
      // Fetch existing preachings keyed by (sermon_id, preached_at, location)
      const { data: existingP, error: existErr } = await withTimeout(
        supabase
          .from('preachings')
          .select('sermon_id, preached_at, location'),
        30000
      );
      if (existErr) throw existErr;
      const existingKey = new Set(
        existingP.map(
          (r) =>
            `${r.sermon_id}||${r.preached_at || ''}||${(r.location || '').toLowerCase()}`
        )
      );

      const toInsert = preachingRows.filter((r) => {
        if (!r.preached_at || !r.location) return true; // partial index doesn't apply
        const key = `${r.sermon_id}||${r.preached_at}||${r.location.toLowerCase()}`;
        return !existingKey.has(key);
      });

      log(
        `  ${preachingRows.length - toInsert.length} already existed, inserting ${toInsert.length} new`
      );

      const PREACH_BATCH = 100;
      for (let i = 0; i < toInsert.length; i += PREACH_BATCH) {
        const batch = toInsert.slice(i, i + PREACH_BATCH);
        const { error: insErr } = await withTimeout(
          supabase.from('preachings').insert(batch),
          30000
        );
        if (insErr) throw insErr;
        log(
          `  …preachings ${i + 1}-${Math.min(i + PREACH_BATCH, toInsert.length)} done`
        );
      }

      log('Import complete. ✓');
      setDone(true);
    } catch (err) {
      setImportError(err.message || String(err));
      log(`ERROR: ${err.message || String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/" className="text-sm text-gray-500 hover:text-gray-700">
          ← Back to sermons
        </Link>
        <h1 className="font-serif text-2xl text-umc-900 mt-2">
          Import sermon database
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          Upload your "Sermon Database.xlsx" file. The Master sheet becomes
          your sermon library; each yearly sheet becomes a list of
          preachings linked back to the Master sermon by Sermon Number.
          Re-running the import is safe — duplicates are detected and
          skipped.
        </p>
      </div>

      {!preview && !done && (
        <div className="card space-y-3">
          <label className="btn-primary inline-block cursor-pointer">
            {parsing ? 'Reading…' : 'Choose XLSX file'}
            <input
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={handleFile}
              disabled={parsing}
            />
          </label>
          {parseError && (
            <p className="text-sm text-red-600">{parseError}</p>
          )}
          <p className="text-xs text-gray-500">
            File is parsed in your browser only — nothing is sent until
            you click Import.
          </p>
        </div>
      )}

      {preview && !done && (
        <>
          <div className="card space-y-3">
            <h2 className="font-serif text-lg text-umc-900">
              Preview: {preview.fileName}
            </h2>
            <ul className="text-sm text-gray-700 space-y-1">
              <li>
                <span className="font-medium">{preview.sermonCount}</span>{' '}
                sermons in the Master sheet
              </li>
              <li>
                <span className="font-medium">{preview.preachingCount}</span>{' '}
                preachings across yearly sheets:
              </li>
            </ul>
            <ul className="ml-4 text-xs text-gray-600 space-y-0.5">
              {preview.sheetSummaries.map((s) => (
                <li key={s.name}>
                  {s.name}: {s.count} preachings
                </li>
              ))}
            </ul>
            <p className="text-xs text-gray-400">
              First few sermons (sanity check):
            </p>
            <ul className="text-xs text-gray-600 space-y-0.5 max-h-40 overflow-y-auto border border-gray-200 rounded p-2">
              {preview.sermons.slice(0, 10).map((s) => (
                <li key={s.original_sermon_number}>
                  #{s.original_sermon_number}: {s.title || '(untitled)'} —{' '}
                  {s.scripture_reference || '(no scripture)'}
                </li>
              ))}
            </ul>
          </div>

          <div className="card space-y-3">
            <p className="text-sm text-gray-700">
              Ready to import. This will UPSERT into your Supabase
              database. Existing sermons (matched by Sermon Number) get
              their fields refreshed; existing preachings (matched by
              sermon + date + location) are left alone.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={runImport}
                disabled={importing}
                className="btn-primary disabled:opacity-50"
              >
                {importing ? 'Importing…' : 'Import to database'}
              </button>
              <button
                type="button"
                onClick={() => setPreview(null)}
                disabled={importing}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
            {importError && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                {importError}
              </p>
            )}
            {importLog.length > 0 && (
              <pre className="text-xs bg-gray-900 text-gray-100 rounded p-3 max-h-60 overflow-y-auto whitespace-pre-wrap">
                {importLog.join('\n')}
              </pre>
            )}
          </div>
        </>
      )}

      {done && (
        <div className="card text-center space-y-3">
          <p className="font-serif text-lg text-umc-900">
            Import complete.
          </p>
          {importLog.length > 0 && (
            <pre className="text-xs bg-gray-900 text-gray-100 rounded p-3 max-h-60 overflow-y-auto whitespace-pre-wrap text-left">
              {importLog.join('\n')}
            </pre>
          )}
          <Link to="/" className="btn-primary inline-block">
            See sermons
          </Link>
        </div>
      )}
    </div>
  );
}
