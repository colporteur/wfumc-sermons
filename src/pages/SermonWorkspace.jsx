import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import {
  reviseSermonManuscript,
  buildMarkersReferenceText,
} from '../lib/claude';
import { loadVoiceGuideForPrompt } from '../lib/voiceGuide';
import {
  fetchResourcesByIds,
  buildResourcesContext,
} from '../lib/workspaceResources';
import WorkspaceResources from '../components/WorkspaceResources.jsx';
import WorkspaceDiffModal from '../components/WorkspaceDiffModal.jsx';
import WorkspaceSlides from '../components/WorkspaceSlides.jsx';

// /sermons/:id/workspace — the Sermon Workspace.
//
// Two-pane layout:
//   left  — chat history of revision requests + composer
//   right — live editable manuscript (the artifact)
//
// Each Claude turn replaces the manuscript artifact with the revised
// text. Hand edits the pastor makes between turns are preserved (they
// become the new "current manuscript" the next Claude call sees).
// The current manuscript text is auto-saved back to sermons.manuscript_text
// on a debounce, with a manual "Save now" button for impatience.
//
// A snapshot is written to sermon_revisions before every Claude turn so
// the prior version is always recoverable, even if the new revision is
// worse.
//
// Chat history persists to sessionStorage during the session so a tab
// reload doesn't lose the thread; it's intentionally NOT stored in the
// database (chats can grow large + a fresh tab tomorrow probably wants
// a fresh thread).

const AUTOSAVE_DEBOUNCE_MS = 3000;
const CHAT_STORAGE_PREFIX = 'wfumc-workspace-chat:';
const RESOURCES_STORAGE_PREFIX = 'wfumc-workspace-resources:';

