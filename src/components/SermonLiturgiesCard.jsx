import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext.jsx';
import {
  findLiturgiesByTitle,
  findLiturgiesByScripture,
} from '../lib/liturgyMatch';
import SendToBulletinModal from './SendToBulletinModal.jsx';
import TypeaheadSearch from './TypeaheadSearch.jsx';

// Panel on SermonDetail showing all liturgies linked to this sermon
// (approved links only) + tools to find more (typeahead search and
// on-demand title/scripture matchers). Each liturgy expands to show
// its parsed sections, with announcements hidden by default. Each
// section has a 'Send to bulletin' link.
export default function SermonLiturgiesCard({ sermon }) {
  const sermonId = sermon?.id;
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [liturgies, setLiturgies] = useState([]); // [{ liturgy, sections }]
  const [sendModalSection, setSendModalSection] = useState(null);
  const [titleSuggestions, setTitleSuggestions] = useState(null);
  const [scriptureSuggestions, setScriptureSuggestions] = useState(null);
  const [searchingMatches, setSearchingMatches] = useState(false);

  const reload = async () => {
    if (!sermonId) return;
    setLoading(true);
    setError(null);
    try {
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
      const liturgyRows = (linkRows ?? [])
        .map((l) => l.liturgy)
        .filter(Boolean);
      if (liturgyRows.length === 0) {
        setLiturgies([]);
        return;
      }
      const liturgyIds = liturgyRows.map((l) => l.id);
      const { data: secRows, error: secErr } = await withTimeout(
        supabase
          .from('sermon_liturgy_sections')
          .select('*')
          .in('liturgy_id', liturgyIds)
          .order('sort_order', { ascending: true })
      );
      if (secErr) throw secErr;
      const sectionsByLiturgy = {};
      for (const s of secRows ?? []) {
        if (!sectionsByLiturgy[s.liturgy_id])
          sectionsByLiturgy[s.liturgy_id] = [];
        sectionsByLiturgy[s.liturgy_id].push(s);
      }
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
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sermonId]);

  // Manual link via typeahead pick — always 'manual' / 'high' / approved.
  const handlePickLiturgy = async (liturgy) => {
    if (!liturgy?.id) return;
    setError(null);
    try {
      const { error: err } = await withTimeout(
        supabase.from('sermon_liturgy_links').insert({
          liturgy_id: liturgy.id,
          sermon_id: sermonId,
          owner_user_id: user.id,
          link_kind: 'manual',
          confidence: 'high',
          approved: true,
        })
      );
      if (err) throw err;
      setTitleSuggestions((prev) =>
        prev ? prev.filter((m) => m.liturgy_id !== liturgy.id) : prev
      );
      setScriptureSuggestions((prev) =>
        prev ? prev.filter((m) => m.liturgy_id !== liturgy.id) : prev
      );
      await reload();
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  // On-demand: find liturgies by title token overlap.
  const findByTitle = async () => {
    setError(null);
    setSearchingMatches(true);
    try {
      const tokens = (sermon?.title || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 4)
        .sort((a, b) => b.length - a.length)
        .slice(0, 4);
      if (tokens.length === 0) {
        setTitleSuggestions([]);
        return;
      }
      const orClause = tokens
        .map((t) => `title.ilike.%${t.replace(/[%_]/g, '')}%`)
        .join(',');
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermon_liturgies')
          .select('id, title, used_at, used_location, scripture_refs')
          .eq('owner_user_id', user.id)
          .or(orClause)
          .limit(100)
      );
      if (err) throw err;
      const linkedIds = new Set(liturgies.map((x) => x.liturgy.id));
      const candidates = findLiturgiesByTitle(sermon, data || [])
        .filter((c) => !linkedIds.has(c.liturgy_id))
        .slice(0, 25);
      const byId = Object.fromEntries((data || []).map((l) => [l.id, l]));
      setTitleSuggestions(
        candidates.map((c) => ({ ...c, liturgy: byId[c.liturgy_id] }))
      );
    } catch (e) {
      setError(e.message || String(e));
      setTitleSuggestions([]);
    } finally {
      setSearchingMatches(false);
    }
  };

  // On-demand: find liturgies by scripture overlap.
  const findByScripture = async () => {
    setError(null);
    setSearchingMatches(true);
    try {
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermon_liturgies')
          .select('id, title, used_at, used_location, scripture_refs')
          .eq('owner_user_id', user.id)
          .limit(2000)
      );
      if (err) throw err;
      const linkedIds = new Set(liturgies.map((x) => x.liturgy.id));
      const candidates = findLiturgiesByScripture(sermon, data || [])
        .filter((c) => !linkedIds.has(c.liturgy_id))
        .slice(0, 25);
      const byId = Object.fromEntries((data || []).map((l) => [l.id, l]));
      setScriptureSuggestions(
        candidates.map((c) => ({ ...c, liturgy: byId[c.liturgy_id] }))
      );
    } catch (e) {
      setError(e.message || String(e));
      setScriptureSuggestions([]);
    } finally {
      setSearchingMatches(false);
    }
  };

  const linkedLiturgyIds = new Set(liturgies.map((x) => x.liturgy.id));

  // Always render the card so the find/search controls are accessible
  // even if no liturgies are currently linked.

  return (
    <div className="card space-y-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <h2 className="font-serif text-lg text-umc-900">
          Linked liturgies
          {!loading && liturgies.length > 0 && (
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({liturgies.length})
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={findByTitle}
            disabled={searchingMatches}
            className="text-umc-700 hover:text-umc-900 underline disabled:opacity-50"
          >
            Find by title
          </button>
          <span className="text-gray-300">·</span>
          <button
            type="button"
            onClick={findByScripture}
            disabled={searchingMatches}
            className="text-umc-700 hover:text-umc-900 underline disabled:opacity-50"
          >
            Find by scripture
          </button>
        </div>
      </div>

      {/* Typeahead picker */}
      <div>
        <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
          Add a liturgy by typing
        </label>
        <TypeaheadSearch
          table="sermon_liturgies"
          selectColumns="id, title, scripture_refs, used_at, used_location"
          searchColumns="title,scripture_refs"
          labelFor={(r) => r.title || '(untitled)'}
          subLabelFor={(r) =>
            [r.used_at, r.used_location, r.scripture_refs]
              .filter(Boolean)
              .join(' · ')
          }
          excludeIds={linkedLiturgyIds}
          onPick={handlePickLiturgy}
          placeholder="Type a liturgy title or scripture…"
        />
      </div>

      {/* On-demand suggestion panels */}
      <SuggestionPanel
        label="By title"
        suggestions={titleSuggestions}
        onPick={handlePickLiturgy}
      />
      <SuggestionPanel
        label="By scripture"
        suggestions={scriptureSuggestions}
        onPick={handlePickLiturgy}
      />

      {loading ? (
        <p className="text-xs text-gray-500 italic">Loading…</p>
      ) : error ? (
        <p className="text-sm text-red-700">{error}</p>
      ) : liturgies.length === 0 ? (
        <p className="text-sm text-gray-500 italic">
          No liturgies linked yet — use the search or find buttons above.
        </p>
      ) : (
        <div className="space-y-3">
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

// Inline suggestion panel for "Find by title" / "Find by scripture".
// Mirrors the one on LiturgyDetail but for the reverse direction.
function SuggestionPanel({ label, suggestions, onPick }) {
  if (suggestions === null) return null;
  return (
    <div className="border border-gray-200 rounded p-2 bg-gray-50">
      <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
        Suggestions — {label} ({suggestions.length})
      </p>
      {suggestions.length === 0 ? (
        <p className="text-xs text-gray-500 italic">No matches found.</p>
      ) : (
        <ul className="space-y-1">
          {suggestions.map((m) => (
            <li
              key={m.liturgy_id}
              className="flex items-baseline justify-between gap-2 py-0.5"
            >
              <div className="min-w-0 flex-1">
                <span
                  className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded mr-2 ${
                    m.confidence === 'high'
                      ? 'bg-green-100 text-green-800'
                      : m.confidence === 'medium'
                        ? 'bg-blue-100 text-blue-800'
                        : 'bg-gray-200 text-gray-700'
                  }`}
                >
                  {m.confidence}
                </span>
                <span className="text-sm text-umc-900 truncate">
                  {m.liturgy?.title || '(untitled)'}
                </span>
                {(m.liturgy?.used_at || m.liturgy?.used_location) && (
                  <span className="ml-2 text-xs text-gray-500">
                    {[m.liturgy.used_at, m.liturgy.used_location]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
                {m.why && (
                  <span className="ml-2 text-[11px] text-gray-500 italic">
                    · {m.why}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => onPick(m.liturgy)}
                className="text-xs text-umc-700 hover:text-umc-900 underline shrink-0"
              >
                Link
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
