import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { parseLiturgyIntoSections } from '../lib/claude';
import { matchLiturgyToSermons } from '../lib/liturgyMatch';
import SendToBulletinModal from '../components/SendToBulletinModal.jsx';

export default function LiturgyDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [liturgy, setLiturgy] = useState(null);
  const [sections, setSections] = useState([]);
  const [links, setLinks] = useState([]); // sermon link rows + sermon info
  const [showAnnouncements, setShowAnnouncements] = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  const [draft, setDraft] = useState({ title: '', used_at: '', used_location: '', notes: '' });
  const [busy, setBusy] = useState(false);
  const [reparsing, setReparsing] = useState(false);
  const [linkingSermon, setLinkingSermon] = useState(false);
  const [allSermons, setAllSermons] = useState([]);
  const [sermonPick, setSermonPick] = useState('');
  const [sendModal, setSendModal] = useState(null); // section being sent

  const reload = async () => {
    if (!user?.id || !id) return;
    setLoading(true);
    setError(null);
    try {
      const [litRes, secRes, linkRes, sermonRes] = await Promise.all([
        withTimeout(
          supabase
            .from('sermon_liturgies')
            .select('*')
            .eq('id', id)
            .maybeSingle()
        ),
        withTimeout(
          supabase
            .from('sermon_liturgy_sections')
            .select('*')
            .eq('liturgy_id', id)
            .order('sort_order', { ascending: true })
        ),
        withTimeout(
          supabase
            .from('sermon_liturgy_links')
            .select('*, sermon:sermons(id, title, scripture_reference, preached_at)')
            .eq('liturgy_id', id)
            .order('approved', { ascending: false })
        ),
        withTimeout(
          supabase
            .from('sermons')
            .select('id, title, scripture_reference')
            .eq('owner_user_id', user.id)
            .order('title', { ascending: true })
        ),
      ]);
      if (litRes.error) throw litRes.error;
      if (secRes.error) throw secRes.error;
      if (linkRes.error) throw linkRes.error;
      if (sermonRes.error) throw sermonRes.error;
      if (!litRes.data) {
        setError('Liturgy not found.');
        return;
      }
      setLiturgy(litRes.data);
      setSections(secRes.data ?? []);
      setLinks(linkRes.data ?? []);
      setAllSermons(sermonRes.data ?? []);
      setDraft({
        title: litRes.data.title || '',
        used_at: litRes.data.used_at || '',
        used_location: litRes.data.used_location || '',
        notes: litRes.data.notes || '',
      });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user?.id]);

  if (loading) return <LoadingSpinner label="Loading liturgy…" />;
  if (error)
    return (
      <div className="space-y-4">
        <Link
          to="/liturgies"
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          ← Back to liturgies
        </Link>
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      </div>
    );
  if (!liturgy) return null;

  // ---- Actions ----

  const saveMeta = async () => {
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await withTimeout(
        supabase
          .from('sermon_liturgies')
          .update({
            title: draft.title.trim() || liturgy.title,
            used_at: draft.used_at || null,
            used_location: draft.used_location.trim() || null,
            notes: draft.notes.trim() || null,
          })
          .eq('id', liturgy.id)
      );
      if (err) throw err;
      setEditingMeta(false);
      await reload();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeLiturgy = async () => {
    if (!window.confirm('Delete this liturgy and all its sections + links?')) return;
    setBusy(true);
    try {
      const { error: err } = await withTimeout(
        supabase.from('sermon_liturgies').delete().eq('id', liturgy.id)
      );
      if (err) throw err;
      navigate('/liturgies');
    } catch (e) {
      setError(e.message || String(e));
      setBusy(false);
    }
  };

  const reparse = async () => {
    if (!liturgy.raw_body?.trim()) {
      setError('No raw body to re-parse.');
      return;
    }
    if (
      sections.length > 0 &&
      !window.confirm(
        `Re-parse will delete the existing ${sections.length} sections and create new ones. Continue?`
      )
    ) {
      return;
    }
    setReparsing(true);
    setError(null);
    try {
      const newSections = await parseLiturgyIntoSections({
        liturgyTitle: liturgy.title,
        liturgyBody: liturgy.raw_body,
      });
      // Replace: delete then insert
      const { error: delErr } = await withTimeout(
        supabase
          .from('sermon_liturgy_sections')
          .delete()
          .eq('liturgy_id', liturgy.id)
      );
      if (delErr) throw delErr;
      if (newSections.length > 0) {
        const { error: insErr } = await withTimeout(
          supabase.from('sermon_liturgy_sections').insert(
            newSections.map((s) => ({
              liturgy_id: liturgy.id,
              owner_user_id: user.id,
              section_kind: s.section_kind,
              title: s.title,
              body: s.body,
              sort_order: s.sort_order,
              is_announcement: s.is_announcement,
            }))
          )
        );
        if (insErr) throw insErr;
      }
      await reload();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setReparsing(false);
    }
  };

  const reRunMatch = async () => {
    setBusy(true);
    setError(null);
    try {
      const matches = matchLiturgyToSermons(liturgy, allSermons);
      const existingIds = new Set(links.map((l) => l.sermon_id));
      const fresh = matches.filter((m) => !existingIds.has(m.sermon_id));
      if (fresh.length === 0) {
        setError('No new matches found.');
        return;
      }
      const { error: err } = await withTimeout(
        supabase.from('sermon_liturgy_links').insert(
          fresh.map((m) => ({
            liturgy_id: liturgy.id,
            sermon_id: m.sermon_id,
            owner_user_id: user.id,
            link_kind: m.link_kind,
            confidence: m.confidence,
            approved: m.approved,
          }))
        )
      );
      if (err) throw err;
      await reload();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleAddManualLink = async () => {
    if (!sermonPick) return;
    setLinkingSermon(true);
    setError(null);
    try {
      const { error: err } = await withTimeout(
        supabase.from('sermon_liturgy_links').insert({
          liturgy_id: liturgy.id,
          sermon_id: sermonPick,
          owner_user_id: user.id,
          link_kind: 'manual',
          confidence: 'high',
          approved: true,
        })
      );
      if (err) throw err;
      setSermonPick('');
      await reload();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLinkingSermon(false);
    }
  };

  const handleApproveLink = async (linkId) => {
    const { error: err } = await withTimeout(
      supabase
        .from('sermon_liturgy_links')
        .update({ approved: true })
        .eq('id', linkId)
    );
    if (err) {
      setError(err.message);
      return;
    }
    await reload();
  };

  const handleRemoveLink = async (linkId) => {
    const { error: err } = await withTimeout(
      supabase.from('sermon_liturgy_links').delete().eq('id', linkId)
    );
    if (err) {
      setError(err.message);
      return;
    }
    await reload();
  };

  const visibleSections = sections.filter(
    (s) => showAnnouncements || !s.is_announcement
  );
  const hiddenAnnouncementCount = sections.filter((s) => s.is_announcement)
    .length;
  const linkedSermonIds = new Set(links.map((l) => l.sermon_id));
  const pickableSermons = allSermons.filter((s) => !linkedSermonIds.has(s.id));

  // ---- Render ----

  return (
    <div className="space-y-6">
      <Link
        to="/liturgies"
        className="inline-block text-sm text-gray-500 hover:text-gray-700"
      >
        ← All liturgies
      </Link>

      <div className="card space-y-3">
        {editingMeta ? (
          <div className="space-y-2">
            <div>
              <label className="label">Title</label>
              <input
                type="text"
                className="input"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="label">Used at (date)</label>
                <input
                  type="date"
                  className="input"
                  value={draft.used_at}
                  onChange={(e) =>
                    setDraft({ ...draft, used_at: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="label">Used at (location)</label>
                <input
                  type="text"
                  className="input"
                  value={draft.used_location}
                  onChange={(e) =>
                    setDraft({ ...draft, used_location: e.target.value })
                  }
                  placeholder="Grace, Epworth, Wedowee, etc."
                />
              </div>
            </div>
            <div>
              <label className="label">Notes</label>
              <textarea
                className="input min-h-[60px]"
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={saveMeta}
                disabled={busy}
                className="btn-primary disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setEditingMeta(false)}
                className="btn-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h1 className="text-2xl font-serif text-umc-900">
                  {liturgy.title || '(untitled)'}
                </h1>
                <p className="text-xs text-gray-500 mt-0.5">
                  {liturgy.used_at && <span>{liturgy.used_at}</span>}
                  {liturgy.used_location && (
                    <span> · {liturgy.used_location}</span>
                  )}
                  {liturgy.original_created_at && !liturgy.used_at && (
                    <span>
                      Imported from{' '}
                      {liturgy.original_created_at.slice(0, 10)}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditingMeta(true)}
                  className="btn-secondary text-sm"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={removeLiturgy}
                  disabled={busy}
                  className="text-sm text-red-600 hover:text-red-800 underline disabled:opacity-50"
                >
                  Delete
                </button>
              </div>
            </div>
            {liturgy.notes && (
              <p className="text-sm text-gray-700 italic">{liturgy.notes}</p>
            )}
          </>
        )}
      </div>

      {/* Linked sermons */}
      <div className="card">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="font-serif text-lg text-umc-900">Linked sermons</h2>
          {pickableSermons.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                value={sermonPick}
                onChange={(e) => setSermonPick(e.target.value)}
                className="input text-sm w-auto"
              >
                <option value="">Pick a sermon…</option>
                {pickableSermons.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title || '(untitled)'}
                    {s.scripture_reference ? ` — ${s.scripture_reference}` : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleAddManualLink}
                disabled={!sermonPick || linkingSermon}
                className="btn-secondary text-sm disabled:opacity-50"
              >
                + Link
              </button>
              <button
                type="button"
                onClick={reRunMatch}
                disabled={busy}
                className="text-xs text-umc-700 hover:text-umc-900 underline disabled:opacity-50"
                title="Re-run the auto-matcher to find any additional matches"
              >
                ↻ Auto-match
              </button>
            </div>
          )}
        </div>
        {links.length === 0 ? (
          <p className="text-sm text-gray-500 italic mt-2">
            Not linked to any sermons.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {links.map((l) => (
              <li
                key={l.id}
                className="flex items-baseline justify-between gap-3 border-t border-gray-100 pt-2"
              >
                <div className="min-w-0">
                  <Link
                    to={`/sermons/${l.sermon_id}`}
                    className="text-sm text-umc-700 hover:text-umc-900 underline"
                  >
                    {l.sermon?.title || '(untitled sermon)'}
                  </Link>
                  {l.sermon?.scripture_reference && (
                    <span className="ml-2 text-xs text-gray-500">
                      {l.sermon.scripture_reference}
                    </span>
                  )}
                  <p className="text-[10px] uppercase tracking-wide text-gray-500 mt-0.5">
                    {l.link_kind} · {l.confidence}
                    {!l.approved && ' · pending'}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  {!l.approved && (
                    <button
                      type="button"
                      onClick={() => handleApproveLink(l.id)}
                      className="text-xs text-umc-700 hover:text-umc-900 underline"
                    >
                      Approve
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRemoveLink(l.id)}
                    className="text-xs text-red-600 hover:text-red-800 underline"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Sections */}
      <div className="card">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <h2 className="font-serif text-lg text-umc-900">
            Sections ({sections.length})
          </h2>
          <div className="flex items-center gap-3 text-xs">
            {hiddenAnnouncementCount > 0 && (
              <label className="text-gray-700 flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={showAnnouncements}
                  onChange={(e) => setShowAnnouncements(e.target.checked)}
                />
                Show {hiddenAnnouncementCount} announcement section
                {hiddenAnnouncementCount === 1 ? '' : 's'}
              </label>
            )}
            <button
              type="button"
              onClick={reparse}
              disabled={reparsing}
              className="text-umc-700 hover:text-umc-900 underline disabled:opacity-50"
            >
              {reparsing
                ? 'Re-parsing…'
                : sections.length === 0
                  ? '✨ Parse with Claude'
                  : '✨ Re-parse'}
            </button>
          </div>
        </div>
        {visibleSections.length === 0 ? (
          <p className="text-sm text-gray-500 italic mt-2">
            {sections.length === 0
              ? "Not parsed into sections yet — click 'Parse with Claude' above."
              : 'All sections are flagged as announcements (hidden by default).'}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {visibleSections.map((s) => (
              <li key={s.id} className="border-t border-gray-100 pt-3">
                <div className="flex items-baseline justify-between gap-2 flex-wrap">
                  <p className="font-serif text-base text-umc-900">
                    <span className="text-[10px] uppercase tracking-wide text-gray-500 mr-2">
                      {s.section_kind}
                    </span>
                    {s.title || ''}
                  </p>
                  <button
                    type="button"
                    onClick={() => setSendModal(s)}
                    className="text-xs text-umc-700 hover:text-umc-900 underline whitespace-nowrap"
                    title="Send this section to a draft or upcoming bulletin"
                  >
                    → Send to bulletin
                  </button>
                </div>
                <p className="mt-1 text-sm text-gray-800 whitespace-pre-wrap font-serif leading-relaxed">
                  {s.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Raw body */}
      {liturgy.raw_body && (
        <details className="card">
          <summary className="text-sm text-gray-700 cursor-pointer">
            Raw body (as imported)
          </summary>
          <pre className="mt-3 text-xs whitespace-pre-wrap font-mono bg-gray-50 border border-gray-200 rounded p-3">
            {liturgy.raw_body}
          </pre>
        </details>
      )}

      {sendModal && (
        <SendToBulletinModal
          section={sendModal}
          onClose={() => setSendModal(null)}
        />
      )}
    </div>
  );
}
