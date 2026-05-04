import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';

// Browse all liturgies. Search by title; filter by linked-sermon status
// (linked / unlinked / pending review).
export default function LiturgyList() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [liturgies, setLiturgies] = useState([]);
  const [linksByLiturgy, setLinksByLiturgy] = useState({});
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | linked | unlinked | pending

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [litRes, linkRes] = await Promise.all([
          withTimeout(
            supabase
              .from('sermon_liturgies')
              .select(
                'id, title, raw_body, used_at, used_location, original_created_at, created_at'
              )
              .order('original_created_at', {
                ascending: false,
                nullsFirst: false,
              })
              .order('created_at', { ascending: false })
          ),
          withTimeout(
            supabase
              .from('sermon_liturgy_links')
              .select('liturgy_id, sermon_id, approved')
          ),
        ]);
        if (litRes.error) throw litRes.error;
        if (linkRes.error) throw linkRes.error;
        if (cancelled) return;
        setLiturgies(litRes.data ?? []);
        const map = {};
        for (const l of linkRes.data ?? []) {
          if (!map[l.liturgy_id]) map[l.liturgy_id] = { approved: 0, pending: 0 };
          if (l.approved) map[l.liturgy_id].approved++;
          else map[l.liturgy_id].pending++;
        }
        setLinksByLiturgy(map);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return liturgies.filter((l) => {
      if (q) {
        const hay = [l.title, l.raw_body, l.used_location]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      const links = linksByLiturgy[l.id] || { approved: 0, pending: 0 };
      if (filter === 'linked' && links.approved === 0) return false;
      if (filter === 'unlinked' && (links.approved > 0 || links.pending > 0))
        return false;
      if (filter === 'pending' && links.pending === 0) return false;
      return true;
    });
  }, [liturgies, linksByLiturgy, search, filter]);

  const totalPending = useMemo(
    () =>
      Object.values(linksByLiturgy).reduce((sum, v) => sum + v.pending, 0),
    [linksByLiturgy]
  );

  if (loading) return <LoadingSpinner label="Loading liturgies…" />;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-serif text-umc-900">Liturgies</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Text-based liturgies imported from Evernote, linked to sermons by
            title or scripture.
          </p>
        </div>
        <div className="flex gap-2">
          {totalPending > 0 && (
            <Link
              to="/liturgies/review"
              className="btn-secondary text-sm whitespace-nowrap"
            >
              Review {totalPending} pending link{totalPending === 1 ? '' : 's'}
            </Link>
          )}
          <Link
            to="/liturgies/import"
            className="btn-primary text-sm whitespace-nowrap"
          >
            + Import .enex
          </Link>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      <div className="card flex flex-wrap items-center gap-3">
        <input
          type="text"
          className="input flex-1 min-w-[200px] text-sm"
          placeholder="Search title or body…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="input w-auto text-sm"
        >
          <option value="all">All ({liturgies.length})</option>
          <option value="linked">Linked to a sermon</option>
          <option value="unlinked">Not linked</option>
          <option value="pending">Has pending link suggestion</option>
        </select>
      </div>

      {filtered.length === 0 ? (
        <p className="card text-center text-sm text-gray-500 py-10">
          {liturgies.length === 0
            ? 'No liturgies yet. Click "Import .enex" to add some.'
            : 'No liturgies match those filters.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((l) => {
            const links = linksByLiturgy[l.id] || { approved: 0, pending: 0 };
            const date =
              l.used_at ||
              (l.original_created_at
                ? l.original_created_at.slice(0, 10)
                : null);
            return (
              <li key={l.id}>
                <Link
                  to={`/liturgies/${l.id}`}
                  className="card block hover:border-umc-700 transition-colors"
                >
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <h2 className="font-serif text-base text-umc-900 truncate">
                      {l.title || '(untitled)'}
                    </h2>
                    <div className="flex items-baseline gap-2 text-xs text-gray-500">
                      {date && <span>{date}</span>}
                      {l.used_location && <span>· {l.used_location}</span>}
                      {links.approved > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-800 uppercase tracking-wide text-[10px]">
                          {links.approved} linked
                        </span>
                      )}
                      {links.pending > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 uppercase tracking-wide text-[10px]">
                          {links.pending} pending
                        </span>
                      )}
                      {links.approved === 0 && links.pending === 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 uppercase tracking-wide text-[10px]">
                          unlinked
                        </span>
                      )}
                    </div>
                  </div>
                  {l.raw_body && (
                    <p className="mt-1 text-xs text-gray-600 line-clamp-2 whitespace-pre-wrap">
                      {l.raw_body.slice(0, 250)}
                    </p>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
