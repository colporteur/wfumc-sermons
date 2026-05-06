import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import {
  proposeResourceUsage,
  buildMarkersReferenceText,
} from '../lib/claude';
import { loadVoiceGuideForPrompt } from '../lib/voiceGuide';
import { buildResourcesContext } from '../lib/workspaceResources';
import TypeaheadSearch from './TypeaheadSearch.jsx';

// Workspace > "Explore" modal — lets the pastor preview Claude's plan
// for using a resource before committing to a revision turn.
//
// Flow:
//   1. Modal opens with the resource(s) the pastor clicked Explore on.
//   2. First Claude turn: produces a "Where it goes / How it lands"
//      proposal (NOT a revised manuscript).
//   3. Pastor can:
//      - Accept & revise         → close modal, hand instruction +
//                                   resources back to the parent so the
//                                   main revision turn fires.
//      - Refine then revise      → send pastor's feedback, then on the
//                                   next proposal accept-and-revise.
//      - Refine                  → send pastor's feedback, stay in
//                                   explore for another round.
//      - Pair with another       → add another resource via typeahead,
//                                   re-ask Claude with both.
//      - Cancel / Close          → no commitment.
//
// Props:
//   open               - boolean
//   onClose            - close the modal without committing
//   sermon             - the sermon row (manuscript, title, scripture)
//   manuscript         - current manuscript text
//   initialResources   - the resource(s) the pastor opened explore with
//   isLocked           - whether the manuscript is locked (disables the
//                        revise paths and surfaces a hint)
//   onAccept(payload)  - called when the pastor clicks an accept variant.
//                        payload: { instruction, resources }
export default function WorkspaceExploreModal({
  open,
  onClose,
  sermon,
  manuscript,
  initialResources = [],
  isLocked = false,
  onAccept,
}) {
  const { user } = useAuth();

  // Resources currently being explored (the pastor can add via "Pair").
  const [resources, setResources] = useState([]);
  // Conversation: each turn { role: 'user'|'assistant', content }.
  // Only "real" exchanges (proposal + feedback) — the initial anchor
  // is synthesized inside proposeResourceUsage().
  const [history, setHistory] = useState([]);
  // Pastor's draft feedback waiting to be sent.
  const [feedback, setFeedback] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState(null);
  // Tracks whether the next round should "Refine then revise" (auto-
  // accept after Claude's response). Toggled by the button, cleared
  // when consumed.
  const [autoAcceptAfterNext, setAutoAcceptAfterNext] = useState(false);
  // System prompt + markers reference cached after first load.
  const [voicePrompt, setVoicePrompt] = useState('');
  const markers = useMemo(() => buildMarkersReferenceText(), []);
  const [pairOpen, setPairOpen] = useState(false);

  const chatEndRef = useRef(null);

  // Reset all state on open / close so a fresh explore session never
  // inherits a stale conversation.
  useEffect(() => {
    if (!open) return;
    setResources(initialResources || []);
    setHistory([]);
    setFeedback('');
    setError(null);
    setThinking(false);
    setAutoAcceptAfterNext(false);
    setPairOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Lazy-load the voice guide once.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    loadVoiceGuideForPrompt(user.id)
      .then((res) => {
        if (!cancelled) setVoicePrompt(res?.systemPrompt || '');
      })
      .catch(() => {
        /* non-fatal — exploration just runs voice-less */
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Auto-scroll the chat to bottom on every new turn.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [history, thinking]);

  // Run a Claude turn. If `auto` is true and the response comes back
  // successfully, immediately fire onAccept with the latest assistant
  // text as the instruction (the "Refine then revise" path).
  const runProposalTurn = async ({ feedbackText, auto = false }) => {
    if (!sermon?.id) {
      setError('Missing sermon context.');
      return;
    }
    if (resources.length === 0) {
      setError('No resources to explore.');
      return;
    }
    setThinking(true);
    setError(null);

    // Optimistically push the user feedback (if any) into history.
    let workingHistory = history;
    if (feedbackText && feedbackText.trim()) {
      const userTurn = {
        role: 'user',
        content: feedbackText.trim(),
        ts: Date.now(),
      };
      workingHistory = [...history, userTurn];
      setHistory(workingHistory);
      setFeedback('');
    }

    try {
      const text = await proposeResourceUsage({
        sermon,
        manuscript: manuscript || '',
        voiceSystemPrompt: voicePrompt,
        markersReference: markers,
        resourcesContext: buildResourcesContext(resources),
        history: workingHistory.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        feedback: '',
      });
      const assistantTurn = {
        role: 'assistant',
        content: text || '(no proposal returned)',
        ts: Date.now(),
      };
      const finalHistory = [...workingHistory, assistantTurn];
      setHistory(finalHistory);

      if (auto) {
        // Refine-then-revise path: hand the just-received proposal to
        // the parent as the revision instruction.
        commit(text, resources);
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setThinking(false);
      setAutoAcceptAfterNext(false);
    }
  };

  // Build the instruction for the parent's revision call from the
  // accepted proposal text + the explored resources.
  const commit = (proposalText, paired) => {
    const instruction =
      'Apply this plan to the manuscript:\n\n' +
      proposalText.trim() +
      '\n\n(The resources below have been attached for this turn.)';
    onAccept({ instruction, resources: paired });
    onClose();
  };

  // The most-recent assistant proposal, or null if none yet.
  const latestProposal = useMemo(() => {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'assistant') return history[i].content;
    }
    return null;
  }, [history]);

  // First proposal kicks in automatically on open (once per modal open).
  const firstRunDone = useRef(false);
  useEffect(() => {
    if (!open) {
      firstRunDone.current = false;
      return;
    }
    if (firstRunDone.current) return;
    if (resources.length === 0) return;
    firstRunDone.current = true;
    // Small delay so the modal renders the empty state first, then
    // shows the loading indicator.
    const t = setTimeout(() => runProposalTurn({}), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resources.length]);

  if (!open) return null;

  const canAccept = !!latestProposal && !thinking;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-stretch sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-3xl sm:rounded-lg shadow-xl flex flex-col max-h-screen sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-200 flex items-baseline justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="font-serif text-lg text-umc-900 truncate">
              Explore resource use
            </h2>
            <p className="text-xs text-gray-500 mt-0.5 truncate">
              {resources.length === 0
                ? 'No resources selected'
                : resources
                    .map((r) => r.title || '(untitled)')
                    .join(' · ')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-sm"
          >
            Close
          </button>
        </div>

        {/* Body — chat thread */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3 bg-gray-50">
          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
              {error}
            </p>
          )}

          {history.length === 0 && !thinking && (
            <p className="text-sm text-gray-500 italic">
              Claude is about to read the manuscript and the resource(s)
              and propose how to use them. The proposal is a short plan
              you'll see below — accept it to fire a normal revision
              turn, or refine it first.
            </p>
          )}

          {history.map((m, i) => (
            <ChatBubble key={i} message={m} />
          ))}

          {thinking && (
            <div className="text-sm text-gray-500 italic flex items-center gap-2">
              <Spinner /> Claude is thinking…
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        {/* Pair-with-another inline picker */}
        {pairOpen && (
          <div className="px-5 py-3 border-t border-gray-200 bg-umc-50/40 space-y-2">
            <p className="text-xs uppercase tracking-wide text-umc-700">
              Pair with another resource
            </p>
            <TypeaheadSearch
              table="resources"
              selectColumns="id, title, content, resource_type, scripture_refs, themes, tone, source"
              searchColumns="title,content,scripture_refs"
              labelFor={(r) => r.title || '(untitled)'}
              subLabelFor={(r) => r.scripture_refs || ''}
              excludeIds={new Set(resources.map((r) => r.id))}
              onPick={(r) => {
                if (!r) return;
                setResources((prev) => [...prev, r]);
                setPairOpen(false);
                // Re-ask Claude with the new resource included.
                setTimeout(() => runProposalTurn({}), 50);
              }}
              placeholder="Pick a second resource to pair with…"
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setPairOpen(false)}
                className="text-xs text-gray-500 hover:text-gray-800 underline"
              >
                Cancel pairing
              </button>
            </div>
          </div>
        )}

        {/* Composer + actions */}
        <div className="px-5 py-3 border-t border-gray-200 space-y-2 shrink-0">
          {isLocked && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
              🔒 The manuscript is locked. Accept-and-revise paths will
              ask you to unlock first.
            </p>
          )}
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            placeholder="Optional feedback to refine the proposal — e.g. 'too early; try after the second illustration.'"
            disabled={thinking}
            className="input w-full text-sm font-serif disabled:bg-gray-50"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-gray-500">
              {resources.length} resource
              {resources.length === 1 ? '' : 's'} ·{' '}
              {history.filter((m) => m.role === 'assistant').length}{' '}
              proposal
              {history.filter((m) => m.role === 'assistant').length === 1
                ? ''
                : 's'}{' '}
              so far
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setPairOpen((v) => !v)}
                disabled={thinking}
                className="btn-secondary text-xs disabled:opacity-50"
                title="Add another resource and re-ask Claude."
              >
                + Pair with another
              </button>
              <button
                type="button"
                onClick={() => runProposalTurn({ feedbackText: feedback })}
                disabled={thinking || !feedback.trim()}
                className="btn-secondary text-xs disabled:opacity-50"
                title="Send feedback and stay in explore for another round."
              >
                Refine
              </button>
              <button
                type="button"
                onClick={() =>
                  runProposalTurn({ feedbackText: feedback, auto: true })
                }
                disabled={thinking || !feedback.trim() || isLocked}
                className="btn-secondary text-xs disabled:opacity-50"
                title={
                  isLocked
                    ? 'Unlock the manuscript first.'
                    : 'Send feedback, then commit to a revision after Claude responds.'
                }
              >
                Refine then revise
              </button>
              <button
                type="button"
                onClick={() =>
                  latestProposal && commit(latestProposal, resources)
                }
                disabled={!canAccept || isLocked}
                className="btn-primary text-xs disabled:opacity-50"
                title={
                  isLocked
                    ? 'Unlock the manuscript first.'
                    : 'Close this dialog and fire a revision turn using the proposal above.'
                }
              >
                ✓ Accept &amp; revise
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }) {
  const isUser = message.role === 'user';
  return (
    <div
      className={
        'rounded px-3 py-2 text-sm whitespace-pre-wrap font-serif leading-relaxed ' +
        (isUser
          ? 'bg-umc-50 border border-umc-200 text-umc-900'
          : 'bg-white border border-gray-200 text-gray-800')
      }
    >
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5 not-italic font-sans">
        {isUser ? 'You' : 'Claude'}
      </div>
      {message.content}
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
