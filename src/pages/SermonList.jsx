import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import LoadingSpinner from '../components/LoadingSpinner.jsx';

function fmtDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  return new Date(yyyymmdd + 'T00:00:00').toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function SermonList() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sermons, setSermons] = useState([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error: err } = await withTimeout(
          supabase
            .from('sermons')
            .select('*')
            .order('preached_at', { ascending: false, nullsFirst: false })
            .order('created_at', { ascending: false })
        );
        if (err) throw err;
        if (!cancelled) setSermons(data ?? []);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sermons;
    return sermons.filter((s) => {
      const blob = [
        s.title,
        s.scripture_reference,
        s.theme,
        s.notes,
        s.manuscript_text,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return blob.includes(q);
    });
  }, [sermons, search]);

  if (loading) return <LoadingSpinner label="Loading sermons…" />;
  if (error) {
    return (
      <div className="card text-center space-y-3">
        <p className="text-sm text-red-700">Couldn't load sermons.</p>
        <p className="text-xs text-gray-500">{error}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="btn-primary"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-serif text-umc-900">Sermon Archive</h1>
        <p className="text-sm text-gray-600 mt-1">
          Every sermon you've preached, indexed and searchable. Sermons are
          created automatically when you fill in a sermon item in the
          bulletin app.
        </p>
      </div>

      <div className="card">
        <input
          type="text"
          className="input"
          placeholder="Search by title, scripture, theme, notes, or manuscript text…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <p className="text-xs text-gray-500 mt-2">
          {filtered.length === sermons.length
            ? `${sermons.length} sermon${sermons.length === 1 ? '' : 's'} total`
            : `${filtered.length} of ${sermons.length} matching`}
        </p>
      </div>

      {filtered.length === 0 ? (
        <div className="card text-center text-gray-500">
          {sermons.length === 0
            ? "No sermons in the archive yet. They'll appear here as soon as you fill in a sermon item in the bulletin app."
            : 'No sermons match that search.'}
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((s) => (
            <li key={s.id}>
              <Link
                to={`/sermons/${s.id}`}
                className="card block hover:border-umc-300 hover:shadow-md transition"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      {s.original_sermon_number && (
                        <span className="text-xs text-gray-400 font-mono">
                          #{s.original_sermon_number}
                        </span>
                      )}
                      <h2 className="font-serif text-lg text-umc-900 truncate">
                        {s.title || (
                          <span className="italic text-gray-400">Untitled sermon</span>
                        )}
                      </h2>
                      {s.is_eulogy && (
                        <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded bg-gray-100 text-gray-600">
                          Eulogy
                        </span>
                      )}
                    </div>
                    <div className="text-sm text-gray-600 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                      {s.scripture_reference && (
                        <span>{s.scripture_reference}</span>
                      )}
                      {s.theme && (
                        <span className="italic text-gray-500">{s.theme}</span>
                      )}
                      {s.lectionary_year && (
                        <span className="text-gray-500">
                          {s.lectionary_year}
                        </span>
                      )}
                      {s.preached_at && (
                        <span className="text-gray-500">
                          {fmtDate(s.preached_at)}
                        </span>
                      )}
                      {s.strength != null && (
                        <span className="text-umc-700 font-medium">
                          {s.strength}/10
                        </span>
                      )}
                    </div>
                    {s.manuscript_text ? (
                      <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                        {s.manuscript_text.slice(0, 200)}
                        {s.manuscript_text.length > 200 ? '…' : ''}
                      </p>
                    ) : s.major_stories ? (
                      <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                        {s.major_stories}
                      </p>
                    ) : null}
                  </div>
                  <span className="text-gray-400 mt-1">→</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
