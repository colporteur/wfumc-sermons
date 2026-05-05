import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import TypeaheadSearch from '../components/TypeaheadSearch.jsx';
import {
  fetchVoiceGuide,
  fetchExemplars,
  saveVoiceGuide,
  addExemplar,
  removeExemplar,
  updateExemplarNote,
  reorderExemplars,
} from '../lib/voiceGuide';

// Pastoral Voice Guide editor — settings page that the Sermon Workspace
// will read from on every revision. Two stacked panels:
//
//   1. Voice description — a big textarea where the pastor describes
//      his writing voice (theology, tone, characteristic moves, things
//      to avoid). Plus a soft word-count target.
//
//   2. Exemplars — pinned past sermons whose manuscripts get fed to
//      Claude as voice samples. Add via typeahead, reorder up/down,
//      attach a short note about why it's a good exemplar.
export default function VoiceGuide() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  // Guide row + form state
  const [guide, setGuide] = useState(null);
  const [guideText, setGuideText] = useState('');
  const [wordCount, setWordCount] = useState('');
  const [savingGuide, setSavingGuide] = useState(false);

  // Exemplar list
  const [exemplars, setExemplars] = useState([]);
  const [pendingPick, setPendingPick] = useState(null);
  const [pendingNote, setPendingNote] = useState('');
  const [addingExemplar, setAddingExemplar] = useState(false);
  const [busyExemplarId, setBusyExemplarId] = useState(null);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [noteDraft, setNoteDraft] = useState('');

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const g = await fetchVoiceGuide(user.id);
        if (cancelled) return;
        setGuide(g);
        setGuideText(g?.guide_text || '');
        setWordCount(
          g?.word_count_target == null ? '' : String(g.word_count_target)
        );
        if (g) {
          const ex = await fetchExemplars(g.id);
          if (!cancelled) setExemplars(ex);
        }
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

  const handleSaveGuide = async () => {
    if (!user?.id) return;
    setSavingGuide(true);
    setError(null);
    setSavedAt(null);
    try {
      const saved = await saveVoiceGuide(user.id, {
        guide_text: guideText,
        word_count_target: wordCount,
      });
      setGuide(saved);
      // Refresh exemplars list against the (possibly newly-created)
      // guide ID so the typeahead-add path has something to attach to.
      if (saved?.id && exemplars.length === 0) {
        const ex = await fetchExemplars(saved.id);
        setExemplars(ex);
      }
      setSavedAt(new Date());
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSavingGuide(false);
    }
  };

  const handleAddExemplar = async () => {
    if (!pendingPick) {
      setError('Pick a sermon first.');
      return;
    }
    // Ensure a guide row exists before attaching exemplars to it.
    let g = guide;
    if (!g) {
      try {
        g = await saveVoiceGuide(user.id, {
          guide_text: guideText,
          word_count_target: wordCount,
        });
        setGuide(g);
      } catch (e) {
        setError(e.message || String(e));
        return;
      }
    }
    if (exemplars.some((e) => e.sermon?.id === pendingPick.id)) {
      setError('That sermon is already an exemplar.');
      return;
    }
    setAddingExemplar(true);
    setError(null);
    try {
      const created = await addExemplar({
        guideId: g.id,
        ownerUserId: user.id,
        sermonId: pendingPick.id,
        note: pendingNote,
      });
      setExemplars((prev) => [...prev, created]);
      setPendingPick(null);
      setPendingNote('');
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setAddingExemplar(false);
    }
  };

  const handleRemove = async (ex) => {
    if (!window.confirm(`Remove "${ex.sermon?.title || 'this exemplar'}" from your voice exemplars?`)) {
      return;
    }
    setBusyExemplarId(ex.id);
    setError(null);
    try {
      await removeExemplar(ex.id);
      setExemplars((prev) => prev.filter((e) => e.id !== ex.id));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyExemplarId(null);
    }
  };

  const handleSaveNote = async (ex) => {
    setBusyExemplarId(ex.id);
    setError(null);
    try {
      const updated = await updateExemplarNote(ex.id, noteDraft);
      setExemplars((prev) =>
        prev.map((e) => (e.id === ex.id ? updated : e))
      );
      setEditingNoteId(null);
      setNoteDraft('');
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyExemplarId(null);
    }
  };

  const move = async (idx, dir) => {
    const next = [...exemplars];
    const tgt = idx + dir;
    if (tgt < 0 || tgt >= next.length) return;
    [next[idx], next[tgt]] = [next[tgt], next[idx]];
    setExemplars(next);
    try {
      await reorderExemplars(next.map((e) => e.id));
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  if (loading) return <LoadingSpinner label="Loading voice guide…" />;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link to="/settings" className="text-sm text-gray-500 hover:text-gray-700">
          ← Settings
        </Link>
        <h1 className="font-serif text-2xl text-umc-900 mt-2">
          Pastoral voice guide
        </h1>
        <p className="text-sm text-gray-600 mt-1">
          Tell Claude how you write. The Sermon Workspace reads this on every
          revision and uses it — together with the pinned exemplar sermons
          below — to keep generated drafts in your voice.
        </p>
      </div>

      {error && (
        <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </p>
      )}

      {/* Voice description */}
      <div className="card space-y-3">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-serif text-lg text-umc-900">
            Voice description
          </h2>
          {savedAt && (
            <span className="text-xs text-green-700">
              Saved {savedAt.toLocaleTimeString()}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500">
          Write in any structure. Useful things to cover: theological
          tradition, sentence rhythm and length, vocabulary you reach for
          and vocabulary you avoid, how you move from text to application,
          tone (warm, plain, scholarly, conversational), how long
          paragraphs tend to be, whether you use questions, what you
          never want to do (e.g. "don't moralize," "don't end on a tidy
          bow").
        </p>
        <textarea
          value={guideText}
          onChange={(e) => setGuideText(e.target.value)}
          rows={14}
          className="input w-full text-sm font-serif leading-relaxed"
          placeholder={`Examples:\n- Wesleyan / Methodist; quadrilateral as background, not foreground.\n- Sentences vary in length; favor concrete nouns over abstractions.\n- Move from text → image → "what would it mean for us this week" → benediction.\n- Avoid clichés like "let us pray that we may…" Avoid unmotivated repetition.\n- Tone: warm, pastoral, occasionally wry. Never preachy.`}
        />
        <div className="flex items-center justify-between gap-3">
          <label className="text-xs text-gray-600 flex items-center gap-2">
            Target word count (optional)
            <input
              type="number"
              min="0"
              step="50"
              value={wordCount}
              onChange={(e) => setWordCount(e.target.value)}
              className="input w-24 text-sm"
              placeholder="e.g. 2200"
            />
          </label>
          <button
            type="button"
            onClick={handleSaveGuide}
            disabled={savingGuide}
            className="btn-primary text-sm disabled:opacity-50"
          >
            {savingGuide ? 'Saving…' : 'Save voice guide'}
          </button>
        </div>
      </div>

      {/* Exemplars */}
      <div className="card space-y-3">
        <div>
          <h2 className="font-serif text-lg text-umc-900">Voice exemplars</h2>
          <p className="text-xs text-gray-500 mt-1">
            Pin two or three past sermons whose voice you want Claude to
            imitate. The full manuscripts are sent on every revision, so
            keep the list short — three is a good upper bound.
          </p>
        </div>

        {exemplars.length === 0 ? (
          <p className="text-sm text-gray-500 italic">
            No exemplars pinned yet. Use the search below to add one.
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {exemplars.map((ex, idx) => {
              const busy = busyExemplarId === ex.id;
              const editing = editingNoteId === ex.id;
              const noManuscript = !ex.sermon?.manuscript_text?.trim();
              return (
                <li key={ex.id} className="py-3 flex items-start gap-3">
                  <div className="flex flex-col gap-1 pt-0.5 text-gray-400 text-xs">
                    <button
                      type="button"
                      onClick={() => move(idx, -1)}
                      disabled={idx === 0 || busy}
                      className="hover:text-gray-700 disabled:opacity-30"
                      title="Move up"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() => move(idx, 1)}
                      disabled={idx === exemplars.length - 1 || busy}
                      className="hover:text-gray-700 disabled:opacity-30"
                      title="Move down"
                    >
                      ▼
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm">
                      <Link
                        to={`/sermons/${ex.sermon?.id}`}
                        className="text-umc-700 hover:text-umc-900 underline font-medium"
                      >
                        {ex.sermon?.title || '(untitled sermon)'}
                      </Link>
                      {ex.sermon?.scripture_reference && (
                        <span className="text-gray-500 text-xs ml-2">
                          {ex.sermon.scripture_reference}
                        </span>
                      )}
                    </p>
                    {noManuscript && (
                      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1 inline-block">
                        ⚠ This sermon has no manuscript text — Claude won't
                        learn voice from it. Add a manuscript or pick a
                        different exemplar.
                      </p>
                    )}
                    {editing ? (
                      <div className="mt-1 flex flex-col gap-1">
                        <input
                          type="text"
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          placeholder="Why is this a good exemplar?"
                          className="input text-xs w-full"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => handleSaveNote(ex)}
                            disabled={busy}
                            className="text-xs text-umc-700 hover:text-umc-900 underline"
                          >
                            Save note
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingNoteId(null);
                              setNoteDraft('');
                            }}
                            className="text-xs text-gray-500 hover:text-gray-800"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap items-center gap-2">
                        {ex.note ? (
                          <span className="italic">"{ex.note}"</span>
                        ) : (
                          <span className="italic text-gray-400">No note</span>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setEditingNoteId(ex.id);
                            setNoteDraft(ex.note || '');
                          }}
                          className="text-gray-500 hover:text-umc-700 underline"
                        >
                          Edit
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemove(ex)}
                    disabled={busy}
                    className="text-xs text-red-600 hover:text-red-800 underline disabled:opacity-40"
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Add new exemplar */}
        <div className="border-t border-gray-100 pt-3 space-y-2">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            Add an exemplar
          </p>
          <TypeaheadSearch
            table="sermons"
            selectColumns="id, title, scripture_reference, manuscript_text"
            searchColumns="title,scripture_reference"
            labelFor={(r) => r.title || '(untitled)'}
            subLabelFor={(r) =>
              r.scripture_reference
                ? r.scripture_reference +
                  (r.manuscript_text?.trim() ? '' : ' — no manuscript')
                : r.manuscript_text?.trim()
                ? ''
                : 'no manuscript'
            }
            excludeIds={new Set(exemplars.map((e) => e.sermon?.id).filter(Boolean))}
            onPick={setPendingPick}
            placeholder="Search a past sermon by title or scripture…"
          />
          {pendingPick && (
            <div className="rounded border border-umc-200 bg-umc-50/40 px-3 py-2 space-y-2">
              <p className="text-sm text-umc-900">
                Selected: <span className="font-medium">{pendingPick.title || '(untitled)'}</span>
                {pendingPick.scripture_reference && (
                  <span className="text-xs text-gray-500 ml-2">
                    {pendingPick.scripture_reference}
                  </span>
                )}
              </p>
              {!pendingPick.manuscript_text?.trim() && (
                <p className="text-xs text-amber-700">
                  Heads up: this sermon has no manuscript text, so Claude
                  won't get any voice signal from it.
                </p>
              )}
              <input
                type="text"
                value={pendingNote}
                onChange={(e) => setPendingNote(e.target.value)}
                placeholder="Optional note: why is this a good exemplar?"
                className="input w-full text-xs"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPendingPick(null);
                    setPendingNote('');
                  }}
                  disabled={addingExemplar}
                  className="text-xs text-gray-600 hover:text-gray-900 underline"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleAddExemplar}
                  disabled={addingExemplar}
                  className="btn-primary text-xs disabled:opacity-50"
                >
                  {addingExemplar ? 'Adding…' : 'Add as exemplar'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
