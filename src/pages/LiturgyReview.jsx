import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';

// Inbox of pending sermon-liturgy link suggestions (approved=false).
// One row per suggestion, with approve / reject buttons. Rejected
// suggestions delete the link entirely (so the same match doesn't
// re-appear if the matcher is re-run later).
export default function LiturgyReview() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState([]);
  const [busyIds, setBusyIds] = useState(new Set());

  const reload = async () => {
    if (!user?.id) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermon_liturgy_links')
          .select(
            '*, liturgy:sermon_liturgies(id, title, used_at, used_location), sermon:sermons(id, title, scripture_reference)'
          )
          .eq('approved', false)
          .order('confidence', { ascending: false })
          .order('created_at', { ascending: false })
      );
      if (err) throw err;
      setPending(data ?? []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const setBusy = (id, on) =>
    setBusyIds((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const approve = async (link) => {
    setBusy(link.id, true);
    try {
      const { error: err } = await withTimeout(
        supabase
          .from('sermon_liturgy_links')
          .update({ approved: true })
          .eq('id', link.id)
      );
      if (err) throw err;
      setPending((prev) => prev.filter((p) => p.id !== link.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(link.id, false);
    }
  };

  const reject = async (link) => {
    setBusy(link.id, true);
    try {
      const { error: err } = await withTimeout(
        supabase.from('sermon_liturgy_links').delete().eq('id', link.id)
      );
      if (err) throw err;
      setPending((prev) => prev.filter((p) => p.id !== link.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(link.id, false);
    }
  };

  // Bulk reject — used to clear out the medium/low pile that older
  // imports created before we tightened auto-link to high-confidence only.
  const bulkReject = async (filter) => {
    const matching = pending.filter(filter);
    if (matching.length === 0) return;
    if (
      !window.confirm(
        `Reject ${matching.length} pending link${matching.length === 1 ? '' : 's'}? They'll be deleted.`
      )
    ) {
      return;
    }
    try {
      const ids = matching.map((p) => p.id);
      const { error: err } = await withTimeout(
        supabase.from('sermon_liturgy_links').delete().in('id', ids)
      );
      if (err) throw err;
      setPending((prev) => prev.filter((p) => !ids.includes(p.id)));
    } catch (e) {
      setError(e.message);
    }
  };

  const mediumCount = pending.filter((p) => p.confidence === 'medium').length;
  const lowCount = pending.filter((p) => p.confidence === 'low').length;

  if (loading) return <LoadingSpinner label="Loading review queue…" />;

  return (
    <div className="space-y-4">
      <Link
        to="/liturgies"
        className="text-sm text-gray-500 hover:text-gray-700 inline-block"
      >
        ← All liturgies
      </Link>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-serif text-umc-900">
            Review pending links
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Auto-matcher suggestions waiting for your approval. Approve to
            make the link real; reject to drop it.
          </p>
        </div>
        {pending.length > 0 && (
          <div className="flex flex-wrap gap-2 text-xs">
            {lowCount > 0 && (
              <button
                type="button"
                onClick={() => bulkReject((p) => p.confidence === 'low')}
                className="btn-secondary text-xs"
              >
                Reject all low ({lowCount})
              </button>
            )}
            {mediumCount > 0 && (
              <button
                type="button"
                onClick={() => bulkReject((p) => p.confidence === 'medium')}
                className="btn-secondary text-xs"
              >
                Reject all medium ({mediumCount})
              </button>
            )}
            <button
              type="button"
              onClick={() => bulkReject(() => true)}
              className="text-xs text-red-600 hover:text-red-800 underline"
            >
              Reject all ({pending.length})
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      {pending.length === 0 ? (
        <p className="card text-center text-sm text-gray-500 py-10">
          Nothing to review — all links are confirmed.
        </p>
      ) : (
        <ul className="space-y-2">
          {pending.map((p) => {
            const busy = busyIds.has(p.id);
            return (
              <li
                key={p.id}
                className="card flex flex-wrap items-start justify-between gap-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <Link
                      to={`/liturgies/${p.liturgy?.id}`}
                      className="text-umc-700 hover:text-umc-900 underline font-medium"
                    >
                      {p.liturgy?.title || '(liturgy)'}
                    </Link>
                    <span className="mx-2 text-gray-400">↔</span>
                    <Link
                      to={`/sermons/${p.sermon?.id}`}
                      className="text-umc-700 hover:text-umc-900 underline"
                    >
                      {p.sermon?.title || '(sermon)'}
                    </Link>
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    Match: <span className="capitalize">{p.link_kind.replace('_', ' ')}</span>
                    {' · '}
                    Confidence: <span className="capitalize">{p.confidence}</span>
                    {p.sermon?.scripture_reference && (
                      <span> · Sermon scripture: {p.sermon.scripture_reference}</span>
                    )}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => approve(p)}
                    disabled={busy}
                    className="btn-primary text-sm disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() => reject(p)}
                    disabled={busy}
                    className="btn-secondary text-sm disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
