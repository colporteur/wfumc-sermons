import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext.jsx';

// Post-commit landing page from the manuscript batch importer.
// Reads the queued preachings (from sessionStorage), shows the import
// results tally, and lets the pastor confirm + edit + create-or-skip
// each preaching record before they hit the database.
//
// Per pastor's preference: do NOT auto-create preachings during the
// manuscript import — queue them for review here, then create only
// the ones the pastor confirms.

const QUEUE_KEY = 'wfumc-import-preachings-queue';

const DEFAULT_LOCATION = 'Wedowee First UMC';

function loadQueue() {
  try {
    const raw = sessionStorage.getItem(QUEUE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default function ImportManuscriptsReviewPreachings() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [queue, setQueue] = useState(null);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  useEffect(() => {
    const q = loadQueue();
    if (!q) {
      // No queue — bounce back to import page.
      navigate('/sermons/import-manuscripts', { replace: true });
      return;
    }
    setQueue(q);
    setItems(
      (q.items || []).map((it, i) => ({
        ...it,
        uid: `pr${i}`,
        location: DEFAULT_LOCATION,
        action: 'create', // 'create' | 'skip'
      }))
    );
  }, [navigate]);

  const updateItem = (uid, patch) => {
    setItems((prev) => prev.map((it) => (it.uid === uid ? { ...it, ...patch } : it)));
  };

  const setAllAction = (action) => {
    setItems((prev) => prev.map((it) => ({ ...it, action })));
  };
  const setAllLocation = (location) => {
    setItems((prev) => prev.map((it) => ({ ...it, location })));
  };

  const handleCommit = async () => {
    if (!user?.id) return;
    const targets = items.filter((it) => it.action === 'create');
    if (targets.length === 0) {
      setError('Nothing selected to create.');
      return;
    }
    setBusy(true);
    setError(null);
    const results = { created: 0, skipped_existing: 0, failed: 0, errors: [] };
    for (const it of targets) {
      try {
        // Skip if a matching preaching already exists for (sermon, date).
        const { data: existing, error: checkErr } = await withTimeout(
          supabase
            .from('preachings')
            .select('id')
            .eq('sermon_id', it.sermonId)
            .eq('preached_at', it.date)
            .maybeSingle()
        );
        if (checkErr) throw checkErr;
        if (existing) {
          results.skipped_existing++;
          continue;
        }
        const { error: insErr } = await withTimeout(
          supabase.from('preachings').insert({
            sermon_id: it.sermonId,
            preached_at: it.date,
            location: it.location || DEFAULT_LOCATION,
            owner_user_id: user.id,
          })
        );
        if (insErr) throw insErr;
        results.created++;
      } catch (e) {
        results.failed++;
        results.errors.push({ sermon: it.sermonTitle, error: e.message || String(e) });
      }
    }
    setBusy(false);
    setDone(results);
    // Clear the queue so reloading the page doesn't re-show it.
    try {
      sessionStorage.removeItem(QUEUE_KEY);
    } catch {
      /* noop */
    }
  };

  if (!queue) return null;
  const importResults = queue.results || {};

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <Link
          to="/sermons/import-manuscripts"
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← Manuscript import
        </Link>
        <h1 className="font-serif text-2xl text-umc-900 mt-1">
          Review preachings to create
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          The manuscript import landed. Each imported manuscript that
          carried a preached date is queued below — review the location
          and date, then create the preachings that should land on your
          archive.
        </p>
      </div>

      <div className="card text-sm space-y-1">
        <h2 className="font-serif text-lg text-umc-900">
          Import results
        </h2>
        <ul className="text-gray-700">
          {importResults.added_canonical > 0 && (
            <li>
              ✓ Manuscripts set as canonical:{' '}
              <strong>{importResults.added_canonical}</strong>
            </li>
          )}
          {importResults.added_revision > 0 && (
            <li>
              ↻ Manuscripts saved as revisions:{' '}
              <strong>{importResults.added_revision}</strong>
            </li>
          )}
          {importResults.created_sermons > 0 && (
            <li>
              ★ New sermon detail pages created:{' '}
              <strong>{importResults.created_sermons}</strong>
            </li>
          )}
          {importResults.failed > 0 && (
            <li className="text-red-700">
              ⚠ Failed: <strong>{importResults.failed}</strong>
            </li>
          )}
        </ul>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      {done ? (
        <div className="card text-sm space-y-2">
          <h2 className="font-serif text-lg text-umc-900">
            Preachings created
          </h2>
          <ul>
            <li className="text-green-700">
              ✓ Created: <strong>{done.created}</strong>
            </li>
            {done.skipped_existing > 0 && (
              <li className="text-gray-700">
                Skipped (already existed):{' '}
                <strong>{done.skipped_existing}</strong>
              </li>
            )}
            {done.failed > 0 && (
              <li className="text-red-700">
                ⚠ Failed: <strong>{done.failed}</strong>
              </li>
            )}
          </ul>
          <div className="flex justify-end gap-2 pt-1">
            <Link to="/" className="btn-secondary text-sm">
              View sermons
            </Link>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="card text-sm text-gray-700">
          No preachings to create — none of the imported manuscripts
          carried a preached date. You can add preachings manually from
          each sermon's detail page.
          <div className="mt-3 flex justify-end">
            <Link to="/" className="btn-secondary text-sm">
              View sermons
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="card flex flex-wrap items-center justify-between gap-3 sticky top-0 z-10">
            <div className="text-sm text-gray-700">
              <strong>{items.length}</strong> preachings queued
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <input
                type="text"
                placeholder={`Set all locations to "${DEFAULT_LOCATION}"`}
                onBlur={(e) => {
                  if (e.target.value.trim()) setAllLocation(e.target.value.trim());
                  e.target.value = '';
                }}
                className="input text-xs"
                style={{ width: '14rem' }}
              />
              <button
                type="button"
                onClick={() => setAllAction('create')}
                className="btn-secondary text-xs"
              >
                ✓ Create all
              </button>
              <button
                type="button"
                onClick={() => setAllAction('skip')}
                className="btn-secondary text-xs"
              >
                ✗ Skip all
              </button>
              <button
                type="button"
                onClick={handleCommit}
                disabled={busy}
                className="btn-primary text-xs disabled:opacity-50"
              >
                {busy
                  ? 'Creating…'
                  : `Create ${items.filter((it) => it.action === 'create').length} preachings`}
              </button>
            </div>
          </div>

          <div className="card">
            <ul className="divide-y divide-gray-200">
              {items.map((it) => (
                <li key={it.uid} className="py-2">
                  <div className="flex items-center gap-3 flex-wrap">
                    <input
                      type="checkbox"
                      checked={it.action === 'create'}
                      onChange={(e) =>
                        updateItem(it.uid, { action: e.target.checked ? 'create' : 'skip' })
                      }
                      className="rounded border-gray-300"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {it.sermonTitle}
                      </div>
                      <div className="text-[10px] text-gray-500 truncate">
                        from {it.filename}
                      </div>
                    </div>
                    <input
                      type="date"
                      value={it.date}
                      onChange={(e) => updateItem(it.uid, { date: e.target.value })}
                      className="input text-xs"
                      style={{ width: '10rem' }}
                    />
                    <input
                      type="text"
                      value={it.location}
                      onChange={(e) => updateItem(it.uid, { location: e.target.value })}
                      placeholder="Location"
                      className="input text-xs"
                      style={{ width: '14rem' }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
