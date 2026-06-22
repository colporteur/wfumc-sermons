import { useState } from 'react';
import { getElementLabel, supportsInsertSentence } from '../lib/worshipElements';
import InsertScriptureSentencePanel from './InsertScriptureSentencePanel.jsx';

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