function loadChat(sermonId) {
  try {
    const raw = sessionStorage.getItem(CHAT_STORAGE_PREFIX + sermonId);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveChat(sermonId, messages) {
  try {
    sessionStorage.setItem(
      CHAT_STORAGE_PREFIX + sermonId,
      JSON.stringify(messages)
    );
  } catch {
    /* full / disabled — non-fatal */
  }
}
function clearChatStorage(sermonId) {
  try {
    sessionStorage.removeItem(CHAT_STORAGE_PREFIX + sermonId);
  } catch {
    /* noop */
  }
}

// Persist only the selected resource IDs (not the full rows) — on
// rehydrate we re-query so a row edited in another tab is up to date.
function loadResourceIds(sermonId) {
  try {
    const raw = sessionStorage.getItem(RESOURCES_STORAGE_PREFIX + sermonId);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveResourceIds(sermonId, ids) {
  try {
    sessionStorage.setItem(
      RESOURCES_STORAGE_PREFIX + sermonId,
      JSON.stringify(ids)
    );
  } catch {
    /* noop */
  }
}

export default function SermonWorkspace() {
  const { user } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Sermon row + the live (in-memory) manuscript text.
  const [sermon, setSermon] = useState(null);
  const [manuscript, setManuscript] = useState('');
  const [savedManuscript, setSavedManuscript] = useState('');
  // dirty = manuscript differs from what's in the DB
  const dirty = manuscript !== savedManuscript;

  // Chat conversation. {role, content, ts, kind?: 'note'} where 'note'
  // is a system note like "Manuscript snapshot taken before this revision."
  const [messages, setMessages] = useState([]);

  // Pre-rendered voice guide system prompt + markers reference. Built
  // once on load; doesn't need to refresh per-turn.
  const [voicePrompt, setVoicePrompt] = useState('');
  const [hasVoiceGuide, setHasVoiceGuide] = useState(false);
  const markersReference = useMemo(() => buildMarkersReferenceText(), []);

  // Resources selected for the next Claude turn. Persisted by ID in
  // sessionStorage; rehydrated to full rows on mount.
  const [selectedResources, setSelectedResources] = useState([]);

  // Which assistant turn (chat message index) to show in the diff modal.
  // null = closed.
  const [diffForIndex, setDiffForIndex] = useState(null);

  // Composer state
  const [draftInstruction, setDraftInstruction] = useState('');
  const [sending, setSending] = useState(false);

  // Manual save state
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);

  // Refs for auto-scroll + autosave timer
  const chatEndRef = useRef(null);
  const autosaveTimerRef = useRef(null);

  // Initial load: sermon row + voice guide
  useEffect(() => {
    if (!user?.id || !id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const storedResourceIds = loadResourceIds(id);
        const [sermonRes, voiceRes, resourceRows] = await Promise.all([
          withTimeout(
            supabase
              .from('sermons')
              .select('*')
              .eq('id', id)
              .eq('owner_user_id', user.id)
              .single()
          ),
          loadVoiceGuideForPrompt(user.id),
          storedResourceIds.length > 0
            ? fetchResourcesByIds(storedResourceIds)
            : Promise.resolve([]),
        ]);
        if (sermonRes.error) throw sermonRes.error;
        if (cancelled) return;
        setSermon(sermonRes.data);
        setManuscript(sermonRes.data?.manuscript_text || '');
        setSavedManuscript(sermonRes.data?.manuscript_text || '');
        setVoicePrompt(voiceRes.systemPrompt || '');
        setHasVoiceGuide(Boolean(voiceRes.guide));
        setMessages(loadChat(id));
        setSelectedResources(resourceRows);
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

  // Auto-scroll chat to bottom whenever messages change.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, sending]);

  // Persist chat to sessionStorage on change (so tab reload survives).
  useEffect(() => {
    if (id) saveChat(id, messages);
  }, [id, messages]);

  // Persist selected resource IDs.
  useEffect(() => {
    if (id) saveResourceIds(id, selectedResources.map((r) => r.id));
  }, [id, selectedResources]);

  // Debounced auto-save of manuscript while it's dirty.
  useEffect(() => {
    if (!dirty || !sermon?.id) return undefined;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      doSave().catch(() => {
        /* errors surface via the error state in doSave */
      });
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manuscript, dirty]);

  const doSave = async () => {
    if (!sermon?.id || !dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermons')
          .update({ manuscript_text: manuscript })
          .eq('id', sermon.id)
          .select('*')
          .single()
      );
      if (err) throw err;
      setSermon(data);
      setSavedManuscript(data.manuscript_text || '');
      setSavedAt(new Date());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  // Take a snapshot of the CURRENT (pre-Claude) manuscript before
  // sending a revision turn. Use a label that makes the snapshot
  // obvious in the RevisionsCard back on SermonDetail.
  const snapshotBeforeRevision = async (turnNumber) => {
    if (!sermon?.id || !user?.id) return null;
    const { data, error: err } = await withTimeout(
      supabase
        .from('sermon_revisions')
        .insert({
          sermon_id: sermon.id,
          owner_user_id: user.id,
          snapshot_title: sermon.title ?? null,
          snapshot_manuscript_text: manuscript || null,
          snapshot_scripture_reference: sermon.scripture_reference ?? null,
          snapshot_theme: sermon.theme ?? null,
          snapshot_notes: sermon.notes ?? null,
          label: `Workspace turn ${turnNumber}`,
        })
        .select('id')
        .single()
    );
    if (err) throw err;
    return data?.id;
  };

  const handleSendInstruction = async () => {
    const instruction = draftInstruction.trim();
    if (!instruction || sending || !sermon?.id) return;
    if (isLocked) {
      setError('Manuscript is locked. Unlock to send Claude a revision.');
      return;
    }
    setSending(true);
    setError(null);

    // Compute turn number (count of user turns + 1).
    const turnNumber =
      messages.filter((m) => m.role === 'user').length + 1;

    // Optimistically append the user's instruction to the chat thread.
    // Stamp the resources attached on this turn so the user can see them
    // in the trail later.
    const userTurn = {
      role: 'user',
      content: instruction,
      ts: Date.now(),
      resourceTitles: selectedResources.map((r) => r.title || '(untitled)'),
    };
    setMessages((prev) => [...prev, userTurn]);
    setDraftInstruction('');

    try {
      // 1) Persist any pending hand edits BEFORE we ask Claude — that
      // way the snapshot we take + the manuscript Claude sees are the
      // same. (If the user is mid-edit, the in-memory `manuscript` is
      // the source of truth either way.)
      if (dirty) {
        try {
          await doSave();
        } catch {
          /* fall through; the snapshot below uses live manuscript anyway */
        }
      }

      // 2) Snapshot current manuscript so this turn is reversible.
      try {
        await snapshotBeforeRevision(turnNumber);
      } catch (snapErr) {
        // Don't block the revision on a snapshot failure; just note it
        // in the chat so the pastor knows.
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            kind: 'note',
            content:
              "Heads up: I couldn't take a pre-revision snapshot (" +
              (snapErr.message || 'unknown error') +
              '). Continuing anyway.',
            ts: Date.now(),
          },
        ]);
      }

      // 3) Call Claude with the assembled context, including any
      // resources selected for this turn.
      const resourcesContext = buildResourcesContext(selectedResources);
      const revised = await reviseSermonManuscript({
        sermon,
        manuscript,
        voiceSystemPrompt: voicePrompt,
        markersReference,
        resourcesContext,
        history: messages
          .filter((m) => m.kind !== 'note')
          .map((m) => ({ role: m.role, content: m.content })),
        instruction,
      });

      if (!revised || !revised.trim()) {
        throw new Error('Claude returned an empty manuscript.');
      }

      // 4) Replace the artifact + append a short assistant turn that
      // describes the change in human-readable terms (we don't have
      // Claude's own description because we asked for manuscript-only
      // output; just stamp word delta).
      const oldWords = countWords(manuscript);
      const newWords = countWords(revised);
      const delta = newWords - oldWords;
      const deltaLabel =
        delta === 0
          ? 'no change in word count'
          : delta > 0
          ? `+${delta} words (${oldWords} → ${newWords})`
          : `${delta} words (${oldWords} → ${newWords})`;

      // Capture before/after on this assistant turn so the diff viewer
      // can show exactly what Claude changed. `manuscript` here is the
      // pre-revision text (we haven't called setManuscript yet).
      const turnBefore = manuscript;
      setManuscript(revised);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Revised manuscript replaced. ${deltaLabel}.`,
          ts: Date.now(),
          manuscriptBefore: turnBefore,
          manuscriptAfter: revised,
          turnNumber,
        },
      ]);

      // 5) Persist the new manuscript right away so a refresh keeps it.
      // (doSave is debounced via state, so call it directly here.)
      try {
        const { data, error: saveErr } = await withTimeout(
          supabase
            .from('sermons')
            .update({ manuscript_text: revised })
            .eq('id', sermon.id)
            .select('*')
            .single()
        );
        if (saveErr) throw saveErr;
        setSermon(data);
        setSavedManuscript(data.manuscript_text || '');
        setSavedAt(new Date());
      } catch (saveErr) {
        setError(
          'Manuscript was revised in memory but the save to the database failed: ' +
            (saveErr.message || String(saveErr)) +
            '. Click "Save now" to retry.'
        );
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          kind: 'note',
          content: 'Error: ' + (e.message || String(e)),
          ts: Date.now(),
        },
      ]);
      setError(e.message || String(e));
    } finally {
      setSending(false);
    }
  };

  // Lock state derived from the sermon row (columns from migration 0038).
  const isLocked = sermon?.manuscript_locked === true;
  const lockedAt = sermon?.manuscript_locked_at
    ? new Date(sermon.manuscript_locked_at)
    : null;
  const [locking, setLocking] = useState(false);

  // Count existing "Final" labeled snapshots to decide whether the next
  // one should be "Final" (first lock) or "Final v2" (subsequent locks).
  const computeFinalLabel = async () => {
    const { data, error: cntErr } = await withTimeout(
      supabase
        .from('sermon_revisions')
        .select('id, label')
        .eq('sermon_id', sermon.id)
        .ilike('label', 'Final%')
    );
    if (cntErr) throw cntErr;
    const count = (data || []).length;
    return count === 0 ? 'Final' : `Final v${count + 1}`;
  };

  const handleLock = async () => {
    if (!sermon?.id || !user?.id) return;
    if (
      !window.confirm(
        'Lock the manuscript?\n\n' +
          '• Saves the current text as a "Final" snapshot under Past Versions\n' +
          '• Disables Claude revisions and direct edits until you unlock\n' +
          '\nThe snapshot stays permanent. You can unlock any time to revise.'
      )
    ) {
      return;
    }
    setLocking(true);
    setError(null);
    try {
      // Persist any pending hand edits so the snapshot captures them.
      if (dirty) {
        await doSave();
      }
      // Compute the label ("Final" / "Final v2" / ...).
      const label = await computeFinalLabel();
      // Take the snapshot.
      const { data: snap, error: snapErr } = await withTimeout(
        supabase
          .from('sermon_revisions')
          .insert({
            sermon_id: sermon.id,
            owner_user_id: user.id,
            snapshot_title: sermon.title ?? null,
            snapshot_manuscript_text: manuscript || null,
            snapshot_scripture_reference: sermon.scripture_reference ?? null,
            snapshot_theme: sermon.theme ?? null,
            snapshot_notes: sermon.notes ?? null,
            label,
          })
          .select('id')
          .single()
      );
      if (snapErr) throw snapErr;
      // Flip the lock flags on the sermon row.
      const { data: updated, error: updErr } = await withTimeout(
        supabase
          .from('sermons')
          .update({
            manuscript_locked: true,
            manuscript_locked_at: new Date().toISOString(),
            manuscript_locked_revision_id: snap.id,
          })
          .eq('id', sermon.id)
          .select('*')
          .single()
      );
      if (updErr) throw updErr;
      setSermon(updated);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          kind: 'note',
          content: `Manuscript locked as "${label}". Snapshot saved to Past Versions.`,
          ts: Date.now(),
        },
      ]);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLocking(false);
    }
  };

  const handleUnlock = async () => {
    if (!sermon?.id) return;
    setLocking(true);
    setError(null);
    try {
      const { data: updated, error: updErr } = await withTimeout(
        supabase
          .from('sermons')
          .update({ manuscript_locked: false })
          .eq('id', sermon.id)
          .select('*')
          .single()
      );
      if (updErr) throw updErr;
      setSermon(updated);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          kind: 'note',
          content:
            'Manuscript unlocked for revision. The previous "Final" snapshot is still saved under Past Versions.',
          ts: Date.now(),
        },
      ]);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLocking(false);
    }
  };

  const handleClearChat = () => {
    if (
      messages.length > 0 &&
      !window.confirm(
        'Clear the chat thread for this sermon? The manuscript stays untouched; only the conversation history is wiped.'
      )
    ) {
      return;
    }
    setMessages([]);
    if (sermon?.id) clearChatStorage(sermon.id);
  };

  // Index of the most-recent un-reverted assistant turn that has a
  // manuscript-before snapshot. Only this turn shows a "Revert" button —
  // older turns can be rolled back via the sermon_revisions snapshots
  // taken at each turn (visible on the SermonDetail Past Versions panel).
  // Locked manuscripts hide Revert entirely — unlock first if you want
  // to roll back.
  const mostRecentRevertableIdx = (() => {
    if (sermon?.manuscript_locked) return -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (
        m.role === 'assistant' &&
        m.manuscriptBefore !== undefined &&
        !m.reverted
      ) {
        return i;
      }
    }
    return -1;
  })();

  const handleRevertTurn = async (idx) => {
    const m = messages[idx];
    if (!m || m.manuscriptBefore === undefined || !sermon?.id) return;

    const handEdited = manuscript !== (m.manuscriptAfter || '');
    const turnLabel = m.turnNumber ? `turn ${m.turnNumber}` : 'this turn';
    const confirmMsg = handEdited
      ? `Revert to the manuscript from BEFORE ${turnLabel}?\n\n` +
        `WARNING: You have hand-edited the manuscript since this turn. Those edits will be lost.\n\n` +
        `(The pre-revision snapshot was already saved as a "Workspace ${turnLabel}" entry on the sermon's Past Versions panel, so you can restore from there too.)`
      : `Revert to the manuscript from BEFORE ${turnLabel}?\n\n` +
        `Claude's revision will be undone. The pre-revision snapshot was saved as a "Workspace ${turnLabel}" entry, so this is recoverable.`;
    if (!window.confirm(confirmMsg)) return;

    setError(null);
    try {
      const reverted = m.manuscriptBefore || '';
      // Optimistically update the live state.
      setManuscript(reverted);
      // Persist immediately so a refresh keeps the rollback.
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermons')
          .update({ manuscript_text: reverted })
          .eq('id', sermon.id)
          .select('*')
          .single()
      );
      if (err) throw err;
      setSermon(data);
      setSavedManuscript(data.manuscript_text || '');
      setSavedAt(new Date());

      // Mark the reverted turn + append a system note in the chat trail.
      setMessages((prev) => [
        ...prev.map((x, i) => (i === idx ? { ...x, reverted: true } : x)),
        {
          role: 'assistant',
          kind: 'note',
          content: `Reverted ${turnLabel}. Manuscript restored to its pre-revision state.`,
          ts: Date.now(),
        },
      ]);
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  if (loading) return <LoadingSpinner label="Loading workspace…" />;
  if (!sermon) {
    return (
      <div className="card text-center text-sm text-gray-500">
        Sermon not found, or not visible to you.
      </div>
    );
  }

  return (
    <div className="space-y-3 max-w-7xl">
      {/* Top bar */}
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={`/sermons/${sermon.id}`}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← {sermon.title || 'Sermon'}
          </Link>
          <h1 className="font-serif text-2xl text-umc-900 mt-1 truncate">
            Workspace
            <span className="ml-2 text-base font-normal text-gray-500">
              {sermon.title || '(untitled)'}
            </span>
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {sermon.scripture_reference || 'No scripture set'}
            {' · '}
            {hasVoiceGuide ? (
              <span className="text-green-700">Voice guide loaded</span>
            ) : (
              <Link
                to="/settings/voice"
                className="text-amber-700 underline hover:text-amber-900"
              >
                ⚠ No voice guide set — Claude will draft generically
              </Link>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs flex-wrap">
          {isLocked ? (
            <>
              <span className="text-umc-700 font-medium">
                🔒 Finalized
                {lockedAt && ` ${lockedAt.toLocaleDateString()}`}
              </span>
              <button
                type="button"
                onClick={handleUnlock}
                disabled={locking}
                className="btn-secondary text-xs disabled:opacity-50"
              >
                {locking ? 'Working…' : 'Unlock to revise'}
              </button>
            </>
          ) : (
            <>
              {savedAt && !dirty && (
                <span className="text-green-700">
                  Saved {savedAt.toLocaleTimeString()}
                </span>
              )}
              {dirty && (
                <span className="text-amber-700">Unsaved hand edits</span>
              )}
              <button
                type="button"
                onClick={doSave}
                disabled={!dirty || saving}
                className="btn-secondary text-xs disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save now'}
              </button>
              <button
                type="button"
                onClick={handleLock}
                disabled={locking}
                className="btn-primary text-xs disabled:opacity-50"
                title="Lock the manuscript and save the current text as a permanent 'Final' snapshot."
              >
                {locking ? 'Working…' : '🔒 Lock manuscript'}
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      {/* Resources for this turn — collapsible panel above the chat / manuscript */}
      <WorkspaceResources
        scriptureReference={sermon.scripture_reference || ''}
        selectedResources={selectedResources}
        setSelectedResources={setSelectedResources}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Chat pane */}
        <div className="card flex flex-col" style={{ minHeight: '70vh' }}>
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <h2 className="font-serif text-lg text-umc-900">Revision chat</h2>
            <button
              type="button"
              onClick={handleClearChat}
              className="text-xs text-gray-500 hover:text-gray-800 underline"
            >
              Clear
            </button>
          </div>
          <div className="flex-1 overflow-y-auto pr-1 space-y-2">
            {messages.length === 0 && !sending && (
              <p className="text-sm text-gray-500 italic">
                No turns yet. Ask Claude to draft, tighten, expand, or
                rework anything in the manuscript on the right. The
                current manuscript is sent on every turn, so you can
                hand-edit between turns and Claude will see your edits.
              </p>
            )}
            {messages.map((m, i) => (
              <ChatBubble
                key={i}
                message={m}
                onViewDiff={
                  m.role === 'assistant' && m.manuscriptAfter !== undefined
                    ? () => setDiffForIndex(i)
                    : null
                }
                onRevert={
                  i === mostRecentRevertableIdx
                    ? () => handleRevertTurn(i)
                    : null
                }
              />
            ))}
            {sending && (
              <div className="text-sm text-gray-500 italic flex items-center gap-2">
                <Spinner /> Claude is revising…
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="mt-3 border-t border-gray-100 pt-3 space-y-2">
            {isLocked && (
              <p className="text-xs text-umc-700 bg-umc-50 border border-umc-200 rounded px-2 py-1.5">
                🔒 Manuscript is locked — Claude revisions are paused.
                Use “Unlock to revise” at the top of the page to continue.
              </p>
            )}
            <textarea
              value={draftInstruction}
              onChange={(e) => setDraftInstruction(e.target.value)}
              onKeyDown={(e) => {
                // Cmd/Ctrl+Enter sends.
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleSendInstruction();
                }
              }}
              placeholder="Tell Claude what to change. e.g. 'Tighten the second illustration. It's repetitive.'"
              rows={3}
              className="input w-full text-sm font-serif leading-relaxed disabled:bg-gray-50 disabled:text-gray-400"
              disabled={sending || isLocked}
            />
            <div className="flex items-center justify-between text-xs">
              <span className="text-gray-500">
                ⌘/Ctrl+Enter to send
              </span>
              <button
                type="button"
                onClick={handleSendInstruction}
                disabled={!draftInstruction.trim() || sending || isLocked}
                className="btn-primary text-sm disabled:opacity-50"
              >
                {sending ? 'Sending…' : 'Send to Claude'}
              </button>
            </div>
          </div>
        </div>

        {/* Manuscript pane */}
        <div className="card flex flex-col" style={{ minHeight: '70vh' }}>
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <h2 className="font-serif text-lg text-umc-900">
              Manuscript
              {isLocked && (
                <span className="ml-2 text-xs font-normal text-umc-700">
                  🔒 Read-only
                </span>
              )}
            </h2>
            <span className="text-xs text-gray-500">
              {countWords(manuscript)} words
            </span>
          </div>
          <textarea
            value={manuscript}
            onChange={(e) => setManuscript(e.target.value)}
            readOnly={isLocked}
            placeholder={
              "The manuscript will appear here. Hand-edit freely between Claude turns — your edits are preserved and Claude sees them on the next turn."
            }
            className={
              'flex-1 w-full input font-serif text-sm leading-relaxed resize-none ' +
              (isLocked ? 'bg-gray-50 text-gray-700 cursor-default' : '')
            }
            style={{ minHeight: '60vh' }}
          />
        </div>
      </div>

      {/* Slides — anchored to manuscript paragraphs, with stranded detection */}
      <WorkspaceSlides sermon={sermon} manuscript={manuscript} />

      <WorkspaceDiffModal
        open={diffForIndex !== null}
        onClose={() => setDiffForIndex(null)}
        title={
          diffForIndex !== null && messages[diffForIndex]?.turnNumber
            ? `Diff: turn ${messages[diffForIndex].turnNumber}`
            : 'Manuscript diff'
        }
        beforeText={
          diffForIndex !== null
            ? messages[diffForIndex]?.manuscriptBefore || ''
            : ''
        }
        afterText={
          diffForIndex !== null
            ? messages[diffForIndex]?.manuscriptAfter || ''
            : ''
        }
      />
    </div>
  );
}

// --- small helpers / subcomponents ----------------------------------

function countWords(s) {
  if (!s || !s.trim()) return 0;
  return s.trim().split(/\s+/).length;
}

function ChatBubble({ message, onViewDiff, onRevert }) {
  if (message.kind === 'note') {
    return (
      <div className="text-xs text-gray-600 italic bg-gray-50 border border-gray-200 rounded px-2 py-1">
        {message.content}
      </div>
    );
  }
  const isUser = message.role === 'user';
  const hasResources =
    Array.isArray(message.resourceTitles) && message.resourceTitles.length > 0;
  const isReverted = Boolean(message.reverted);
  return (
    <div
      className={
        'rounded px-3 py-2 text-sm whitespace-pre-wrap ' +
        (isUser
          ? 'bg-umc-50 border border-umc-200 text-umc-900'
          : 'bg-gray-50 border border-gray-200 text-gray-800') +
        (isReverted ? ' opacity-60' : '')
      }
    >
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5 flex items-baseline justify-between gap-2">
        <span>
          {isUser ? 'You' : 'Claude'}
          {isReverted && (
            <span className="ml-2 text-red-700 font-semibold">Reverted</span>
          )}
        </span>
        <span className="flex items-baseline gap-3">
          {onViewDiff && (
            <button
              type="button"
              onClick={onViewDiff}
              className="text-[10px] normal-case tracking-normal text-umc-700 hover:text-umc-900 underline"
              title="Show what changed between this turn's input manuscript and Claude's revised manuscript."
            >
              View diff
            </button>
          )}
          {onRevert && !isReverted && (
            <button
              type="button"
              onClick={onRevert}
              className="text-[10px] normal-case tracking-normal text-red-700 hover:text-red-900 underline"
              title="Restore the manuscript to its state before this turn. The pre-revision version is also saved as a Past Versions snapshot."
            >
              Revert
            </button>
          )}
        </span>
      </div>
      {message.content}
      {hasResources && (
        <div className="mt-1 text-[10px] text-gray-500">
          Resources sent: {message.resourceTitles.join('; ')}
        </div>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"
      aria-hidden="true"
    />
  );
}
