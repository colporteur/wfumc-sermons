import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { supabase, withTimeout } from '../lib/supabase';
import {
  pairScriptureWithResource,
  buildMarkersReferenceText,
} from '../lib/claude';
import { loadVoiceGuideForPrompt } from '../lib/voiceGuide';
import {
  createStashedBlock,
  setPendingBlockForSermon,
} from '../lib/sermonStashedBlocks';
import TypeaheadSearch from './TypeaheadSearch.jsx';

// Modal opened from a "✨ Pair with Scripture" button on Resource
// Detail. Walks the pastor through:
//
//   1. Generate — pick scripture + block type + length, click Generate.
//   2. Review — Claude returns a self-contained block; pastor sees it
//      with three landing options:
//        - Copy to clipboard
//        - Start new sermon with this  → creates a sermon row whose
//          manuscript_text IS the block, navigates to its workspace
//        - Add to existing sermon...   → typeahead picker, lock-aware
//          second step (locked → stash only; unlocked → stash OR
//          open in workspace with block pre-filled in the chat).
//
// Stashing creates a sermon_stashed_blocks row attached to the chosen
// sermon. The stashed-blocks card on SermonDetail / SermonWorkspace
// surfaces it next time the sermon is opened.
const BLOCK_TYPES = [
  { value: 'free_form', label: 'Free-form (decide later)' },
  { value: 'opening', label: 'Opening' },
  { value: 'illustration', label: 'Illustration' },
  { value: 'exegesis_application', label: 'Exegesis with application' },
  { value: 'closing', label: 'Closing' },
];
const LENGTH_OPTIONS = [
  { value: 150, label: 'Short (~150 words)' },
  { value: 300, label: 'Medium (~300 words)' },
  { value: 500, label: 'Long (~500 words)' },
];

