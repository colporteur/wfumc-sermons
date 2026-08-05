import { useState } from 'react';
import { getElementLabel, supportsInsertSentence } from '../lib/worshipElements';
import InsertScriptureSentencePanel from './InsertScriptureSentencePanel.jsx';
import { pickCallToWorshipVerse, finishCongregationalPrayer } from '../lib/claude';
import { listRecentLiturgies, fetchAnnouncementsBody } from '../lib/liturgyOps';
import { loadVoiceGuideForPrompt } from '../lib/voiceGuide';
import { useAuth } from '../contexts/AuthContext.jsx';

// The standard closing lines Todd speaks after the call-to-worship
// verse. The blank is filled in by hand each week with the prelude
// title. Edit here if the pianist changes.
const PRELUDE_LINE =
  "Karen's prelude today will be _______________. Let us worship God";

// One element in the liturgy detail page. Renders the element label +
// body, with click-to-edit, reorder arrows, delete, "Send to bulletin"
// (existing flow), and "Send to new liturgy" (new flow).
//
// Phase B will add ✨ Draft / 💡 Brainstorm buttons here. For now
// those slots are empty.
//
// Props:
//   element            - the row from sermon_liturgy_sections
//   isFirst / isLast   - whether this is the top/bottom element (affects arrow disable)
//   busy               - parent-level busy flag (saving, etc.)
//   onSaveBody         - async (elementId, newBody, newTitle?) => void
//   onDelete           - async (elementId) => void
//   onMoveUp           - async (element) => void
//   onMoveDown         - async (element) => void
//   onSendToBulletin   - (element) => void  (opens existing send modal)
//   onSendToNewLiturgy - async (element) => void
//   onDraftClaude      - (element) => void   (opens Claude draft modal)
//   onBrainstormClaude - (element) => void   (opens Claude brainstorm modal)
//   scriptureRefs      - string passed down for the Insert Sentence panel
export default function LiturgyElementRow({
  element,
  isFirst,
  isLast,
  busy,
  onSaveBody,
  onDelete,
  onMoveUp,
  onMoveDown,
  onSendToBulletin,
  onSendToNewLiturgy,
  onDraftClaude,
  onBrainstormClaude,
  scriptureRefs = '',
}) {
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(element.body || '');
  const [draftTitle, setDraftTitle] = useState(element.title || '');
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  const label = getElementLabel(element.section_kind);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSaveBody(element.id, draftBody, draftTitle);
      setEditing(false);
    } catch (e) {
      window.alert(e.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraftBody(element.body || '');
    setDraftTitle(element.title || '');
    setEditing(false);
  };

  const handleDelete = async () => {
    if (
      !window.confirm(
        `Delete the "${label}" element from this liturgy? This cannot be undone.`
      )
    )
      return;
    try {
      await onDelete(element.id);
    } catch (e) {
      window.alert(e.message || String(e));
    }
  };

  // Append a sentence to the current edit-draft body. Two spaces of
  // separation if there's already body content; otherwise drop it in
  // raw.
  const handleInsertSentence = (sentence) => {
    setDraftBody((prev) => {
      const cur = (prev || '').trim();
      return cur ? cur + ' ' + sentence : sentence;
    });
  };

  // Call to Worship quick-build: ask Claude for the single best verse
  // from the day's scripture, then lay it out with the standard
  // prelude line underneath. Replaces the draft body (with a confirm
  // if there's already text there).
  const [buildingCtw, setBuildingCtw] = useState(false);
  const [ctwError, setCtwError] = useState(null);
  const handleBuildCallToWorship = async () => {
    if (
      draftBody.trim() &&
      !window.confirm('Replace the current Call to Worship text?')
    ) {
      return;
    }
    setBuildingCtw(true);
    setCtwError(null);
    try {
      const { sentence, reference } = await pickCallToWorshipVerse(scriptureRefs);
      const verseLine = reference ? `${sentence} (${reference})` : sentence;
      setDraftBody(verseLine + '\n\n' + PRELUDE_LINE);
    } catch (e) {
      setCtwError(e.message || String(e));
    } finally {
      setBuildingCtw(false);
    }
  };

  // Congregational Prayer: finish what the pastor started. His text is
  // preserved verbatim and continued in his voice, always landing on a
  // transition into the Lord's Prayer.
  const [finishingPrayer, setFinishingPrayer] = useState(false);
  const [prayerError, setPrayerError] = useState(null);
  const handleFinishPrayer = async () => {
    setFinishingPrayer(true);
    setPrayerError(null);
    try {
      let voicePrompt = '';
      try {
        const v = await loadVoiceGuideForPrompt(user?.id);
        voicePrompt = v?.systemPrompt || '';
      } catch {
        /* voice guide is a nicety, not a requirement */
      }
      const finished = await finishCongregationalPrayer({
        partial: draftBody,
        scriptureRefs,
        voiceSystemPrompt: voicePrompt,
      });
      setDraftBody(finished);
    } catch (e) {
      setPrayerError(e.message || String(e));
    } finally {
      setFinishingPrayer(false);
    }
  };

  // Announcements: inherit from a previous liturgy as a starting
  // point. Recent liturgies load when the pastor opens the picker;
  // choosing one copies its Announcements body into the draft
  // (confirm before replacing existing text).
  const [inheritList, setInheritList] = useState(null); // null = not loaded
  const [inheritLoading, setInheritLoading] = useState(false);
  const [inheritError, setInheritError] = useState(null);
  const handleLoadInheritList = async () => {
    if (inheritList || inheritLoading) return;
    setInheritLoading(true);
    setInheritError(null);
    try {
      const rows = await listRecentLiturgies({ excludeId: element.liturgy_id });
      setInheritList(rows);
      if (!rows.length) setInheritError('No other liturgies found.');
    } catch (e) {
      setInheritError(e.message || String(e));
    } finally {
      setInheritLoading(false);
    }
  };
  const handleInheritFrom = async (liturgyId) => {
    if (!liturgyId) return;
    if (
      draftBody.trim() &&
      !window.confirm('Replace the current announcements text with the copied one?')
    ) {
      return;
    }
    setInheritLoading(true);
    setInheritError(null);
    try {
      const body = await fetchAnnouncementsBody(liturgyId);
      if (!body) {
        setInheritError('That liturgy has no announcements text.');
      } else {
        setDraftBody(body);
      }
    } catch (e) {
      setInheritError(e.message || String(e));
    } finally {
      setInheritLoading(false);
    }
  };

  const handleSendToNew = async () => {
    if (
      !window.confirm(
        `Create a new draft liturgy containing this "${label}" element?`
      )
    )
      return;
    setSending(true);
    try {
      await onSendToNewLiturgy(element);
    } catch (e) {
      window.alert(e.message || String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <li className="border-t border-gray-100 pt-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-2">
        <div className="min-w-0 flex items-baseline gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wide text-gray-500 shrink-0">
            {label}
          </span>
          {!editing && element.title && element.title !== label && (
            <span className="font-serif text-base text-umc-900 truncate">
              {element.title}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs shrink-0">
          {/* Reorder */}
          <button
            type="button"
            onClick={() => onMoveUp(element)}
            disabled={isFirst || busy}
            className="text-gray-500 hover:text-gray-800 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            onClick={() => onMoveDown(element)}
            disabled={isLast || busy}
            className="text-gray-500 hover:text-gray-800 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Move down"
          >
            ↓
          </button>
          <span className="text-gray-300">·</span>
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-umc-700 hover:text-umc-900 underline"
            >
              Edit
            </button>
          )}
          {onDraftClaude && (
            <button
              type="button"
              onClick={() => onDraftClaude(element)}
              disabled={busy}
              className="text-umc-700 hover:text-umc-900 underline whitespace-nowrap disabled:opacity-50"
              title="Draft this element with Claude"
            >
              ✨ Draft
            </button>
          )}
          {onBrainstormClaude && (
            <button
              type="button"
              onClick={() => onBrainstormClaude(element)}
              disabled={busy}
              className="text-umc-700 hover:text-umc-900 underline whitespace-nowrap disabled:opacity-50"
              title="Brainstorm 4–6 short ideas for this element"
            >
              💡 Brainstorm
            </button>
          )}
          {onSendToBulletin && (
            <>
              <button
                type="button"
                onClick={() => onSendToBulletin(element)}
                className="text-umc-700 hover:text-umc-900 underline whitespace-nowrap"
                title="Send this element to a draft or upcoming bulletin"
              >
                → Bulletin
              </button>
            </>
          )}
          <button
            type="button"
            onClick={handleSendToNew}
            disabled={sending || busy}
            className="text-umc-700 hover:text-umc-900 underline whitespace-nowrap disabled:opacity-50"
            title="Create a new liturgy that includes this element"
          >
            {sending ? '…' : '→ New liturgy'}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={busy}
            className="text-red-600 hover:text-red-800 underline disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>

      {editing ? (
        <div className="space-y-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              Title (optional — defaults to element type)
            </label>
            <input
              className="input w-full text-sm"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder={label}
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              Body
            </label>
            <textarea
              className="input w-full font-serif text-sm leading-relaxed min-h-[120px]"
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder={`Write the ${label.toLowerCase()} text…`}
            />
          </div>
          {element.section_kind === 'call_to_worship' && scriptureRefs && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleBuildCallToWorship}
                disabled={buildingCtw || saving}
                className="btn-secondary text-xs disabled:opacity-50"
                title={`Pick the best single verse from ${scriptureRefs} for a one-sentence call to worship, and lay it out with the prelude line underneath.`}
              >
                {buildingCtw ? 'Choosing a verse…' : '✨ Build from scripture'}
              </button>
              {ctwError && (
                <span className="text-xs text-red-700">{ctwError}</span>
              )}
            </div>
          )}
          {element.section_kind === 'announcements' && (
            <div className="flex flex-wrap items-center gap-2">
              {inheritList === null ? (
                <button
                  type="button"
                  onClick={handleLoadInheritList}
                  disabled={inheritLoading || saving}
                  className="btn-secondary text-xs disabled:opacity-50"
                  title="Copy the announcements from a previous liturgy as this week's starting point, then edit."
                >
                  {inheritLoading ? 'Loading…' : '📋 Inherit from previous liturgy'}
                </button>
              ) : (
                <select
                  className="input text-xs py-1 w-auto max-w-xs"
                  defaultValue=""
                  disabled={inheritLoading || saving}
                  onChange={(e) => handleInheritFrom(e.target.value)}
                  title="Pick the liturgy to copy announcements from."
                >
                  <option value="" disabled>
                    {inheritLoading ? 'Copying…' : 'Copy announcements from…'}
                  </option>
                  {inheritList.map((l) => (
                    <option key={l.id} value={l.id}>
                      {(l.used_at ? `${l.used_at} — ` : '') + (l.title || '(untitled)')}
                    </option>
                  ))}
                </select>
              )}
              {inheritError && (
                <span className="text-xs text-red-700">{inheritError}</span>
              )}
            </div>
          )}
          {element.section_kind === 'congregational_prayer' && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleFinishPrayer}
                disabled={finishingPrayer || saving || !draftBody.trim()}
                className="btn-secondary text-xs disabled:opacity-50"
                title={
                  !draftBody.trim()
                    ? 'Start the prayer above — this finishes what you begin.'
                    : "Keep your opening word-for-word, carry it through in your voice, and land on the transition into the Lord's Prayer."
                }
              >
                {finishingPrayer ? 'Finishing…' : '✨ Finish this prayer'}
              </button>
              {prayerError && (
                <span className="text-xs text-red-700">{prayerError}</span>
              )}
            </div>
          )}
          {supportsInsertSentence(element.section_kind) && scriptureRefs && (
            <InsertScriptureSentencePanel
              scriptureRefs={scriptureRefs}
              onInsert={handleInsertSentence}
            />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              onClick={handleCancel}
              disabled={saving}
              className="btn-secondary text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : element.body ? (
        <p className="text-sm text-gray-800 whitespace-pre-wrap font-serif leading-relaxed">
          {element.body}
        </p>
      ) : (
        <p className="text-sm text-gray-400 italic">
          (Empty — click Edit to write or use Claude to draft.)
        </p>
      )}
    </li>
  );
}
