import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { extractResourcesFromManuscript } from '../lib/claude';
import { listMyLibraries } from '../lib/libraries';
import { useDraftStorage } from '../lib/draftStorage';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';

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
  const { user } = useAuth();
  const { id } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [sermon, setSermon] = useState(null);
  // Bulletins this sermon has been preached at (via liturgy_items.sermon_id)
  const [preachedAt, setPreachedAt] = useState([]);
  // Snapshots of prior versions of this sermon (sermon_revisions table)
  const [revisions, setRevisions] = useState([]);
  // Resources linked to this sermon (sermon_resources rows w/ resource joined)
  const [linkedResources, setLinkedResources] = useState([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Persist the metadata edit draft to sessionStorage so accidental
  // navigation doesn't lose changes. Key includes user.id to avoid
  // cross-user contamination on shared machines.
  const draftKey =
    user?.id && id ? `sermon-meta:${user.id}:${id}` : null;
  const [draft, setDraft, hasMetadataDraft, discardMetadataDraft] =
    useDraftStorage(draftKey);
  // True only when the current draft was restored from a previous
  // session — used to show a small banner so the user knows.
  const [draftRestored, setDraftRestored] = useState(false);

  // If the user navigated back to a sermon they were mid-edit on, drop
  // them straight into edit mode with their saved draft loaded.
  useEffect(() => {
    if (sermon && hasMetadataDraft() && !editing) {
      setEditing(true);
      setDraftRestored(true);
    }
    // We intentionally only run this once per sermon load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sermon?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [sermonRes, preachingsRes, revisionsRes, resourcesRes] =
          await Promise.all([
            withTimeout(
              supabase
                .from('sermons')
                .select('*')
                .eq('id', id)
                .eq('owner_user_id', user.id)
                .maybeSingle()
            ),
            withTimeout(
              supabase
                .from('preachings')
                .select(
                  '*, bulletin:bulletins(id, service_date, sunday_designation, status)'
                )
                .eq('sermon_id', id)
                .eq('owner_user_id', user.id)
                .order('preached_at', { ascending: false, nullsFirst: false })
            ),
            withTimeout(
              supabase
                .from('sermon_revisions')
                .select('*')
                .eq('sermon_id', id)
                .eq('owner_user_id', user.id)
                .order('taken_at', { ascending: false })
            ),
            withTimeout(
              supabase
                .from('sermon_resources')
                .select(
                  'id, used_notes, created_at, resource:resources(id, resource_type, title, content, source, themes, tone)'
                )
                .eq('sermon_id', id)
                .eq('owner_user_id', user.id)
                .order('created_at', { ascending: false })
            ),
          ]);
        if (sermonRes.error) throw sermonRes.error;
        if (preachingsRes.error) throw preachingsRes.error;
        if (revisionsRes.error) throw revisionsRes.error;
        if (resourcesRes.error) throw resourcesRes.error;
        if (cancelled) return;
        setSermon(sermonRes.data);
        setPreachedAt(preachingsRes.data ?? []);
        setRevisions(revisionsRes.data ?? []);
        setLinkedResources(resourcesRes.data ?? []);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, user?.id]);

  const startEdit = () => {
    if (!sermon) return;
    setDraft({
      title: sermon.title ?? '',
      scripture_reference: sermon.scripture_reference ?? '',
      theme: sermon.theme ?? '',
      lectionary_year: sermon.lectionary_year ?? '',
      strength: sermon.strength != null ? String(sermon.strength) : '',
      timeless: sermon.timeless ?? '',
      is_eulogy: !!sermon.is_eulogy,
      major_stories: sermon.major_stories ?? '',
      notes: sermon.notes ?? '',
      preached_at: sermon.preached_at ?? '',
    });
    setEditing(true);
    setDraftRestored(false);
  };

  const cancelEdit = () => {
    discardMetadataDraft();
    setEditing(false);
    setDraftRestored(false);
  };

  // Discard a restored draft and re-seed from the saved sermon. Lets
  // the user recover when they don't actually want their old changes.
  const discardRestoredDraft = () => {
    discardMetadataDraft();
    setDraftRestored(false);
    startEdit();
  };

  const saveEdit = async () => {
    setSaving(true);
    setError(null);
    try {
      const strengthNum = draft.strength.trim()
        ? Number(draft.strength)
        : null;
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermons')
          .update({
            title: draft.title.trim() || null,
            scripture_reference: draft.scripture_reference.trim() || null,
            theme: draft.theme.trim() || null,
            lectionary_year: draft.lectionary_year.trim() || null,
            strength:
              strengthNum && !Number.isNaN(strengthNum) && strengthNum >= 1 && strengthNum <= 10
                ? Math.round(strengthNum)
                : null,
            timeless: draft.timeless.trim() || null,
            is_eulogy: !!draft.is_eulogy,
            major_stories: draft.major_stories.trim() || null,
            notes: draft.notes.trim() || null,
            preached_at: draft.preached_at || null,
          })
          .eq('id', id)
          .select()
          .single()
      );
      if (err) throw err;
      setSermon(data);
      discardMetadataDraft();
      setEditing(false);
      setDraftRestored(false);
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
        {editing && draft ? (
          <div className="space-y-3">
            {draftRestored && (
              <div className="border border-amber-300 bg-amber-50 rounded px-3 py-2 flex items-center justify-between gap-3">
                <p className="text-xs text-amber-900">
                  Picked up where you left off — these are unsaved changes
                  from earlier. Save to apply, or discard to start fresh
                  from the saved version.
                </p>
                <button
                  type="button"
                  onClick={discardRestoredDraft}
                  className="text-xs underline text-amber-900 hover:text-amber-700 whitespace-nowrap"
                >
                  Discard changes
                </button>
              </div>
            )}
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="label">Lectionary year</label>
                <input
                  type="text"
                  className="input"
                  value={draft.lectionary_year}
                  onChange={(e) =>
                    setDraft({ ...draft, lectionary_year: e.target.value })
                  }
                  placeholder="e.g., 25C, Ep1C"
                />
              </div>
              <div>
                <label className="label">Strength (1-10)</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  className="input"
                  value={draft.strength}
                  onChange={(e) =>
                    setDraft({ ...draft, strength: e.target.value })
                  }
                />
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
            </div>
            <div>
              <label className="label">Timeless?</label>
              <input
                type="text"
                className="input"
                value={draft.timeless}
                onChange={(e) =>
                  setDraft({ ...draft, timeless: e.target.value })
                }
                placeholder='e.g., "Yes", "No", "Yes, with modification"'
              />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={draft.is_eulogy}
                onChange={(e) =>
                  setDraft({ ...draft, is_eulogy: e.target.checked })
                }
                className="h-4 w-4 rounded border-gray-300 text-umc-700"
              />
              <span className="text-sm text-gray-700">This is a eulogy</span>
            </label>
            <div>
              <label className="label">Major stories / illustrations used</label>
              <textarea
                className="input min-h-[80px]"
                value={draft.major_stories}
                onChange={(e) =>
                  setDraft({ ...draft, major_stories: e.target.value })
                }
                placeholder="Comma-separated list of stories, jokes, or illustrations used in this sermon."
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
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  {sermon.original_sermon_number && (
                    <span className="text-sm text-gray-400 font-mono">
                      #{sermon.original_sermon_number}
                    </span>
                  )}
                  <h1 className="font-serif text-2xl text-umc-900">
                    {sermon.title || (
                      <span className="italic text-gray-400">Untitled sermon</span>
                    )}
                  </h1>
                  {sermon.is_eulogy && (
                    <span className="px-2 py-0.5 text-[10px] uppercase tracking-wide rounded bg-gray-200 text-gray-700">
                      Eulogy
                    </span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600">
                  {sermon.scripture_reference && (
                    <span>{sermon.scripture_reference}</span>
                  )}
                  {sermon.theme && (
                    <span className="italic">{sermon.theme}</span>
                  )}
                  {sermon.lectionary_year && (
                    <span className="text-gray-500">
                      Year: {sermon.lectionary_year}
                    </span>
                  )}
                  {sermon.preached_at && (
                    <span>First preached {fmtDate(sermon.preached_at)}</span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                  {sermon.strength != null && (
                    <span>
                      Strength:{' '}
                      <span className="font-medium text-umc-900">
                        {sermon.strength}/10
                      </span>
                    </span>
                  )}
                  {sermon.timeless && (
                    <span>
                      Timeless?{' '}
                      <span className="font-medium text-gray-700">
                        {sermon.timeless}
                      </span>
                    </span>
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
            {sermon.major_stories && (
              <div className="mt-4 pt-4 border-t border-gray-100">
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                  Major stories / illustrations
                </p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">
                  {sermon.major_stories}
                </p>
              </div>
            )}
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

      {/* Preachings */}
      {preachedAt.length > 0 && (
        <div className="card">
          <h2 className="font-serif text-lg text-umc-900">
            Preached
            <span className="ml-2 text-sm font-normal text-gray-500">
              ({preachedAt.length} time{preachedAt.length === 1 ? '' : 's'})
            </span>
          </h2>
          <ul className="mt-2 divide-y divide-gray-100 text-sm">
            {preachedAt.map((p) => (
              <li
                key={p.id}
                className="py-2 flex items-start justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-gray-700">
                    {p.preached_at ? (
                      fmtDate(p.preached_at)
                    ) : (
                      <span className="italic text-gray-400">
                        Date unknown
                      </span>
                    )}
                    {p.location && (
                      <span className="text-gray-500 ml-2">— {p.location}</span>
                    )}
                  </div>
                  {p.title_used && p.title_used !== sermon.title && (
                    <div className="text-xs text-gray-500 italic mt-0.5">
                      Titled: "{p.title_used}"
                    </div>
                  )}
                  {p.series && (
                    <div className="text-xs text-gray-500 mt-0.5">
                      Series: {p.series}
                    </div>
                  )}
                  {p.bulletin && (
                    <div className="text-xs text-gray-400 mt-0.5">
                      In bulletin: {p.bulletin.sunday_designation || ''}
                      {p.bulletin.status !== 'published' && (
                        <span className="ml-1 px-1 py-0.5 text-[10px] uppercase tracking-wide rounded bg-gray-100 text-gray-500">
                          {p.bulletin.status}
                        </span>
                      )}
                    </div>
                  )}
                  {p.liturgy_text && (
                    <details className="mt-2">
                      <summary className="text-xs text-umc-700 hover:text-umc-900 cursor-pointer">
                        📄 Liturgy
                        {p.liturgy_source_filename && (
                          <span className="ml-1 text-gray-400 font-mono text-[10px]">
                            ({p.liturgy_source_filename})
                          </span>
                        )}
                      </summary>
                      <p className="mt-2 text-sm text-gray-800 whitespace-pre-wrap font-serif leading-relaxed bg-gray-50 border border-gray-200 rounded p-3 max-h-96 overflow-y-auto">
                        {p.liturgy_text}
                      </p>
                    </details>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Past versions (revision snapshots) */}
      <RevisionsCard
        sermon={sermon}
        revisions={revisions}
        setRevisions={setRevisions}
        userId={user?.id}
      />

      {/* Resources used in this sermon */}
      <SermonResourcesCard
        sermon={sermon}
        linkedResources={linkedResources}
        setLinkedResources={setLinkedResources}
        userId={user?.id}
      />

      {/* Manuscript */}
      <ManuscriptCard sermon={sermon} setSermon={setSermon} />
    </div>
  );
}

// Panel showing resources (stories/quotes/illustrations/jokes/notes) the
// pastor has tagged as used in this sermon. Lets him search his library
// and link an existing resource, or add a usage note.
function SermonResourcesCard({
  sermon,
  linkedResources,
  setLinkedResources,
  userId,
}) {
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [searchError, setSearchError] = useState(null);
  const [usedNotes, setUsedNotes] = useState('');
  const [picked, setPicked] = useState(null);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState(null);
  const [unlinkingId, setUnlinkingId] = useState(null);

  // Extract-from-manuscript workflow state
  const [extracting, setExtracting] = useState(false); // panel mode flag
  const [extractRunning, setExtractRunning] = useState(false); // Claude in flight
  const [extractError, setExtractError] = useState(null);
  // Candidates Claude proposed; per-row editable + selectable
  const [candidates, setCandidates] = useState([]);
  const [extractLibraryId, setExtractLibraryId] = useState(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('wfumc-resources-last-library') || '';
  });
  const [savingExtract, setSavingExtract] = useState(false);
  const [extractLibraries, setExtractLibraries] = useState([]);

  useEffect(() => {
    if (extracting && extractLibraries.length === 0) {
      listMyLibraries()
        .then((libs) => setExtractLibraries(libs))
        .catch(() => setExtractLibraries([]));
    }
  }, [extracting, extractLibraries.length]);

  const linkedIds = new Set(
    linkedResources.map((l) => l.resource?.id).filter(Boolean)
  );

  const runSearch = async (q) => {
    setSearch(q);
    if (!q.trim() || !userId) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      // Search title + content + scripture + tone via or() ilike patterns.
      // No owner filter — RLS already returns rows you own AND rows in
      // libraries you're a member of, so co-pastor's contributions are
      // findable here too.
      const term = `%${q.trim()}%`;
      const { data, error: err } = await withTimeout(
        supabase
          .from('resources')
          .select('id, resource_type, title, content, source, themes')
          .or(
            `title.ilike.${term},content.ilike.${term},scripture_refs.ilike.${term},tone.ilike.${term}`
          )
          .limit(15)
      );
      if (err) throw err;
      setSearchResults(data ?? []);
    } catch (e) {
      setSearchError(e.message || String(e));
    } finally {
      setSearching(false);
    }
  };

  const reset = () => {
    setAdding(false);
    setSearch('');
    setSearchResults([]);
    setSearchError(null);
    setUsedNotes('');
    setPicked(null);
    setLinkError(null);
  };

  const linkPicked = async () => {
    if (!picked || !userId || !sermon) return;
    setLinking(true);
    setLinkError(null);
    try {
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermon_resources')
          .insert({
            sermon_id: sermon.id,
            resource_id: picked.id,
            owner_user_id: userId,
            used_notes: usedNotes.trim() || null,
          })
          .select(
            'id, used_notes, created_at, resource:resources(id, resource_type, title, content, source, themes, tone)'
          )
          .single()
      );
      if (err) throw err;
      setLinkedResources((rs) => [data, ...rs]);
      reset();
    } catch (e) {
      setLinkError(e.message || String(e));
    } finally {
      setLinking(false);
    }
  };

  const unlink = async (link) => {
    if (
      !window.confirm(
        `Remove this resource link? The resource itself stays in your library.`
      )
    ) {
      return;
    }
    setUnlinkingId(link.id);
    try {
      const { error: err } = await withTimeout(
        supabase.from('sermon_resources').delete().eq('id', link.id)
      );
      if (err) throw err;
      setLinkedResources((rs) => rs.filter((r) => r.id !== link.id));
    } catch (e) {
      setLinkError(e.message || String(e));
    } finally {
      setUnlinkingId(null);
    }
  };

  // Kick off the extract workflow: ask Claude to mine the manuscript.
  const startExtract = async () => {
    if (!sermon) return;
    if (!sermon.manuscript_text || !sermon.manuscript_text.trim()) {
      setExtractError(
        'No manuscript saved on this sermon yet. Add one above first.'
      );
      setExtracting(true);
      return;
    }
    setExtracting(true);
    setExtractRunning(true);
    setExtractError(null);
    setCandidates([]);
    try {
      const result = await extractResourcesFromManuscript({
        manuscriptText: sermon.manuscript_text,
        sermonContext: {
          title: sermon.title,
          scripture_reference: sermon.scripture_reference,
          theme: sermon.theme,
        },
      });
      // Initialize per-candidate editable state
      const init = result.map((r, i) => ({
        ...r,
        _id: `cand-${i}`,
        selected: true,
      }));
      setCandidates(init);
      if (init.length === 0) {
        setExtractError(
          "Claude didn't find any resources worth extracting from this manuscript."
        );
      }
    } catch (e) {
      setExtractError(e.message || String(e));
    } finally {
      setExtractRunning(false);
    }
  };

  const cancelExtract = () => {
    setExtracting(false);
    setExtractRunning(false);
    setExtractError(null);
    setCandidates([]);
  };

  const updateCandidate = (id, patch) => {
    setCandidates((prev) =>
      prev.map((c) => (c._id === id ? { ...c, ...patch } : c))
    );
  };

  // Merge all currently-selected candidates into one. The first one's
  // title/type wins (it's usually the most coherent); contents are
  // concatenated with a paragraph break; themes are deduped union;
  // scripture refs are joined with "; "; tones get joined with " / ".
  // The merged candidate replaces the first selected one in place,
  // and the others are removed.
  const mergeSelected = () => {
    const selected = candidates.filter((c) => c.selected);
    if (selected.length < 2) return;
    const titleParts = selected
      .map((c) => c.proposed_title?.trim())
      .filter(Boolean);
    const themeUnion = Array.from(
      new Set(
        selected.flatMap((c) =>
          (c.themes || []).map((t) => t.trim().toLowerCase())
        )
      )
    ).filter(Boolean);
    const scriptureUnion = Array.from(
      new Set(
        selected
          .flatMap((c) =>
            (c.scripture_refs || '')
              .split(/[;,]/)
              .map((s) => s.trim())
              .filter(Boolean)
          )
      )
    ).join('; ');
    const toneUnion = Array.from(
      new Set(selected.map((c) => c.tone?.trim()).filter(Boolean))
    ).join(' / ');
    const merged = {
      ...selected[0],
      _id: `merged-${Date.now()}`,
      // Use first non-empty title; if multiple titles diverge, keep the
      // first and let the user edit afterward.
      proposed_title: titleParts[0] || selected[0].proposed_title || '',
      content: selected.map((c) => c.content.trim()).filter(Boolean).join('\n\n'),
      themes: themeUnion,
      scripture_refs: scriptureUnion,
      tone: toneUnion,
      selected: true,
    };
    const mergedIds = new Set(selected.map((c) => c._id));
    setCandidates((prev) => {
      const next = [];
      let inserted = false;
      for (const c of prev) {
        if (mergedIds.has(c._id)) {
          if (!inserted) {
            next.push(merged);
            inserted = true;
          }
          // skip the others — they're absorbed into `merged`
        } else {
          next.push(c);
        }
      }
      return next;
    });
  };

  // Bulk save: insert each accepted candidate as a resource AND a
  // sermon_resources link to this sermon.
  const saveExtracted = async () => {
    if (!userId || !sermon) return;
    const accepted = candidates.filter((c) => c.selected && c.content.trim());
    if (accepted.length === 0) {
      setExtractError('Nothing selected to save.');
      return;
    }
    setSavingExtract(true);
    setExtractError(null);
    const newLinks = [];
    const errors = [];
    try {
      for (const cand of accepted) {
        try {
          const { data: resource, error: insErr } = await withTimeout(
            supabase
              .from('resources')
              .insert({
                owner_user_id: userId,
                library_id: extractLibraryId || null,
                resource_type: cand.type || 'story',
                title: cand.proposed_title?.trim() || null,
                content: cand.content.trim(),
                source: null,
                source_url: null,
                themes: cand.themes ?? [],
                scripture_refs: cand.scripture_refs?.trim() || null,
                tone: cand.tone?.trim() || null,
                notes: null,
              })
              .select()
              .single()
          );
          if (insErr) throw insErr;
          // Auto-link to source sermon
          const { data: link, error: linkErr } = await withTimeout(
            supabase
              .from('sermon_resources')
              .insert({
                sermon_id: sermon.id,
                resource_id: resource.id,
                owner_user_id: userId,
                used_notes: 'Extracted from manuscript',
              })
              .select(
                'id, used_notes, created_at, resource:resources(id, resource_type, title, content, source, themes, tone)'
              )
              .single()
          );
          if (linkErr) throw linkErr;
          newLinks.push(link);
        } catch (rowErr) {
          errors.push(
            `"${cand.proposed_title || cand.content.slice(0, 40)}…": ${
              rowErr.message || String(rowErr)
            }`
          );
        }
      }
      if (newLinks.length > 0) {
        setLinkedResources((rs) => [...newLinks, ...rs]);
      }
      // Remember library choice for next time
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(
          'wfumc-resources-last-library',
          extractLibraryId || ''
        );
      }
      if (errors.length > 0) {
        setExtractError(
          `Saved ${newLinks.length}; ${errors.length} failed:\n${errors.join('\n')}`
        );
      } else {
        setExtracting(false);
        setCandidates([]);
      }
    } finally {
      setSavingExtract(false);
    }
  };

  const TYPE_BADGE = {
    story: { label: 'Story', cls: 'bg-blue-100 text-blue-800' },
    quote: { label: 'Quote', cls: 'bg-purple-100 text-purple-800' },
    illustration: { label: 'Illustration', cls: 'bg-amber-100 text-amber-800' },
    joke: { label: 'Joke', cls: 'bg-green-100 text-green-800' },
    note: { label: 'Note', cls: 'bg-gray-200 text-gray-700' },
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-lg text-umc-900">
            Resources used
            {linkedResources.length > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500">
                ({linkedResources.length})
              </span>
            )}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Stories, quotes, and illustrations from your library used in this sermon.
          </p>
        </div>
        {!adding && !extracting && (
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              onClick={startExtract}
              className="btn-secondary text-sm whitespace-nowrap"
              title="Use Claude to find stories, quotes, and illustrations in this sermon's manuscript"
            >
              ✨ Extract from manuscript
            </button>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="btn-secondary text-sm whitespace-nowrap"
            >
              + Link resource
            </button>
          </div>
        )}
      </div>

      {adding && (
        <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
          {!picked ? (
            <>
              <div>
                <label className="label">Search your library</label>
                <input
                  type="text"
                  className="input"
                  value={search}
                  onChange={(e) => runSearch(e.target.value)}
                  placeholder="Title, content, scripture…"
                  autoFocus
                />
                <p className="text-xs text-gray-500 mt-1">
                  Don't see it?{' '}
                  <Link
                    to="/resources/new"
                    className="underline hover:text-gray-700"
                  >
                    Create a new resource
                  </Link>{' '}
                  first, then come back and link it.
                </p>
              </div>
              {searchError && (
                <p className="text-xs text-red-600">{searchError}</p>
              )}
              {searching && (
                <p className="text-xs text-gray-500">Searching…</p>
              )}
              {!searching && search.trim() && searchResults.length === 0 && (
                <p className="text-xs text-gray-500">No matches.</p>
              )}
              {searchResults.length > 0 && (
                <ul className="divide-y divide-gray-100 border border-gray-200 rounded">
                  {searchResults.map((r) => {
                    const already = linkedIds.has(r.id);
                    const badge = TYPE_BADGE[r.resource_type] ?? TYPE_BADGE.note;
                    return (
                      <li key={r.id}>
                        <button
                          type="button"
                          disabled={already}
                          onClick={() => setPicked(r)}
                          className="w-full text-left px-3 py-2 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <div className="flex items-baseline gap-2">
                            <span
                              className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded ${badge.cls}`}
                            >
                              {badge.label}
                            </span>
                            {r.title && (
                              <span className="text-sm font-medium text-umc-900 truncate">
                                {r.title}
                              </span>
                            )}
                            {already && (
                              <span className="text-[10px] text-gray-500 italic">
                                already linked
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-gray-600 line-clamp-2 mt-1">
                            {r.content}
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="flex">
                <button
                  type="button"
                  onClick={reset}
                  className="btn-secondary text-sm"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="bg-gray-50 border border-gray-200 rounded p-3">
                <div className="flex items-baseline gap-2">
                  <span
                    className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded ${
                      (TYPE_BADGE[picked.resource_type] ?? TYPE_BADGE.note).cls
                    }`}
                  >
                    {(TYPE_BADGE[picked.resource_type] ?? TYPE_BADGE.note).label}
                  </span>
                  {picked.title && (
                    <span className="text-sm font-medium text-umc-900">
                      {picked.title}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-700 line-clamp-3 mt-1 whitespace-pre-wrap">
                  {picked.content}
                </p>
              </div>
              <div>
                <label className="label">How was it used? (optional)</label>
                <input
                  type="text"
                  className="input"
                  value={usedNotes}
                  onChange={(e) => setUsedNotes(e.target.value)}
                  placeholder='e.g., "Opener", "After the second point"'
                />
              </div>
              {linkError && (
                <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                  {linkError}
                </p>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={linkPicked}
                  disabled={linking}
                  className="btn-primary disabled:opacity-50"
                >
                  {linking ? 'Linking…' : 'Link this resource'}
                </button>
                <button
                  type="button"
                  onClick={() => setPicked(null)}
                  className="btn-secondary"
                >
                  Pick a different one
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="text-sm text-gray-500 hover:text-gray-700 underline"
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Extract-from-manuscript workflow */}
      {extracting && (
        <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
          {extractRunning ? (
            <p className="text-sm text-gray-600 py-4 text-center">
              ✨ Reading the manuscript… this can take 20-40 seconds.
            </p>
          ) : (
            <>
              {extractError && (
                <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 whitespace-pre-wrap">
                  {extractError}
                </p>
              )}
              {candidates.length > 0 && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="label">Save into library</label>
                      <select
                        className="input"
                        value={extractLibraryId}
                        onChange={(e) => setExtractLibraryId(e.target.value)}
                      >
                        <option value="">Just me (private)</option>
                        {extractLibraries.map((lib) => (
                          <option key={lib.id} value={lib.id}>
                            {lib.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-end">
                      <p className="text-xs text-gray-500">
                        {candidates.filter((c) => c.selected).length} of{' '}
                        {candidates.length} selected. Edit titles/themes inline,
                        then save. Each becomes a new resource auto-linked to
                        this sermon.
                      </p>
                    </div>
                  </div>
                  <ul className="space-y-3">
                    {candidates.map((c) => {
                      const badge =
                        TYPE_BADGE[c.type] ?? TYPE_BADGE.story;
                      return (
                        <li
                          key={c._id}
                          className={`border rounded p-3 ${
                            c.selected
                              ? 'border-umc-700 bg-umc-50/30'
                              : 'border-gray-200 bg-gray-50 opacity-60'
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              checked={!!c.selected}
                              onChange={(e) =>
                                updateCandidate(c._id, {
                                  selected: e.target.checked,
                                })
                              }
                              className="h-4 w-4 mt-1 rounded border-gray-300 text-umc-700"
                            />
                            <div className="flex-1 min-w-0 space-y-2">
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                <div className="sm:col-span-2">
                                  <input
                                    type="text"
                                    className="input text-sm py-1"
                                    value={c.proposed_title}
                                    onChange={(e) =>
                                      updateCandidate(c._id, {
                                        proposed_title: e.target.value,
                                      })
                                    }
                                    placeholder="Title"
                                  />
                                </div>
                                <select
                                  className="input text-sm py-1"
                                  value={c.type}
                                  onChange={(e) =>
                                    updateCandidate(c._id, {
                                      type: e.target.value,
                                    })
                                  }
                                >
                                  <option value="story">Story</option>
                                  <option value="quote">Quote</option>
                                  <option value="illustration">
                                    Illustration
                                  </option>
                                  <option value="joke">Joke</option>
                                  <option value="note">Note</option>
                                </select>
                              </div>
                              <textarea
                                className="input text-sm min-h-[80px]"
                                value={c.content}
                                onChange={(e) =>
                                  updateCandidate(c._id, {
                                    content: e.target.value,
                                  })
                                }
                              />
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                <input
                                  type="text"
                                  className="input text-xs py-1"
                                  placeholder="themes (comma-separated)"
                                  value={c.themes.join(', ')}
                                  onChange={(e) =>
                                    updateCandidate(c._id, {
                                      themes: e.target.value
                                        .split(',')
                                        .map((t) => t.trim().toLowerCase())
                                        .filter(Boolean),
                                    })
                                  }
                                />
                                <input
                                  type="text"
                                  className="input text-xs py-1"
                                  placeholder="scripture refs"
                                  value={c.scripture_refs}
                                  onChange={(e) =>
                                    updateCandidate(c._id, {
                                      scripture_refs: e.target.value,
                                    })
                                  }
                                />
                                <input
                                  type="text"
                                  className="input text-xs py-1"
                                  placeholder="tone"
                                  value={c.tone}
                                  onChange={(e) =>
                                    updateCandidate(c._id, {
                                      tone: e.target.value,
                                    })
                                  }
                                />
                              </div>
                              <div className="flex items-baseline gap-2 text-[10px] uppercase tracking-wide">
                                <span
                                  className={`px-1.5 py-0.5 rounded ${badge.cls}`}
                                >
                                  {badge.label}
                                </span>
                              </div>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              <div className="flex gap-2">
                {candidates.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={saveExtracted}
                      disabled={
                        savingExtract ||
                        candidates.filter((c) => c.selected).length === 0
                      }
                      className="btn-primary disabled:opacity-50"
                    >
                      {savingExtract
                        ? 'Saving…'
                        : `Save ${
                            candidates.filter((c) => c.selected).length
                          } resource${
                            candidates.filter((c) => c.selected).length === 1
                              ? ''
                              : 's'
                          }`}
                    </button>
                    {/* Merge appears once 2+ candidates are selected.
                        Combines them into one (first wins for title/type;
                        content concatenated; themes/scripture deduped). */}
                    {candidates.filter((c) => c.selected).length >= 2 && (
                      <button
                        type="button"
                        onClick={mergeSelected}
                        disabled={savingExtract}
                        className="btn-secondary disabled:opacity-50"
                        title="Combine the selected candidates into a single resource"
                      >
                        ⊕ Merge {candidates.filter((c) => c.selected).length}
                      </button>
                    )}
                  </>
                )}
                <button
                  type="button"
                  onClick={cancelExtract}
                  className="btn-secondary"
                >
                  {candidates.length > 0 ? 'Cancel' : 'Close'}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {linkedResources.length === 0 && !adding && !extracting && (
        <p className="mt-3 text-sm text-gray-400 italic">
          No resources linked to this sermon yet.
        </p>
      )}

      {linkedResources.length > 0 && (
        <ul className="mt-4 divide-y divide-gray-100">
          {linkedResources.map((link) => {
            const r = link.resource;
            if (!r) return null;
            const badge = TYPE_BADGE[r.resource_type] ?? TYPE_BADGE.note;
            return (
              <li key={link.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <Link
                    to={`/resources/${r.id}`}
                    className="min-w-0 flex-1 hover:opacity-80"
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span
                        className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wide rounded ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                      {r.title && (
                        <span className="text-sm font-medium text-umc-900">
                          {r.title}
                        </span>
                      )}
                      {r.tone && (
                        <span className="text-xs italic text-gray-500">
                          {r.tone}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-700 line-clamp-2 mt-1 whitespace-pre-wrap">
                      {r.content}
                    </p>
                    {link.used_notes && (
                      <p className="text-xs text-gray-500 mt-1 italic">
                        Used: {link.used_notes}
                      </p>
                    )}
                  </Link>
                  <button
                    type="button"
                    onClick={() => unlink(link)}
                    disabled={unlinkingId === link.id}
                    className="text-xs text-red-600 hover:text-red-800 underline shrink-0 disabled:opacity-50"
                  >
                    {unlinkingId === link.id ? 'Removing…' : 'Unlink'}
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

// "Past versions" panel — lets the pastor snapshot the current state of
// a sermon (title + manuscript + scripture/theme/notes) with an optional
// label, and view/delete prior snapshots. Stored in sermon_revisions.
//
// Use case: he frequently rewrites sermons when preaching them at a new
// location, and occasionally wants to keep a copy of the prior version
// in case a story or section is worth reviving later.
function RevisionsCard({ sermon, revisions, setRevisions, userId }) {
  const [open, setOpen] = useState(false);
  const [snapshotting, setSnapshotting] = useState(false);
  const [label, setLabel] = useState('');
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [deletingId, setDeletingId] = useState(null);

  const toggleExpanded = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const takeSnapshot = async () => {
    if (!userId || !sermon) return;
    setSnapshotting(true);
    setError(null);
    try {
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermon_revisions')
          .insert({
            sermon_id: sermon.id,
            owner_user_id: userId,
            snapshot_title: sermon.title ?? null,
            snapshot_manuscript_text: sermon.manuscript_text ?? null,
            snapshot_scripture_reference: sermon.scripture_reference ?? null,
            snapshot_theme: sermon.theme ?? null,
            snapshot_notes: sermon.notes ?? null,
            label: label.trim() || null,
          })
          .select()
          .single()
      );
      if (err) throw err;
      setRevisions((rs) => [data, ...rs]);
      setLabel('');
      setOpen(false);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSnapshotting(false);
    }
  };

  const deleteRevision = async (rev) => {
    if (
      !window.confirm(
        `Delete this snapshot${rev.label ? ` ("${rev.label}")` : ''}? This can't be undone.`
      )
    ) {
      return;
    }
    setDeletingId(rev.id);
    setError(null);
    try {
      const { error: err } = await withTimeout(
        supabase.from('sermon_revisions').delete().eq('id', rev.id)
      );
      if (err) throw err;
      setRevisions((rs) => rs.filter((r) => r.id !== rev.id));
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(rev.id);
        return next;
      });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-lg text-umc-900">
            Past versions
            {revisions.length > 0 && (
              <span className="ml-2 text-sm font-normal text-gray-500">
                ({revisions.length})
              </span>
            )}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Snapshot the current title + manuscript before a major rewrite.
          </p>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => {
              setOpen(true);
              setError(null);
            }}
            className="btn-secondary text-sm whitespace-nowrap"
          >
            + Snapshot current version
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
          <div>
            <label className="label">Label (optional)</label>
            <input
              type="text"
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder='e.g., "Pre-Wedowee rewrite", "Original 2014 version"'
            />
            <p className="text-xs text-gray-500 mt-1">
              Captures: title, manuscript, scripture, theme, and private notes.
              Future edits to the sermon won't affect this snapshot.
            </p>
          </div>
          {error && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={takeSnapshot}
              disabled={snapshotting}
              className="btn-primary disabled:opacity-50"
            >
              {snapshotting ? 'Saving snapshot…' : 'Save snapshot'}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setLabel('');
                setError(null);
              }}
              className="btn-secondary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {revisions.length === 0 && !open && (
        <p className="mt-3 text-sm text-gray-400 italic">
          No prior versions saved.
        </p>
      )}

      {revisions.length > 0 && (
        <ul className="mt-4 divide-y divide-gray-100">
          {revisions.map((rev) => {
            const isOpen = expanded.has(rev.id);
            const titleChanged =
              rev.snapshot_title && rev.snapshot_title !== sermon.title;
            return (
              <li key={rev.id} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-sm font-medium text-umc-900">
                        {rev.label || 'Snapshot'}
                      </span>
                      <span className="text-xs text-gray-500">
                        {new Date(rev.taken_at).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    </div>
                    {rev.snapshot_title && (
                      <div className="text-sm text-gray-700 mt-0.5">
                        {titleChanged ? (
                          <>
                            <span className="text-gray-400">Then titled: </span>
                            <span className="italic">"{rev.snapshot_title}"</span>
                          </>
                        ) : (
                          <span className="italic text-gray-500">
                            "{rev.snapshot_title}"
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(rev.id)}
                      className="text-xs text-umc-700 hover:text-umc-900 underline"
                    >
                      {isOpen ? 'Hide' : 'View'}
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteRevision(rev)}
                      disabled={deletingId === rev.id}
                      className="text-xs text-red-600 hover:text-red-800 underline disabled:opacity-50"
                    >
                      {deletingId === rev.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </div>
                {isOpen && (
                  <div className="mt-3 ml-0 space-y-3 bg-gray-50 border border-gray-200 rounded p-3">
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600">
                      {rev.snapshot_scripture_reference && (
                        <span>
                          <span className="text-gray-400">Scripture: </span>
                          {rev.snapshot_scripture_reference}
                        </span>
                      )}
                      {rev.snapshot_theme && (
                        <span>
                          <span className="text-gray-400">Theme: </span>
                          {rev.snapshot_theme}
                        </span>
                      )}
                    </div>
                    {rev.snapshot_notes && (
                      <div>
                        <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                          Private notes (snapshot)
                        </p>
                        <p className="text-xs text-gray-700 whitespace-pre-wrap">
                          {rev.snapshot_notes}
                        </p>
                      </div>
                    )}
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
                        Manuscript (snapshot)
                      </p>
                      {rev.snapshot_manuscript_text ? (
                        <p className="text-sm text-gray-800 whitespace-pre-wrap font-serif leading-relaxed max-h-[400px] overflow-y-auto">
                          {rev.snapshot_manuscript_text}
                        </p>
                      ) : (
                        <p className="text-xs text-gray-400 italic">
                          No manuscript at the time of this snapshot.
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Inline manuscript editor — read view with "Edit" toggle, edit view
// with textarea + DOCX upload, save persists to sermons.manuscript_text.
//
// Edit drafts persist to sessionStorage so a navigation away (or the
// auth re-validation flicker) doesn't lose work. On return, edit mode
// auto-resumes with a small "unsaved changes restored" banner.
function ManuscriptCard({ sermon, setSermon }) {
  const { user } = useAuth();
  const draftKey =
    user?.id && sermon?.id
      ? `sermon-manuscript:${user.id}:${sermon.id}`
      : null;
  const [storedDraft, setStoredDraft, hasManuscriptDraft, discardManuscriptDraft] =
    useDraftStorage(draftKey);
  const [editing, setEditing] = useState(false);
  // The textarea binds to draft. When editing, draft mirrors storedDraft;
  // when not editing, the textarea isn't mounted so this is unused.
  const draft = storedDraft ?? '';
  const setDraft = setStoredDraft;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [uploadNote, setUploadNote] = useState(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [copyState, setCopyState] = useState('idle'); // 'idle' | 'copied' | 'error'
  const docInputRef = useRef(null);

  // Copy whatever text is current — the in-progress draft if editing,
  // otherwise the saved manuscript. Keeps a "Copied!" pip visible for
  // ~1.5s. Falls back to a textarea-select trick if the Clipboard API
  // isn't available (some older browsers / locked-down contexts).
  const handleCopy = async () => {
    const text = editing ? draft : sermon?.manuscript_text ?? '';
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 2500);
    }
  };

  // Show the Copy button whenever there's something to copy in the
  // current view — saved manuscript when not editing, draft when editing.
  const hasCopyableText = editing
    ? Boolean(draft && draft.trim())
    : Boolean(sermon?.manuscript_text && sermon.manuscript_text.trim());

  // Auto-resume edit mode if a draft was saved earlier.
  useEffect(() => {
    if (sermon && hasManuscriptDraft() && !editing) {
      setEditing(true);
      setDraftRestored(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sermon?.id]);

  const startEdit = () => {
    setDraft(sermon.manuscript_text ?? '');
    setEditing(true);
    setDraftRestored(false);
    setSaveError(null);
    setUploadError(null);
    setUploadNote(null);
  };

  const cancelEdit = () => {
    discardManuscriptDraft();
    setEditing(false);
    setDraftRestored(false);
    setUploadError(null);
    setUploadNote(null);
  };

  const discardRestoredDraft = () => {
    discardManuscriptDraft();
    setDraftRestored(false);
    startEdit();
  };

  const handleManuscriptUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const isDocx =
      file.name.toLowerCase().endsWith('.docx') ||
      file.type ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (!isDocx) {
      setUploadError(
        'Please upload a .docx file (Microsoft Word). PDF support is coming later.'
      );
      return;
    }
    setUploading(true);
    setUploadError(null);
    setUploadNote(null);
    try {
      const mammoth =
        (await import('mammoth')).default ?? (await import('mammoth'));
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer });
      const text = (result?.value ?? '').trim();
      if (!text) {
        setUploadError(
          "Couldn't extract any text from that document. It might be empty or image-only."
        );
        return;
      }
      setDraft(text);
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      setUploadNote(
        `Loaded ${wordCount.toLocaleString()} words from ${file.name}. Click "Save" to attach it.`
      );
    } catch (err) {
      setUploadError(err?.message || 'Failed to parse document.');
    } finally {
      setUploading(false);
      if (docInputRef.current) docInputRef.current.value = '';
    }
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermons')
          .update({ manuscript_text: draft.trim() || null })
          .eq('id', sermon.id)
          .select()
          .single()
      );
      if (err) throw err;
      setSermon(data);
      discardManuscriptDraft();
      setEditing(false);
      setDraftRestored(false);
    } catch (err) {
      setSaveError(err.message || String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="font-serif text-lg text-umc-900">Manuscript</h2>
        <div className="flex items-center gap-2">
          {hasCopyableText && (
            <button
              type="button"
              onClick={handleCopy}
              className="btn-secondary text-sm"
              title="Copy the manuscript text to your clipboard"
            >
              {copyState === 'copied'
                ? '✓ Copied!'
                : copyState === 'error'
                  ? 'Copy failed'
                  : '📋 Copy'}
            </button>
          )}
          {!editing && (
            <button
              type="button"
              onClick={startEdit}
              className="btn-secondary text-sm"
            >
              {sermon.manuscript_text ? 'Edit manuscript' : '+ Add manuscript'}
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <div className="mt-3 space-y-3">
          {draftRestored && (
            <div className="border border-amber-300 bg-amber-50 rounded px-3 py-2 flex items-center justify-between gap-3">
              <p className="text-xs text-amber-900">
                Picked up where you left off — these are unsaved manuscript
                changes from earlier. Save to apply, or discard to start
                fresh from the saved version.
              </p>
              <button
                type="button"
                onClick={discardRestoredDraft}
                className="text-xs underline text-amber-900 hover:text-amber-700 whitespace-nowrap"
              >
                Discard changes
              </button>
            </div>
          )}
          <div className="flex justify-end">
            <label
              className={`text-xs cursor-pointer text-umc-700 hover:text-umc-900 underline ${
                uploading ? 'opacity-50 pointer-events-none' : ''
              }`}
            >
              {uploading ? 'Reading…' : '📄 Upload Word doc (.docx)'}
              <input
                ref={docInputRef}
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                className="hidden"
                onChange={handleManuscriptUpload}
                disabled={uploading}
              />
            </label>
          </div>
          <textarea
            className="input min-h-[300px] font-mono text-sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste the manuscript text here, or upload a .docx file above."
          />
          {uploadError && (
            <p className="text-xs text-red-600">{uploadError}</p>
          )}
          {uploadNote && !uploadError && (
            <p className="text-xs text-umc-700">{uploadNote}</p>
          )}
          {saveError && (
            <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
              {saveError}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="btn-primary disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save manuscript'}
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
      ) : sermon.manuscript_text ? (
        <p className="mt-3 text-base text-gray-800 whitespace-pre-wrap font-serif leading-relaxed">
          {sermon.manuscript_text}
        </p>
      ) : (
        <p className="mt-3 text-sm text-gray-400 italic">
          No manuscript text saved for this sermon. Click "+ Add manuscript"
          above to upload a Word doc or paste the text.
        </p>
      )}
    </div>
  );
}
