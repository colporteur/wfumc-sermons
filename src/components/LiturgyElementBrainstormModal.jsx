import { useEffect, useState } from 'react';
import { brainstormLiturgyElement } from '../lib/claude';
import {
  loadInstructionsForElement,
  saveInstructionsForElement,
  ensureLiturgyTheme,
} from '../lib/liturgyInstructions';
import { getElementLabel } from '../lib/worshipElements';

// Brainstorm variant of LiturgyElementDraftModal — same inputs, but
// instead of a single polished draft, Claude returns 4–6 short idea
// sketches and the pastor can click "Use this" on any one to apply
// it to the element body.
//
// Props mirror LiturgyElementDraftModal.
export default function LiturgyElementBrainstormModal({
  element,
  scriptureRefs,
  linkedSermon: initialSermon,
  ownerUserId,
  onApply,
  onClose,
}) {
  const elementType = element.section_kind;
  const elementLabel = getElementLabel(elementType);

  const [linkedSermon, setLinkedSermon] = useState(initialSermon);
  const [instructions, setInstructions] = useState('');
  const [savedInstructions, setSavedInstructions] = useState('');
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [useTheme, setUseTheme] = useState(true);
  const [theme, setTheme] = useState(initialSermon?.liturgy_theme || '');
  const [ideas, setIdeas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await loadInstructionsForElement(ownerUserId, elementType);
        if (cancelled) return;
        setInstructions(saved);
        setSavedInstructions(saved);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerUserId, elementType]);

  const handleBrainstorm = async () => {
    setGenerating(true);
    setError(null);
    try {
      let resolvedTheme = useTheme ? theme : '';
      if (useTheme && !resolvedTheme && linkedSermon) {
        resolvedTheme = await ensureLiturgyTheme(linkedSermon);
        setTheme(resolvedTheme);
      }

      if (saveAsDefault && instructions !== savedInstructions) {
        await saveInstructionsForElement(
          ownerUserId,
          elementType,
          instructions
        );
        setSavedInstructions(instructions);
      }

      const newIdeas = await brainstormLiturgyElement({
        elementType,
        elementLabel,
        scriptureRefs,
        sermonTheme: resolvedTheme,
        pastorInstructions: instructions,
      });
      setIdeas(newIdeas);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl max-w-3xl w-full my-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-gray-100 flex items-baseline justify-between gap-2">
          <div>
            <h2 className="font-serif text-xl text-umc-900">
              💡 Brainstorm {elementLabel}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Claude generates 4–6 short ideas to pick from instead of one
              polished draft.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded px-3 py-2">
            <span className="font-medium">Scripture:</span>{' '}
            {scriptureRefs ? (
              scriptureRefs
            ) : (
              <span className="italic text-amber-700">
                No scripture set.
              </span>
            )}
          </div>

          {linkedSermon && (
            <label className="text-xs font-medium text-gray-700 flex items-center gap-2">
              <input
                type="checkbox"
                checked={useTheme}
                onChange={(e) => setUseTheme(e.target.checked)}
              />
              Use spoiler-safe theme from "{linkedSermon.title}"
            </label>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              Your instructions for {elementLabel}
            </label>
            <textarea
              className="input w-full text-sm min-h-[80px]"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={`Optional guidance Claude should follow for every ${elementLabel}.`}
              disabled={loading || generating}
            />
            <label className="mt-1.5 flex items-center gap-2 text-[11px] text-gray-700">
              <input
                type="checkbox"
                checked={saveAsDefault}
                onChange={(e) => setSaveAsDefault(e.target.checked)}
                disabled={loading || generating}
              />
              Save as my default for {elementLabel}
            </label>
          </div>

          <div>
            <button
              type="button"
              onClick={handleBrainstorm}
              disabled={generating || loading}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {generating
                ? 'Brainstorming…'
                : ideas.length > 0
                  ? '↻ Brainstorm again'
                  : '💡 Brainstorm with Claude'}
            </button>
          </div>

          {error && (
            <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 whitespace-pre-wrap">
              {error}
            </p>
          )}

          {ideas.length > 0 && (
            <ul className="space-y-3">
              {ideas.map((idea, idx) => (
                <li
                  key={idx}
                  className="border border-gray-200 rounded p-3 bg-white"
                >
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <span className="text-[10px] uppercase tracking-wide text-gray-500">
                      Idea {idx + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => onApply(idea)}
                      className="text-xs text-umc-700 hover:text-umc-900 underline"
                    >
                      Use this
                    </button>
                  </div>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap font-serif leading-relaxed">
                    {idea}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="p-4 border-t border-gray-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