export default function PairWithScriptureModal({
  open,
  onClose,
  resource,
}) {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Step state: 'form' | 'block' | 'pickSermon' | 'pickedSermon'
  const [step, setStep] = useState('form');
  const [scripture, setScripture] = useState('');
  const [blockType, setBlockType] = useState('free_form');
  const [lengthTarget, setLengthTarget] = useState(300);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState(null);
  const [block, setBlock] = useState('');
  const [pickedSermon, setPickedSermon] = useState(null);
  const [persisting, setPersisting] = useState(false);
  const [copyState, setCopyState] = useState('idle'); // idle | copied | error

  if (!open) return null;

  const handleClose = () => {
    setStep('form');
    setScripture('');
    setBlockType('free_form');
    setLengthTarget(300);
    setThinking(false);
    setError(null);
    setBlock('');
    setPickedSermon(null);
    setPersisting(false);
    setCopyState('idle');
    onClose();
  };

  const handleGenerate = async () => {
    if (!scripture.trim()) {
      setError('Pick a scripture reference to pair with.');
      return;
    }
    setThinking(true);
    setError(null);
    try {
      const voice = user?.id
        ? await loadVoiceGuideForPrompt(user.id).catch(() => ({
            systemPrompt: '',
          }))
        : { systemPrompt: '' };
      const text = await pairScriptureWithResource({
        resource,
        scripture: scripture.trim(),
        blockType,
        lengthTarget,
        voiceSystemPrompt: voice?.systemPrompt || '',
        markersReference: buildMarkersReferenceText(),
      });
      if (!text) throw new Error('Claude returned an empty block.');
      setBlock(text);
      setStep('block');
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setThinking(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(block);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 2000);
    }
  };

  const handleStartNewSermon = async () => {
    if (!user?.id) return;
    setPersisting(true);
    setError(null);
    try {
      // Create a sermon row with the block as its manuscript.
      const guessedTitle =
        (resource?.title ? `${resource.title} — ` : '') + scripture.trim();
      const { data, error: err } = await withTimeout(
        supabase
          .from('sermons')
          .insert({
            owner_user_id: user.id,
            title: guessedTitle.slice(0, 200),
            scripture_reference: scripture.trim(),
            manuscript_text: block,
          })
          .select('id')
          .single()
      );
      if (err) throw err;
      handleClose();
      navigate(`/sermons/${data.id}/workspace`);
    } catch (e) {
      setError(e.message || String(e));
      setPersisting(false);
    }
  };

  const handleStashOnPickedSermon = async () => {
    if (!pickedSermon || !user?.id) return;
    setPersisting(true);
    setError(null);
    try {
      await createStashedBlock({
        sermonId: pickedSermon.id,
        ownerUserId: user.id,
        title:
          (resource?.title ? `${resource.title} · ` : '') + scripture.trim(),
        body: block,
        source: `Pair with Scripture: ${scripture.trim()}`,
        sourceResourceId: resource?.id,
        sourceScripture: scripture.trim(),
      });
      handleClose();
      // Land on the sermon detail so the pastor sees the stashed-
      // blocks card pop up.
      navigate(`/sermons/${pickedSermon.id}`);
    } catch (e) {
      setError(e.message || String(e));
      setPersisting(false);
    }
  };

  const handleOpenInWorkspaceWithBlock = () => {
    if (!pickedSermon) return;
    setPendingBlockForSermon(pickedSermon.id, {
      body: block,
      source: `Pair with Scripture: ${scripture.trim()}`,
      sourceResourceTitle: resource?.title || null,
    });
    handleClose();
    navigate(`/sermons/${pickedSermon.id}/workspace`);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-stretch sm:items-center justify-center p-0 sm:p-4"
      onClick={handleClose}
    >
      <div
        className="bg-white w-full sm:max-w-2xl sm:rounded-lg shadow-xl flex flex-col max-h-screen sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-gray-200 flex items-baseline justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="font-serif text-lg text-umc-900 truncate">
              ✨ Pair with Scripture
            </h2>
            <p className="text-xs text-gray-500 mt-0.5 truncate">
              Resource: {resource?.title || '(untitled)'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-700 text-sm"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </p>
          )}

          {step === 'form' && (
            <FormStep
              scripture={scripture}
              setScripture={setScripture}
              blockType={blockType}
              setBlockType={setBlockType}
              lengthTarget={lengthTarget}
              setLengthTarget={setLengthTarget}
              thinking={thinking}
              onGenerate={handleGenerate}
              onCancel={handleClose}
            />
          )}

          {step === 'block' && (
            <BlockReviewStep
              block={block}
              copyState={copyState}
              persisting={persisting}
              onCopy={handleCopy}
              onStartNewSermon={handleStartNewSermon}
              onPickExisting={() => setStep('pickSermon')}
              onRegenerate={() => setStep('form')}
              onCancel={handleClose}
            />
          )}

          {step === 'pickSermon' && (
            <PickSermonStep
              onPick={(s) => {
                setPickedSermon(s);
                setStep('pickedSermon');
              }}
              onBack={() => setStep('block')}
            />
          )}

          {step === 'pickedSermon' && pickedSermon && (
            <PickedSermonStep
              sermon={pickedSermon}
              persisting={persisting}
              onStash={handleStashOnPickedSermon}
              onOpenInWorkspace={handleOpenInWorkspaceWithBlock}
              onBack={() => {
                setPickedSermon(null);
                setStep('pickSermon');
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Step components
// =====================================================================

function FormStep({
  scripture,
  setScripture,
  blockType,
  setBlockType,
  lengthTarget,
  setLengthTarget,
  thinking,
  onGenerate,
  onCancel,
}) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-600">
        Pick a scripture reference and Claude will pair it with this
        resource to generate a self-contained sermon block in your
        voice. The block can stand alone or be woven into a longer
        sermon later.
      </p>

      <label className="block text-sm">
        <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
          Scripture reference
        </span>
        <input
          type="text"
          value={scripture}
          onChange={(e) => setScripture(e.target.value)}
          placeholder="e.g. Acts 17:22-31"
          className="input w-full"
          autoFocus
        />
      </label>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
            Block type
          </span>
          <select
            value={blockType}
            onChange={(e) => setBlockType(e.target.value)}
            className="input w-full"
          >
            {BLOCK_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="block text-xs uppercase tracking-wide text-gray-500 mb-1">
            Length
          </span>
          <select
            value={String(lengthTarget)}
            onChange={(e) => setLengthTarget(Number(e.target.value))}
            className="input w-full"
          >
            {LENGTH_OPTIONS.map((l) => (
              <option key={l.value} value={String(l.value)}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-xs text-gray-500 italic">
        Heads up: a block generated cold doesn't know an existing
        sermon's tone or arc. It's a starting point; expect to refine
        through the normal revision loop after insertion.
      </p>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={thinking}
          className="btn-secondary text-sm"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onGenerate}
          disabled={thinking || !scripture.trim()}
          className="btn-primary text-sm disabled:opacity-50"
        >
          {thinking ? 'Generating…' : 'Generate'}
        </button>
      </div>
    </div>
  );
}

function BlockReviewStep({
  block,
  copyState,
  persisting,
  onCopy,
  onStartNewSermon,
  onPickExisting,
  onRegenerate,
  onCancel,
}) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
          Generated block
        </p>
        <div className="bg-gray-50 border border-gray-200 rounded p-3 max-h-96 overflow-y-auto whitespace-pre-wrap font-serif text-sm leading-relaxed text-gray-800">
          {block}
        </div>
      </div>
      <p className="text-[10px] text-gray-500">
        Three landing options — pick the one that fits.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <button
          type="button"
          onClick={onCopy}
          disabled={persisting}
          className="btn-secondary text-xs disabled:opacity-50"
        >
          {copyState === 'copied'
            ? '✓ Copied!'
            : copyState === 'error'
              ? 'Copy failed'
              : '📋 Copy to clipboard'}
        </button>
        <button
          type="button"
          onClick={onStartNewSermon}
          disabled={persisting}
          className="btn-secondary text-xs disabled:opacity-50"
        >
          {persisting ? 'Working…' : '+ Start new sermon'}
        </button>
        <button
          type="button"
          onClick={onPickExisting}
          disabled={persisting}
          className="btn-secondary text-xs disabled:opacity-50"
        >
          → Add to existing sermon…
        </button>
      </div>
      <div className="flex items-center justify-between pt-1 text-xs">
        <button
          type="button"
          onClick={onRegenerate}
          disabled={persisting}
          className="text-gray-600 hover:text-gray-900 underline"
        >
          ← Regenerate with different settings
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={persisting}
          className="text-gray-500 hover:text-gray-800 underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function PickSermonStep({ onPick, onBack }) {
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm text-gray-700 mb-2">
          Pick the existing sermon to add this block to.
        </p>
        <TypeaheadSearch
          table="sermons"
          selectColumns="id, title, scripture_reference, manuscript_locked, manuscript_locked_at"
          searchColumns="title,scripture_reference"
          labelFor={(r) => r.title || '(untitled)'}
          subLabelFor={(r) =>
            (r.scripture_reference || '') +
            (r.manuscript_locked ? ' · 🔒 locked' : '')
          }
          onPick={onPick}
          placeholder="Search by title or scripture…"
        />
      </div>
      <div className="flex justify-between text-xs">
        <button
          type="button"
          onClick={onBack}
          className="text-gray-600 hover:text-gray-900 underline"
        >
          ← Back to block
        </button>
      </div>
    </div>
  );
}

function PickedSermonStep({
  sermon,
  persisting,
  onStash,
  onOpenInWorkspace,
  onBack,
}) {
  const isLocked = sermon.manuscript_locked === true;
  return (
    <div className="space-y-4">
      <div className="rounded border border-gray-200 bg-gray-50 px-3 py-2">
        <p className="text-[10px] uppercase tracking-wide text-gray-500">
          Target sermon
        </p>
        <p className="text-sm font-medium text-umc-900">
          {sermon.title || '(untitled)'}
        </p>
        {sermon.scripture_reference && (
          <p className="text-xs text-gray-500 mt-0.5">
            {sermon.scripture_reference}
          </p>
        )}
        {isLocked && (
          <p className="text-xs text-umc-700 mt-1">
            🔒 Locked — only stashing is available.
          </p>
        )}
      </div>

      {isLocked ? (
        <div className="space-y-2">
          <p className="text-sm text-gray-700">
            This sermon is locked, so the block will be{' '}
            <strong>stashed for next preaching</strong>. It'll appear in
            the sermon's "Stashed for next preaching" card the next time
            you open it; nothing in the locked manuscript is touched.
          </p>
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onBack}
              disabled={persisting}
              className="btn-secondary text-sm"
            >
              ← Pick a different sermon
            </button>
            <button
              type="button"
              onClick={onStash}
              disabled={persisting}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {persisting ? 'Stashing…' : '📌 Stash for next preaching'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-gray-700">
            Two ways to add this block:
          </p>
          <ul className="text-xs text-gray-600 space-y-1 list-disc list-inside">
            <li>
              <strong>Stash for next preaching</strong> — saves the block
              to the sermon's "Stashed for next preaching" card. Nothing
              in the manuscript changes; you decide later when (or
              whether) to weave it in.
            </li>
            <li>
              <strong>Open in Workspace</strong> — opens the sermon's
              Workspace with the block pre-filled in the chat composer
              as a "weave this in" instruction. Send to Claude when
              you're ready.
            </li>
          </ul>
          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onBack}
              disabled={persisting}
              className="btn-secondary text-sm"
            >
              ← Pick different
            </button>
            <button
              type="button"
              onClick={onStash}
              disabled={persisting}
              className="btn-secondary text-sm disabled:opacity-50"
            >
              {persisting ? 'Stashing…' : '📌 Stash for next preaching'}
            </button>
            <button
              type="button"
              onClick={onOpenInWorkspace}
              disabled={persisting}
              className="btn-primary text-sm disabled:opacity-50"
            >
              ↗ Open in Workspace with block
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
