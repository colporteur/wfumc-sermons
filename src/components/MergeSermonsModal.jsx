import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase, withTimeout } from '../lib/supabase';
import TypeaheadSearch from './TypeaheadSearch.jsx';

// Merge this sermon (the source) INTO another sermon (the target).
// All child rows reassign to the target. The source title and any
// previous_titles get pushed onto the target. Source notes append.
// Source manuscript copies only if target has none. Source row is deleted.
//
// All work happens server-side via the merge_sermons() SQL function so
// it's transactional.
export default function MergeSermonsModal({ source, onClose }) {
  const navigate = useNavigate();
  const [target, setTarget] = useState(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState(null);

  const handleMerge = async () => {
    if (!target) {
      setError('Pick a target sermon to merge into.');
      return;
    }
    if (
      !window.confirm(
        `Merge "${source.title || '(untitled)'}" INTO "${target.title || '(untitled)'}"?\n\n` +
          `This is irreversible. All preachings, resources, liturgies, and ` +
          `revisions on the source will be reassigned to the target. The ` +
          `source's title is preserved as a "previous title" on the target. ` +
          `The source row will be deleted.`
      )
    ) {
      return;
    }
    setMerging(true);
    setError(null);
    try {
      const { error: rpcErr } = await withTimeout(
        supabase.rpc('merge_sermons', {
          p_source_id: source.id,
          p_target_id: target.id,
        })
      );
      if (rpcErr) throw rpcErr;
      // Source is gone; navigate to the surviving target.
      navigate(`/sermons/${target.id}`);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setMerging(false);
    }
  };

  if (!source) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-xl rounded-t-lg sm:rounded-lg shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 space-y-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="font-serif text-xl text-umc-900">Merge sermon</h2>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-gray-700 text-sm"
            >
              Close
            </button>
          </div>

          {error && (
            <p className="rounded bg-red-50 border border-red-200 px-2 py-1 text-sm text-red-700">
              {error}
            </p>
          )}

          <div className="rounded bg-gray-50 border border-gray-200 px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-gray-500">
              This sermon (will be deleted)
            </p>
            <p className="text-sm font-medium text-umc-900">
              {source.title || '(untitled)'}
            </p>
            {source.scripture_reference && (
              <p className="text-xs text-gray-500 mt-0.5">
                {source.scripture_reference}
              </p>
            )}
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
              Merge into…
            </label>
            <TypeaheadSearch
              table="sermons"
              selectColumns="id, title, scripture_reference, owner_user_id"
              searchColumns="title,scripture_reference"
              labelFor={(r) => r.title || '(untitled)'}
              subLabelFor={(r) => r.scripture_reference || ''}
              excludeIds={new Set([source.id])}
              onPick={setTarget}
              placeholder="Search the surviving sermon by title or scripture…"
            />
            {target && (
              <div className="mt-2 rounded bg-green-50 border border-green-200 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-green-800">
                  Target (will survive)
                </p>
                <p className="text-sm font-medium text-umc-900">
                  {target.title || '(untitled)'}
                </p>
                {target.scripture_reference && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    {target.scripture_reference}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setTarget(null)}
                  className="mt-1 text-xs text-gray-600 hover:text-gray-900 underline"
                >
                  Pick a different target
                </button>
              </div>
            )}
          </div>

          <div className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded p-3 space-y-1">
            <p className="font-medium">What happens:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>All preachings of the source reassign to the target.</li>
              <li>All resources, liturgy items, revisions, and worship plans pointing to the source reassign too.</li>
              <li>The source's title becomes a "previous title" on the target.</li>
              <li>The source's previous titles + notes get carried over.</li>
              <li>If the target has no manuscript and the source does, the source's manuscript copies over.</li>
              <li>The source row is deleted.</li>
            </ul>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary text-sm"
              disabled={merging}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleMerge}
              disabled={merging || !target}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {merging ? 'Merging…' : `Merge into "${target?.title || '…'}"`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
