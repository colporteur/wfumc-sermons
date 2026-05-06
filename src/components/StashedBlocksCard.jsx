import { useEffect, useMemo, useState } from 'react';
import {
  fetchStashedBlocks,
  deleteStashedBlock,
  markStashedBlockUsed,
  markStashedBlockUnused,
} from '../lib/sermonStashedBlocks';

// "Stashed for next preaching" card.
//
// Lists every sermon_stashed_blocks row attached to the current
// sermon. Live blocks (used_at = null) are shown by default;
// previously-used ones can be revealed via a toggle so the pastor
// retains the history without clutter.
//
// Per-block actions:
//   - View full     → opens an inline modal showing the body
//   - Insert into manuscript (workspace-only, requires unlocked)
//                   → calls onInsert(block) — parent decides where the
//                     block lands (typically the chat composer)
//   - Mark as used  → soft-archives (used_at = now)
//   - Mark as live  → reactivates a previously-archived block
//   - Delete        → removes the row
//
// Props:
//   sermonId        — id of the parent sermon
//   isLocked        — true when the manuscript is locked. Hides the
//                     "Insert into manuscript" affordance.
//   onInsert(block) — workspace-side callback. If omitted, the
//                     "Insert into manuscript" button is hidden too
//                     (e.g. on SermonDetail where there's no chat).
export default function StashedBlocksCard({
  sermonId,
  isLocked = false,
  onInsert,
}) {
  const [blocks, setBlocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showUsed, setShowUsed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [previewBlock, setPreviewBlock] = useState(null);

  const reload = async () => {
    if (!sermonId) return;
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchStashedBlocks(sermonId);
      setBlocks(rows);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sermonId]);

  const liveBlocks = useMemo(
    () => blocks.filter((b) => !b.used_at),
    [blocks]
  );
  const usedBlocks = useMemo(
    () => blocks.filter((b) => !!b.used_at),
    [blocks]
  );
  const visibleBlocks = useMemo(
    () => (showUsed ? blocks : liveBlocks),
    [blocks, liveBlocks, showUsed]
  );

  // Auto-collapse when there's nothing live (avoid an empty card
  // taking up vertical space). Re-expand when something appears.
  useEffect(() => {
    setCollapsed(liveBlocks.length === 0 && !showUsed);
  }, [liveBlocks.length, showUsed]);

  const handleDelete = async (block) => {
    if (
      !window.confirm(
        `Delete this stashed block? This is permanent.\n\n${(block.body || '').slice(0, 200)}…`
      )
    ) {
      return;
    }
    setBusyId(block.id);
    setError(null);
    try {
      await deleteStashedBlock(block.id);
      setBlocks((prev) => prev.filter((b) => b.id !== block.id));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleUsed = async (block) => {
    setBusyId(block.id);
    setError(null);
    try {
      const updated = block.used_at
        ? await markStashedBlockUnused(block.id)
        : await markStashedBlockUsed(block.id);
      setBlocks((prev) => prev.map((b) => (b.id === block.id ? updated : b)));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  // Hide entirely when there's truly nothing to show — no live blocks
  // and the user hasn't opted into showing used. Keeps SermonDetail
  // from showing an empty card on every sermon.
  if (loading) return null;
  if (blocks.length === 0) return null;

  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-baseline gap-2 text-left"
        >
          <span className="font-serif text-lg text-umc-900">
            Stashed for next preaching
          </span>
          <span className="text-sm text-gray-500">
            ({liveBlocks.length} live
            {usedBlocks.length > 0 && `, ${usedBlocks.length} used`})
          </span>
          <span className="text-xs text-gray-400">
            {collapsed ? '▼ expand' : '▲ collapse'}
          </span>
        </button>
        {!collapsed && usedBlocks.length > 0 && (
          <button
            type="button"
            onClick={() => setShowUsed((v) => !v)}
            className="text-xs text-gray-500 hover:text-gray-800 underline"
          >
            {showUsed ? 'Hide used' : `Show ${usedBlocks.length} used`}
          </button>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </p>
      )}

      {!collapsed && (
        <ul className="divide-y divide-gray-100">
          {visibleBlocks.map((block) => {
            const busy = busyId === block.id;
            const isUsed = !!block.used_at;
            const preview = (block.body || '')
              .replace(/\s+/g, ' ')
              .slice(0, 180);
            return (
              <li
                key={block.id}
                className={'py-3 flex items-start gap-3 ' + (isUsed ? 'opacity-60' : '')}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    {block.title && (
                      <p className="text-sm font-medium text-umc-900">
                        {block.title}
                      </p>
                    )}
                    {isUsed && (
                      <span className="text-[10px] uppercase tracking-wide text-gray-500">
                        used
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-600 mt-1">
                    {preview}
                    {block.body && block.body.length > 180 && '…'}
                  </p>
                  {block.source && (
                    <p className="text-[10px] text-gray-400 mt-1">
                      {block.source}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1 shrink-0 text-xs">
                  <button
                    type="button"
                    onClick={() => setPreviewBlock(block)}
                    className="text-gray-600 hover:text-umc-900 underline"
                  >
                    View full
                  </button>
                  {onInsert && !isLocked && !isUsed && (
                    <button
                      type="button"
                      onClick={() => onInsert(block)}
                      className="text-umc-700 hover:text-umc-900 underline"
                      title="Send the block to the chat composer with a 'weave this in' instruction."
                    >
                      Insert
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleToggleUsed(block)}
                    disabled={busy}
                    className="text-gray-600 hover:text-gray-900 underline disabled:opacity-40"
                  >
                    {isUsed ? 'Mark as live' : 'Mark used'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(block)}
                    disabled={busy}
                    className="text-red-600 hover:text-red-800 underline disabled:opacity-40"
                  >
                    {busy ? '…' : 'Delete'}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {previewBlock && (
        <BlockPreviewModal
          block={previewBlock}
          onClose={() => setPreviewBlock(null)}
        />
      )}
    </div>
  );
}

function BlockPreviewModal({ block, onClose }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-stretch sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-2xl sm:rounded-lg shadow-xl flex flex-col max-h-screen sm:max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-gray-200 flex items-baseline justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="font-serif text-lg text-umc-900 truncate">
              {block.title || 'Stashed block'}
            </h2>
            {block.source && (
              <p className="text-xs text-gray-500 mt-0.5">{block.source}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-sm"
          >
            Close
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="whitespace-pre-wrap font-serif text-sm leading-relaxed text-gray-800">
            {block.body}
          </p>
        </div>
      </div>
    </div>
  );
}
