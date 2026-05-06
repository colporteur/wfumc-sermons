import { useEffect, useMemo, useState } from 'react';
import {
  SLIDE_TYPES,
  fetchSlides,
  createSlide,
  updateSlide,
  deleteSlide,
  reorderSlides,
  syncAnchorIndices,
} from '../lib/workspaceSlides';
import {
  splitManuscriptParagraphs,
  resolveAnchor,
  paragraphPreview,
} from '../lib/paragraphs';
import WorkspaceSlideSuggestionsModal from './WorkspaceSlideSuggestionsModal.jsx';
import { downloadSermonPptx } from '../lib/exportSermonPptx';

// Slides panel for the Sermon Workspace. Lives below the chat /
// manuscript pair; collapsible, with a stranded-count badge in the
// header so the pastor knows when something needs triage.
//
// Each slide:
//   - has a type, title, body, notes
//   - is optionally anchored to a manuscript paragraph (by storing a
//     copy of that paragraph's text); we re-resolve on every render
//     against the live manuscript and classify the anchor as exact /
//     modified / stranded
//   - can be edited in place, deleted, or reordered up/down
//
// After Claude lands a revision, the parent simply re-renders this
// panel with the new manuscript text — anchor resolution is a pure
// function of (slide.anchor_paragraph_text, current paragraphs).
//
// Cached anchor indices in the DB are kept in sync with whatever the
// resolver produced after each render, so the next session opens with
// the right indices without recomputing.
export default function WorkspaceSlides({ sermon, manuscript }) {
  const sermonId = sermon?.id;
  const ownerUserId = sermon?.owner_user_id;

  const [collapsed, setCollapsed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [slides, setSlides] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [adding, setAdding] = useState(false);
  const [addForm, setAddForm] = useState(null);
  const [busyId, setBusyId] = useState(null); // 'new' or a slide id
  const [suggestModalOpen, setSuggestModalOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const handleExportPptx = async () => {
    if (slides.length === 0) return;
    setExporting(true);
    setError(null);
    try {
      await downloadSermonPptx({ sermon, slides });
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setExporting(false);
    }
  };

  // Live paragraph list — the anchor resolver works against this.
  const paragraphs = useMemo(
    () => splitManuscriptParagraphs(manuscript || ''),
    [manuscript]
  );

  // Resolve every slide's anchor against the live manuscript. Returns a
  // parallel array of { status, idx?, paragraph?, similarity? } objects.
  const resolutions = useMemo(
    () => slides.map((s) => resolveAnchor(s.anchor_paragraph_text, paragraphs)),
    [slides, paragraphs]
  );

  const strandedCount = resolutions.filter((r) => r.status === 'stranded')
    .length;
  const modifiedCount = resolutions.filter((r) => r.status === 'modified')
    .length;

  // Auto-expand when there are stranded slides — the pastor needs to
  // notice and triage them.
  useEffect(() => {
    if (strandedCount > 0) setCollapsed(false);
  }, [strandedCount]);

  // Initial load.
  useEffect(() => {
    if (!sermonId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const rows = await fetchSlides(sermonId);
        if (!cancelled) setSlides(rows);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sermonId]);

  // Sync the DB's cached anchor_paragraph_idx whenever the resolver
  // produces a different value from what's stored. Best-effort; no UI
  // surface for failure since the resolver is the source of truth in-memory.
  useEffect(() => {
    if (!slides.length) return;
    const updates = [];
    slides.forEach((s, i) => {
      const r = resolutions[i];
      const newIdx =
        r.status === 'exact' || r.status === 'modified' ? r.idx : null;
      if (newIdx !== s.anchor_paragraph_idx) {
        updates.push({ id: s.id, idx: newIdx });
      }
    });
    if (updates.length === 0) return;
    syncAnchorIndices(updates).catch(() => {
      /* non-fatal — anchors are correct in-memory */
    });
    // Also reflect the new idx in local state so the cache aligns.
    setSlides((prev) =>
      prev.map((s, i) => {
        const r = resolutions[i];
        const newIdx =
          r.status === 'exact' || r.status === 'modified' ? r.idx : null;
        return s.anchor_paragraph_idx === newIdx
          ? s
          : { ...s, anchor_paragraph_idx: newIdx };
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolutions]);

  // --- helpers --------------------------------------------------------

  const blankForm = (overrides = {}) => ({
    slide_type: 'content',
    title: '',
    body: '',
    notes: '',
    anchor_paragraph_idx: '', // string for select-friendliness; '' = unanchored
    ...overrides,
  });

  const startAdd = () => {
    setAddForm(blankForm());
    setAdding(true);
    setError(null);
  };

  const cancelAdd = () => {
    setAdding(false);
    setAddForm(null);
  };

  const saveAdd = async () => {
    if (!sermonId || !ownerUserId) {
      setError('Missing sermon or user.');
      return;
    }
    setBusyId('new');
    setError(null);
    try {
      const idxStr = addForm.anchor_paragraph_idx;
      const anchorIdx = idxStr === '' ? null : Number(idxStr);
      const anchorText =
        anchorIdx === null
          ? null
          : paragraphs[anchorIdx]?.text || null;
      const created = await createSlide({
        sermonId,
        ownerUserId,
        sortOrder: slides.length,
        slideType: addForm.slide_type,
        title: addForm.title,
        body: addForm.body,
        notes: addForm.notes,
        anchorParagraphText: anchorText,
        anchorParagraphIdx: anchorIdx,
      });
      setSlides((prev) => [...prev, created]);
      cancelAdd();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  const startEdit = (slide) => {
    setEditingId(slide.id);
    setEditForm({
      slide_type: slide.slide_type || 'content',
      title: slide.title || '',
      body: slide.body || '',
      notes: slide.notes || '',
      anchor_paragraph_idx:
        slide.anchor_paragraph_idx === null ||
        slide.anchor_paragraph_idx === undefined
          ? ''
          : String(slide.anchor_paragraph_idx),
    });
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditForm(null);
  };

  const saveEdit = async (slide) => {
    setBusyId(slide.id);
    setError(null);
    try {
      const idxStr = editForm.anchor_paragraph_idx;
      const anchorIdx = idxStr === '' ? null : Number(idxStr);
      const anchorText =
        anchorIdx === null
          ? null
          : paragraphs[anchorIdx]?.text || slide.anchor_paragraph_text;
      const updated = await updateSlide(slide.id, {
        slide_type: editForm.slide_type,
        title: editForm.title,
        body: editForm.body,
        notes: editForm.notes,
        anchor_paragraph_text: anchorText,
        anchor_paragraph_idx: anchorIdx,
      });
      setSlides((prev) => prev.map((s) => (s.id === slide.id ? updated : s)));
      cancelEdit();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (slide, slideNumber) => {
    if (
      !window.confirm(
        `Delete slide #${slideNumber}${slide.title ? ` ("${slide.title}")` : ''}?`
      )
    ) {
      return;
    }
    setBusyId(slide.id);
    setError(null);
    try {
      await deleteSlide(slide.id);
      setSlides((prev) => prev.filter((s) => s.id !== slide.id));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  // Re-anchor to a new paragraph (used by stranded-slide triage and
  // by the per-slide "Pin to ¶" dropdown when not editing).
  const setAnchor = async (slide, idxOrNull) => {
    setBusyId(slide.id);
    setError(null);
    try {
      const text =
        idxOrNull === null ? null : paragraphs[idxOrNull]?.text || null;
      const updated = await updateSlide(slide.id, {
        anchor_paragraph_text: text,
        anchor_paragraph_idx: idxOrNull,
      });
      setSlides((prev) => prev.map((s) => (s.id === slide.id ? updated : s)));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  // Accept a batch of suggestions from the Claude modal — bulk-create
  // each one and append to the current slide list. Order is preserved
  // from the suggestion order.
  const handleAcceptSuggestions = async (suggestions) => {
    if (!sermonId || !ownerUserId) {
      throw new Error('Missing sermon or user.');
    }
    setError(null);
    const startOrder = slides.length;
    const created = [];
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      try {
        const row = await createSlide({
          sermonId,
          ownerUserId,
          sortOrder: startOrder + i,
          slideType: s.slide_type,
          title: s.title,
          body: s.body,
          notes: s.notes,
          anchorParagraphText: s.anchor_paragraph_text,
          anchorParagraphIdx: s.anchor_paragraph_idx,
        });
        created.push(row);
      } catch (e) {
        // Surface the error to the parent (the modal will display it)
        // and stop on first failure to avoid partial garbage.
        throw new Error(
          `Created ${created.length} of ${suggestions.length} slides before failing on slide #${i + 1}: ${
            e.message || String(e)
          }`
        );
      }
    }
    if (created.length > 0) {
      setSlides((prev) => [...prev, ...created]);
    }
  };

  const move = async (idx, dir) => {
    const tgt = idx + dir;
    if (tgt < 0 || tgt >= slides.length) return;
    const next = [...slides];
    [next[idx], next[tgt]] = [next[tgt], next[idx]];
    setSlides(next);
    try {
      await reorderSlides(next.map((s) => s.id));
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  // --- render ---------------------------------------------------------

  return (
    <div className="card space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-baseline gap-2 text-left"
        >
          <span className="font-serif text-lg text-umc-900">Slides</span>
          <span className="text-sm text-gray-500">
            {loading ? '(loading…)' : `(${slides.length})`}
          </span>
          {strandedCount > 0 && (
            <span className="text-xs bg-red-100 text-red-800 border border-red-200 rounded px-1.5 py-0.5">
              {strandedCount} stranded
            </span>
          )}
          {modifiedCount > 0 && (
            <span className="text-xs bg-amber-100 text-amber-800 border border-amber-200 rounded px-1.5 py-0.5">
              {modifiedCount} anchor moved
            </span>
          )}
          <span className="text-xs text-gray-400">
            {collapsed ? '▼ expand' : '▲ collapse'}
          </span>
        </button>
        {!collapsed && !adding && (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleExportPptx}
              disabled={slides.length === 0 || exporting}
              className="btn-secondary text-xs disabled:opacity-50"
              title={
                slides.length === 0
                  ? 'Add at least one slide first.'
                  : 'Generate a 16:9 PowerPoint deck from your slides. Open in PowerPoint and apply your theme via Design → Themes.'
              }
            >
              {exporting ? 'Building…' : '📊 Export to PowerPoint'}
            </button>
            <button
              type="button"
              onClick={() => setSuggestModalOpen(true)}
              disabled={!manuscript || !manuscript.trim()}
              className="btn-secondary text-xs disabled:opacity-50"
              title={
                !manuscript || !manuscript.trim()
                  ? 'Add some manuscript text first — Claude needs something to suggest slides for.'
                  : 'Ask Claude to propose a batch of slides for this manuscript.'
              }
            >
              ✨ Suggest slides
            </button>
            <button
              type="button"
              onClick={startAdd}
              className="btn-secondary text-xs"
            >
              + Add slide
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </p>
      )}

      {!collapsed && (
        <div className="space-y-2">
          {adding && (
            <div className="rounded border border-umc-200 bg-umc-50/40 p-3">
              <p className="text-[10px] uppercase tracking-wide text-umc-700 mb-2">
                New slide #{slides.length + 1}
              </p>
              <SlideForm
                form={addForm}
                setForm={setAddForm}
                paragraphs={paragraphs}
                onSave={saveAdd}
                onCancel={cancelAdd}
                saving={busyId === 'new'}
                saveLabel="Add slide"
              />
            </div>
          )}

          {slides.length === 0 && !adding && !loading && (
            <p className="text-sm text-gray-500 italic">
              No slides yet. Use “+ Add slide” to start a deck. Each slide
              can be anchored to a paragraph in the manuscript so that if
              Claude rewrites that paragraph, you'll see the slide flagged
              as "anchor moved" or "stranded" for triage.
            </p>
          )}

          <ul className="divide-y divide-gray-100">
            {slides.map((slide, i) => {
              const r = resolutions[i];
              const editing = editingId === slide.id;
              const busy = busyId === slide.id;
              return (
                <li key={slide.id} className="py-3">
                  {editing ? (
                    <div className="rounded border border-gray-200 bg-gray-50 p-3">
                      <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">
                        Editing slide #{i + 1}
                      </p>
                      <SlideForm
                        form={editForm}
                        setForm={setEditForm}
                        paragraphs={paragraphs}
                        onSave={() => saveEdit(slide)}
                        onCancel={cancelEdit}
                        saving={busy}
                        saveLabel="Save"
                      />
                    </div>
                  ) : (
                    <SlideRow
                      slide={slide}
                      slideNumber={i + 1}
                      resolution={r}
                      paragraphs={paragraphs}
                      busy={busy}
                      onMoveUp={() => move(i, -1)}
                      onMoveDown={() => move(i, +1)}
                      canMoveUp={i > 0}
                      canMoveDown={i < slides.length - 1}
                      onEdit={() => startEdit(slide)}
                      onDelete={() => handleDelete(slide, i + 1)}
                      onSetAnchor={(idx) => setAnchor(slide, idx)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <WorkspaceSlideSuggestionsModal
        open={suggestModalOpen}
        onClose={() => setSuggestModalOpen(false)}
        sermon={sermon}
        manuscript={manuscript}
        skipParagraphIdxs={Array.from(
          new Set(
            slides
              .map((s) => s.anchor_paragraph_idx)
              .filter((v) => v !== null && v !== undefined)
          )
        )}
        paragraphs={paragraphs}
        onAccept={handleAcceptSuggestions}
      />
    </div>
  );
}

// =====================================================================
// Subcomponents
// =====================================================================

function SlideRow({
  slide,
  slideNumber,
  resolution,
  paragraphs,
  busy,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
  onEdit,
  onDelete,
  onSetAnchor,
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex flex-col gap-1 pt-0.5 text-gray-400 text-xs select-none">
        <button
          type="button"
          onClick={onMoveUp}
          disabled={!canMoveUp || busy}
          className="hover:text-gray-700 disabled:opacity-30"
          title="Move up"
        >
          ▲
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={!canMoveDown || busy}
          className="hover:text-gray-700 disabled:opacity-30"
          title="Move down"
        >
          ▼
        </button>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium text-umc-900">
            #{slideNumber}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-gray-500">
            {slideTypeLabel(slide.slide_type)}
          </span>
          {slide.title && (
            <span className="text-sm text-gray-800">{slide.title}</span>
          )}
        </div>
        {slide.body && (
          <p className="text-xs text-gray-600 mt-1 whitespace-pre-wrap">
            {slide.body}
          </p>
        )}
        {slide.notes && (
          <p className="text-[10px] text-gray-500 italic mt-1">
            Notes: {slide.notes}
          </p>
        )}
        <AnchorIndicator
          resolution={resolution}
          paragraphs={paragraphs}
          onSetAnchor={onSetAnchor}
          busy={busy}
        />
      </div>
      <div className="flex flex-col sm:flex-row gap-1 shrink-0">
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="text-xs text-gray-600 hover:text-umc-900 underline disabled:opacity-40"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="text-xs text-red-600 hover:text-red-800 underline disabled:opacity-40"
        >
          {busy ? '…' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

function AnchorIndicator({ resolution, paragraphs, onSetAnchor, busy }) {
  if (!resolution) return null;
  if (resolution.status === 'unanchored') {
    return (
      <div className="text-[10px] text-gray-400 mt-1">
        Unanchored.{' '}
        <AnchorPicker
          paragraphs={paragraphs}
          onPick={onSetAnchor}
          disabled={busy}
          label="Pin to a paragraph"
        />
      </div>
    );
  }
  if (resolution.status === 'exact') {
    return (
      <p className="text-[10px] text-green-700 mt-1">
        Anchor: ¶{resolution.idx + 1} ·{' '}
        <span className="text-gray-500">
          {paragraphPreview(resolution.paragraph?.text)}
        </span>
      </p>
    );
  }
  if (resolution.status === 'modified') {
    const pct = Math.round((resolution.similarity || 0) * 100);
    return (
      <div className="text-[10px] text-amber-700 mt-1">
        Anchor moved to ¶{resolution.idx + 1} (paragraph changed since pin,
        ~{pct}% match) ·{' '}
        <span className="text-gray-500">
          {paragraphPreview(resolution.paragraph?.text)}
        </span>
      </div>
    );
  }
  // stranded
  return (
    <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 space-y-1">
      <p className="text-[10px] text-red-700">
        ⚠ Stranded — the paragraph this slide was anchored to is gone or
        substantially rewritten.
      </p>
      <p className="text-[10px] text-gray-600">
        Was anchored to:{' '}
        <span className="italic">"{paragraphPreview(resolution.anchorText)}"</span>
      </p>
      <div className="flex flex-wrap items-center gap-2 text-[10px]">
        <AnchorPicker
          paragraphs={paragraphs}
          onPick={onSetAnchor}
          disabled={busy}
          label="Re-anchor"
        />
        <button
          type="button"
          onClick={() => onSetAnchor(null)}
          disabled={busy}
          className="text-gray-600 hover:text-gray-900 underline"
        >
          Drop anchor
        </button>
      </div>
    </div>
  );
}

function AnchorPicker({ paragraphs, onPick, disabled, label }) {
  return (
    <select
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value;
        if (v === '') return;
        onPick(Number(v));
        e.target.value = '';
      }}
      className="text-[10px] border border-gray-300 rounded px-1 py-0.5 bg-white"
      defaultValue=""
    >
      <option value="" disabled>
        {label}…
      </option>
      {paragraphs.map((p) => (
        <option key={p.idx} value={p.idx}>
          ¶{p.idx + 1}: {paragraphPreview(p.text, 60)}
        </option>
      ))}
    </select>
  );
}

function SlideForm({ form, setForm, paragraphs, onSave, onCancel, saving, saveLabel }) {
  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="block text-xs">
          <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
            Type
          </span>
          <select
            value={form.slide_type}
            onChange={(e) => update('slide_type', e.target.value)}
            className="input w-full text-sm"
          >
            {SLIDE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
            Anchor (paragraph)
          </span>
          <select
            value={form.anchor_paragraph_idx}
            onChange={(e) => update('anchor_paragraph_idx', e.target.value)}
            className="input w-full text-sm"
          >
            <option value="">Unanchored</option>
            {paragraphs.map((p) => (
              <option key={p.idx} value={String(p.idx)}>
                ¶{p.idx + 1}: {paragraphPreview(p.text, 60)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-xs">
        <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
          Title (heading on the slide)
        </span>
        <input
          type="text"
          value={form.title}
          onChange={(e) => update('title', e.target.value)}
          className="input w-full text-sm"
          placeholder="Optional"
        />
      </label>
      <label className="block text-xs">
        <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
          Body (main slide content)
        </span>
        <textarea
          value={form.body}
          onChange={(e) => update('body', e.target.value)}
          rows={3}
          className="input w-full text-sm"
        />
      </label>
      <label className="block text-xs">
        <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
          Speaker notes (in the .pptx notes pane, not on the slide)
        </span>
        <textarea
          value={form.notes}
          onChange={(e) => update('notes', e.target.value)}
          rows={2}
          className="input w-full text-sm"
        />
      </label>
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="btn-secondary text-xs"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="btn-primary text-xs disabled:opacity-50"
        >
          {saving ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  );
}

function slideTypeLabel(type) {
  return SLIDE_TYPES.find((t) => t.value === type)?.label || type;
}
