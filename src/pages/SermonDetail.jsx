import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import LoadingSpinner from '../components/LoadingSpinner.jsx';

function fmtDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  return new Date(yyyymmdd + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export default function SermonDetail() {
  const { id } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sermon, setSermon] = useState(null);
  // Bulletins this sermon has been preached at (via liturgy_items.sermon_id)
  const [preachedAt, setPreachedAt] = useState([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    title: '',
    scripture_reference: '',
    theme: '',
    notes: '',
    preached_at: '',
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [sermonRes, linksRes] = await Promise.all([
          withTimeout(
            supabase.from('sermons').select('*').eq('id', id).maybeSingle()
          ),
          withTimeout(
            supabase
              .from('liturgy_items')
              .select(
                'id, bulletin:bulletins(id, service_date, sunday_designation, status)'
              )
              .eq('sermon_id', id)
          ),
        ]);
        if (sermonRes.error) throw sermonRes.error;
        if (linksRes.error) throw linksRes.error;
        if (cancelled) return;
        setSermon(sermonRes.data);
        const bulletins = (linksRes.data ?? [])
          .map((row) => row.bulletin)
          .filter(Boolean)
          .sort((a, b) => (a.service_date < b.service_date ? 1 : -1));
        setPreachedAt(bulletins);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const startEdit = () => {
    if (!sermon) return;
    setDraft({
      title: sermon.title ?? '',
      scripture_reference: sermon.scripture_reference ?? '',
      theme: sermon.theme ?? '',
      notes: sermon.notes ?? '',
      preached_at: sermon.preached_at ?? '',
    });
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const saveEdit = async () => {
    setSaving(true);
    setError(null);
    try {
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermons')
          .update({
            title: draft.title.trim() || null,
            scripture_reference: draft.scripture_reference.trim() || null,
            theme: draft.theme.trim() || null,
            notes: draft.notes.trim() || null,
            preached_at: draft.preached_at || null,
          })
          .eq('id', id)
          .select()
          .single()
      );
      if (err) throw err;
      setSermon(data);
      setEditing(false);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSpinner label="Loading sermon…" />;
  if (error) {
    return (
      <div className="card text-center space-y-3">
        <p className="text-sm text-red-700">Couldn't load sermon.</p>
        <p className="text-xs text-gray-500">{error}</p>
        <Link to="/" className="btn-secondary inline-block">
          ← Back to archive
        </Link>
      </div>
    );
  }
  if (!sermon) {
    return (
      <div className="card text-center space-y-3">
        <h1 className="font-serif text-xl text-umc-900">Sermon not found</h1>
        <Link to="/" className="btn-secondary inline-block">
          ← Back to archive
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        to="/"
        className="inline-block text-sm text-gray-500 hover:text-gray-700"
      >
        ← All sermons
      </Link>

      {/* Header / metadata */}
      <div className="card space-y-4">
        {editing ? (
          <div className="space-y-3">
            <div>
              <label className="label">Title</label>
              <input
                type="text"
                className="input"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder='e.g., "Walking with Jesus"'
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="label">Scripture reference</label>
                <input
                  type="text"
                  className="input"
                  value={draft.scripture_reference}
                  onChange={(e) =>
                    setDraft({ ...draft, scripture_reference: e.target.value })
                  }
                  placeholder="e.g., John 3:16-21"
                />
              </div>
              <div>
                <label className="label">Theme</label>
                <input
                  type="text"
                  className="input"
                  value={draft.theme}
                  onChange={(e) => setDraft({ ...draft, theme: e.target.value })}
                  placeholder="e.g., Easter, Lent, Stewardship"
                />
              </div>
            </div>
            <div>
              <label className="label">Date first preached</label>
              <input
                type="date"
                className="input"
                value={draft.preached_at}
                onChange={(e) =>
                  setDraft({ ...draft, preached_at: e.target.value })
                }
              />
            </div>
            <div>
              <label className="label">Private notes</label>
              <textarea
                className="input min-h-[100px]"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                placeholder="Personal notes — not shown in any bulletin. e.g., what worked, what to revise, audience response."
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={saveEdit}
                disabled={saving}
                className="btn-primary disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="font-serif text-2xl text-umc-900">
                  {sermon.title || (
                    <span className="italic text-gray-400">Untitled sermon</span>
                  )}
                </h1>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600">
                  {sermon.scripture_reference && (
                    <span>{sermon.scripture_reference}</span>
                  )}
                  {sermon.theme && (
                    <span className="italic">{sermon.theme}</span>
                  )}
                  {sermon.preached_at && (
                    <span>{fmtDate(sermon.preached_at)}</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={startEdit}
                className="btn-secondary text-sm whitespace-nowrap"
              >
                Edit metadata
              </button>
            </div>
            {sermon.notes && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                  Private notes
                </p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">
                  {sermon.notes}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Where preached */}
      {preachedAt.length > 0 && (
        <div className="card">
          <h2 className="font-serif text-lg text-umc-900">Preached at</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {preachedAt.map((b) => (
              <li
                key={b.id}
                className="flex items-center justify-between text-gray-700"
              >
                <span>{fmtDate(b.service_date)}</span>
                <span className="text-xs text-gray-500">
                  {b.sunday_designation || ''}{' '}
                  {b.status !== 'published' && (
                    <span className="ml-1 px-1 py-0.5 text-[10px] uppercase tracking-wide rounded bg-gray-100 text-gray-500">
                      {b.status}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-400 mt-3">
            A sermon can be preached more than once — re-using the same
            sermon_id at a future church links it back here.
          </p>
        </div>
      )}

      {/* Manuscript */}
      <div className="card">
        <h2 className="font-serif text-lg text-umc-900">Manuscript</h2>
        {sermon.manuscript_text ? (
          <p className="mt-3 text-base text-gray-800 whitespace-pre-wrap font-serif leading-relaxed">
            {sermon.manuscript_text}
          </p>
        ) : (
          <p className="mt-3 text-sm text-gray-400 italic">
            No manuscript text saved for this sermon.
          </p>
        )}
        <p className="text-xs text-gray-400 mt-4 pt-3 border-t border-gray-100">
          The manuscript text is canonical and lives with the original
          bulletin entry — edit it from the bulletin app's Order of Worship,
          not here.
        </p>
      </div>
    </div>
  );
}
