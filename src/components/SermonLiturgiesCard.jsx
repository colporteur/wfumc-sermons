import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import SendToBulletinModal from './SendToBulletinModal.jsx';

// Panel on SermonDetail showing all liturgies linked to this sermon
// (approved links only). Each liturgy expands to show its parsed
// sections, with announcements hidden by default. Each section has a
// 'Send to bulletin' link that opens SendToBulletinModal.
export default function SermonLiturgiesCard({ sermonId }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [liturgies, setLiturgies] = useState([]); // [{ liturgy, sections }]
  const [sendModalSection, setSendModalSection] = useState(null);

  useEffect(() => {
    if (!sermonId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // Step 1: pull approved links + their parent liturgies.
        const { data: linkRows, error: linkErr } = await withTimeout(
          supabase
            .from('sermon_liturgy_links')
            .select(
              'liturgy_id, link_kind, confidence, liturgy:sermon_liturgies(id, title, used_at, used_location, original_created_at)'
            )
            .eq('sermon_id', sermonId)
            .eq('approved', true)
        );
        if (linkErr) throw linkErr;
        if (cancelled) return;

        const liturgyRows = (linkRows ?? [])
          .map((l) => l.liturgy)
          .filter(Boolean);
        if (liturgyRows.length === 0) {
          setLiturgies([]);
          return;
        }

        // Step 2: pull sections for those liturgies.
        const liturgyIds = liturgyRows.map((l) => l.id);
        const { data: secRows, error: secErr } = await withTimeout(
          supabase
            .from('sermon_liturgy_sections')
            .select('*')
            .in('liturgy_id', liturgyIds)
            .order('sort_order', { ascending: true })
        );
        if (secErr) throw secErr;
        if (cancelled) return;

        const sectionsByLiturgy = {};
        for (const s of secRows ?? []) {
          if (!sectionsByLiturgy[s.liturgy_id])
            sectionsByLiturgy[s.liturgy_id] = [];
          sectionsByLiturgy[s.liturgy_id].push(s);
        }

        // Sort liturgies by used_at desc (or original_created_at) so the
        // most recent appears first.
        const ordered = liturgyRows
          .slice()
          .sort((a, b) => {
            const ad = a.used_at || a.original_created_at?.slice(0, 10) || '';
            const bd = b.used_at || b.original_created_at?.slice(0, 10) || '';
            return bd.localeCompare(ad);
          })
          .map((l) => ({
            liturgy: l,
            sections: sectionsByLiturgy[l.id] || [],
          }));
        setLiturgies(ordered);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sermonId]);

  // Don't render if there's nothing to show + nothing wrong + not loading.
  if (!loading && liturgies.length === 0 && !error) return null;

  return (
    <div className="card">
      <h2 className="font-serif text-lg text-umc-900">
        Linked liturgies
        {!loading && liturgies.length > 0 && (
          <span className="ml-2 text-sm font-normal text-gray-500">
            ({liturgies.length})
          </span>
        )}
      </h2>
      {loading ? (
        <p className="mt-2 text-xs text-gray-500 italic">Loading…</p>
      ) : error ? (
        <p className="mt-2 text-sm text-red-700">{error}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {liturgies.map(({ liturgy, sections }) => (
            <LiturgyEntry
              key={liturgy.id}
              liturgy={liturgy}
              sections={sections}
              onSend={(s) => setSendModalSection(s)}
            />
          ))}
        </div>
      )}
      {sendModalSection && (
        <SendToBulletinModal
          section={sendModalSection}
          onClose={() => setSendModalSection(null)}
        />
      )}
    </div>
  );
}

function LiturgyEntry({ liturgy, sections, onSend }) {
  const [expanded, setExpanded] = useState(false);
  const [showAnnouncements, setShowAnnouncements] = useState(false);
  const visible = sections.filter(
    (s) => showAnnouncements || !s.is_announcement
  );
  const announcementCount = sections.filter((s) => s.is_announcement).length;
  const date =
    liturgy.used_at ||
    (liturgy.original_created_at
      ? liturgy.original_created_at.slice(0, 10)
      : null);

  return (
    <div className="border border-gray-200 rounded">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full text-left px-3 py-2 flex items-baseline justify-between gap-2 hover:bg-gray-50"
      >
        <span className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm font-medium text-umc-900 truncate">
            {liturgy.title || '(untitled)'}
          </span>
          {date && (
            <span className="text-xs text-gray-500">{date}</span>
          )}
          {liturgy.used_location && (
            <span className="text-xs text-gray-500">
              · {liturgy.used_location}
            </span>
          )}
          <span className="text-xs text-gray-400">
            · {sections.length} section{sections.length === 1 ? '' : 's'}
          </span>
        </span>
        <span className="text-xs text-umc-700 shrink-0">
          {expanded ? '▼' : '▶'}{' '}
          <Link
            to={`/liturgies/${liturgy.id}`}
            onClick={(e) => e.stopPropagation()}
            className="hover:text-umc-900 underline"
          >
            Open
          </Link>
        </span>
      </button>
      {expanded && (
        <div className="px-3 py-2 border-t border-gray-100 space-y-3">
          {sections.length === 0 ? (
            <p className="text-xs text-gray-500 italic">
              Not parsed into sections — open the liturgy to parse with
              Claude.
            </p>
          ) : (
            <>
              {visible.map((s) => (
                <div key={s.id} className="border-l-2 border-umc-200 pl-3">
                  <div className="flex items-baseline justify-between gap-2 flex-wrap">
                    <p className="text-sm font-medium text-umc-900">
                      <span className="text-[10px] uppercase tracking-wide text-gray-500 mr-2">
                        {s.section_kind}
                      </span>
                      {s.title || ''}
                    </p>
                    <button
                      type="button"
                      onClick={() => onSend(s)}
                      className="text-xs text-umc-700 hover:text-umc-900 underline whitespace-nowrap"
                    >
                      → Send to bulletin
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-gray-700 whitespace-pre-wrap font-serif line-clamp-6">
                    {s.body}
                  </p>
                </div>
              ))}
              {announcementCount > 0 && (
                <label className="text-[11px] text-gray-600 flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={showAnnouncements}
                    onChange={(e) => setShowAnnouncements(e.target.checked)}
                  />
                  Show {announcementCount} announcement section
                  {announcementCount === 1 ? '' : 's'}
                </label>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
