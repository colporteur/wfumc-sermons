import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext.jsx';
import { uploadBackgroundDoc } from '../lib/backgroundDocs';
import { listCommentarySets, createCommentarySet } from '../lib/commentarySets';

// /quick-add — the phone flow. The Workspace/Studio panels are dense
// on a small screen; this page is three big controls:
//   1. Which sermon (recent first)
//   2. Which commentary set, optional ("+ add new" inline)
//   3. Camera / file input → upload
// Uploaded sources land in sermon_background_docs and appear on the
// desktop panels via their ↻ refresh buttons. Consecutive page photos
// tagged with the same set travel as one ordered source.
export default function QuickAddSource() {
  const { user } = useAuth();

  const [sermons, setSermons] = useState([]);
  const [sermonId, setSermonId] = useState('');
  const [sets, setSets] = useState([]);
  const [setId, setSetId] = useState('');
  const [newSetOpen, setNewSetOpen] = useState(false);
  const [newSetTitle, setNewSetTitle] = useState('');

  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState([]); // titles uploaded this visit
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const [sermonRes, setRows] = await Promise.all([
          withTimeout(
            supabase
              .from('sermons')
              .select('id, title, scripture_reference, is_eulogy, deceased_name')
              .eq('owner_user_id', user.id)
              .order('updated_at', { ascending: false })
              .limit(25)
          ),
          listCommentarySets(),
        ]);
        if (cancelled) return;
        if (sermonRes.error) throw sermonRes.error;
        setSermons(sermonRes.data || []);
        if ((sermonRes.data || []).length > 0) setSermonId(sermonRes.data[0].id);
        setSets(setRows);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  async function handleCreateSet(e) {
    e?.preventDefault?.();
    setError(null);
    try {
      const row = await createCommentarySet({
        ownerUserId: user.id,
        title: newSetTitle,
      });
      setSets((cur) =>
        [...cur, row].sort((a, b) => a.title.localeCompare(b.title))
      );
      setSetId(row.id);
      setNewSetTitle('');
      setNewSetOpen(false);
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length || !sermonId) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of files) {
        const row = await uploadBackgroundDoc({
          sermonId,
          ownerUserId: user.id,
          file,
          commentarySetId: setId || null,
        });
        setDone((cur) => [...cur, row.title]);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  }

  const sermonLabel = (s) =>
    (s.is_eulogy ? '[Eulogy] ' : '') +
    (s.title || '(untitled)') +
    (s.scripture_reference ? ` — ${s.scripture_reference}` : '');

  if (loading) {
    return <p className="p-4 text-gray-500">Loading…</p>;
  }

  return (
    <div className="max-w-md mx-auto space-y-5 p-1">
      <div>
        <h1 className="font-serif text-2xl text-umc-900">Quick add source</h1>
        <p className="text-sm text-gray-600 mt-1">
          Snap commentary pages or upload files straight into a sermon's
          sources. Tap ↻ on the desktop panel to see them there.
        </p>
      </div>

      <label className="block">
        <span className="label">Sermon</span>
        <select
          className="input text-base py-3"
          value={sermonId}
          onChange={(e) => setSermonId(e.target.value)}
        >
          {sermons.map((s) => (
            <option key={s.id} value={s.id}>
              {sermonLabel(s)}
            </option>
          ))}
        </select>
      </label>

      <div>
        <span className="label">Commentary set (optional)</span>
        <select
          className="input text-base py-3"
          value={setId}
          onChange={(e) => {
            if (e.target.value === '__new__') {
              setNewSetOpen(true);
            } else {
              setSetId(e.target.value);
            }
          }}
        >
          <option value="">No set — standalone source</option>
          {sets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
          <option value="__new__">+ Add a new set…</option>
        </select>
        <p className="text-xs text-gray-500 mt-1">
          Pages photographed into the same set travel together, in
          order, as one source.
        </p>
        {newSetOpen && (
          <form onSubmit={handleCreateSet} className="mt-2 flex gap-2">
            <input
              className="input text-base py-3"
              placeholder='e.g., "NIB — Romans"'
              value={newSetTitle}
              onChange={(e) => setNewSetTitle(e.target.value)}
              autoFocus
            />
            <button
              className="btn-primary shrink-0"
              disabled={!newSetTitle.trim()}
            >
              Add
            </button>
          </form>
        )}
      </div>

      <div className="space-y-2">
        {/* Camera capture — phones open the camera directly. */}
        <label className="btn-primary w-full py-4 text-base cursor-pointer text-center block">
          {uploading ? 'Uploading…' : 'Take photo(s)'}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            disabled={uploading || !sermonId}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </label>
        {/* Photo picker — no `capture` attribute, so phones open the
            gallery/camera-roll with multi-select instead of the camera. */}
        <label className="btn-primary w-full py-4 text-base cursor-pointer text-center block">
          Camera roll (select several)
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            disabled={uploading || !sermonId}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </label>
        <label className="btn-secondary w-full py-4 text-base cursor-pointer text-center block">
          📄 Choose files (.pdf / .jpg / .png / .txt)
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.txt,.md,application/pdf,image/jpeg,image/png,text/plain"
            multiple
            className="hidden"
            disabled={uploading || !sermonId}
            onChange={(e) => handleFiles(e.target.files)}
          />
        </label>
      </div>

      {done.length > 0 && (
        <div className="card">
          <p className="text-sm font-medium text-green-700">
            ✓ Uploaded this visit:
          </p>
          <ul className="mt-1 text-sm text-gray-700 space-y-0.5">
            {done.map((t, i) => (
              <li key={i}>• {t}</li>
            ))}
          </ul>
          <p className="text-xs text-gray-500 mt-2">
            Keep snapping — pages land in upload order.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      <Link to="/" className="block text-sm text-gray-500 underline">
        ← Back to sermons
      </Link>
    </div>
  );
}
