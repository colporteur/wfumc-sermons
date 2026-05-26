import { useEffect, useMemo, useState } from 'react';
import {
  SLIDE_TYPES,
  fetchSlides,
  createSlide,
  updateSlide,
  deleteSlide,
  deleteAllSlidesForSermon,
  reorderSlides,
  syncAnchorIndices,
} from '../lib/workspaceSlides';
import {
  splitManuscriptParagraphs,
  resolveAnchor,
  paragraphPreview,
  insertSlideMarkersIntoManuscript,
  clearSlideMarkersFromManuscript,
  renumberSlideMarkersInManuscript,
  splitIntoSentences,
  looksLikeScriptureReference,
} from '../lib/paragraphs';
import { lookupScriptureNRSVUe } from '../lib/claude';
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
export default function WorkspaceSlides({ sermon, manuscript, onManuscriptChange }) {
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
  // Batch NRSVUe lookup state. `batchLookup.progress` like "3 / 7"
  // while running; non-null `batchLookup.summary` shows the post-run
  // banner ({ filled, skippedHadBody, skippedNoMatch, failed, total, errors }).
  const [batchLookup, setBatchLookup] = useState({
    running: false,
    progress: '',
    summary: null,
  });

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

  // For a given slide, return the first text field that looks like a
  // scripture reference (e.g. "Acts 17:23-28", "1 John 4:7"). Title is
  // checked first since that's what the pastor literally said in the
  // request, then marker_description (the existing per-slide ✨ button
  // uses that field, so a lot of slides already have refs there).
  // Returns null if neither field is a scripture reference.
  const slideScriptureRef = (slide) => {
    const candidates = [
      (slide.title || '').trim(),
      (slide.marker_description || '').trim(),
    ];
    for (const c of candidates) {
      if (c && looksLikeScriptureReference(c)) return c;
    }
    return null;
  };

  // Batch NRSVUe lookup: find every slide whose title or marker
  // description is a scripture reference, fetch the verses via Claude,
  // and drop the result into the Body field. Skips slides that already
  // have Body content so hand-edits aren't blown away.
  const handleBatchLookupScripture = async () => {
    if (slides.length === 0) {
      setError('No slides yet.');
      return;
    }
    // Partition the slide list up front so we can show the pastor what's
    // about to happen before any network calls go out.
    const matched = slides
      .map((s, i) => ({ slide: s, slideNumber: i + 1, ref: slideScriptureRef(s) }))
      .filter((m) => m.ref);
    if (matched.length === 0) {
      setError(
        'No slides have a scripture reference in the Title or Slide description field. ' +
          'Example refs the matcher recognises: "Acts 17:23-28", "1 John 4:7", "Psalm 23".'
      );
      return;
    }
    const toFill = matched.filter(
      (m) => !(m.slide.body && m.slide.body.trim().length > 0)
    );
    const skippedHadBody = matched.length - toFill.length;
    if (toFill.length === 0) {
      setError(
        `Found ${matched.length} scripture-titled slide${matched.length === 1 ? '' : 's'}, ` +
          `but every one already has Body content. Clear the Body field on the slides you want refreshed, then try again.`
      );
      return;
    }
    const previewList = toFill
      .slice(0, 8)
      .map((m) => `  #${m.slideNumber} → ${m.ref}`)
      .join('\n');
    const moreLine =
      toFill.length > 8 ? `\n  …and ${toFill.length - 8} more` : '';
    if (
      !window.confirm(
        `Look up ${toFill.length} scripture passage${toFill.length === 1 ? '' : 's'} from the NRSVUe?\n\n` +
          previewList +
          moreLine +
          (skippedHadBody > 0
            ? `\n\n${skippedHadBody} matching slide${skippedHadBody === 1 ? '' : 's'} already ha${
                skippedHadBody === 1 ? 's' : 've'
              } Body content and will be skipped.`
            : '') +
          '\n\nEach lookup is a separate Claude call — this may take a minute for long lists.'
      )
    ) {
      return;
    }

    setError(null);
    setBatchLookup({ running: true, progress: `0 / ${toFill.length}`, summary: null });
    const errors = [];
    let filled = 0;
    let failed = 0;
    // Sequential, not parallel — Claude rate-limits and the user can see
    // progress tick up. Keep going on errors so one bad ref doesn't
    // wipe out the rest of the run.
    for (let i = 0; i < toFill.length; i++) {
      const { slide, slideNumber, ref } = toFill[i];
      setBatchLookup({
        running: true,
        progress: `${i + 1} / ${toFill.length} (#${slideNumber} → ${ref})`,
        summary: null,
      });
      try {
        const text = await lookupScriptureNRSVUe(ref);
        const updated = await updateSlide(slide.id, { body: text });
        // Update local state slide-by-slide so the UI reflects each fill
        // as the run progresses (and a mid-run failure still leaves the
        // successful ones visible).
        setSlides((prev) => prev.map((s) => (s.id === slide.id ? updated : s)));
        filled++;
      } catch (e) {
        failed++;
        errors.push(`#${slideNumber} (${ref}): ${e?.message || String(e)}`);
      }
    }
    setBatchLookup({
      running: false,
      progress: '',
      summary: {
        filled,
        skippedHadBody,
        failed,
        total: matched.length,
        errors,
      },
    });
  };

  // Insert <SLIDE #N – Description> markers into the manuscript for
  // each anchored slide. Uses the slide's panel position (1-based) as
  // the slide number; pastor can reorder slides in the panel before
  // running this if they want narrative-order numbering.
  const handleInsertMarkers = () => {
    if (!onManuscriptChange) {
      setError(
        'Manuscript is locked or not editable. Unlock to insert markers.'
      );
      return;
    }
    if (slides.length === 0) return;
    const { newText, inserted, skipped } = insertSlideMarkersIntoManuscript(
      manuscript || '',
      slides
    );
    if (inserted === 0) {
      setError(
        skipped > 0
          ? `All ${skipped} eligible slides already have markers in the manuscript (or aren't anchored).`
          : 'No slides have a paragraph anchor. Pin slides to paragraphs in the panel first.'
      );
      return;
    }
    if (
      !window.confirm(
        `Insert ${inserted} <SLIDE> marker${inserted === 1 ? '' : 's'} into the manuscript?\n\n` +
          (skipped > 0
            ? `${skipped} slide${skipped === 1 ? '' : 's'} will be skipped (already have markers, unanchored, or stranded).\n\n`
            : '') +
          'Markers go at the start of each anchored paragraph. You can move them within the paragraph manually after.'
      )
    ) {
      return;
    }
    setError(null);
    onManuscriptChange(newText);
  };

  // Scan the manuscript for existing <SLIDE #N – Description> markers
  // and create workspace_slide rows for each one that doesn't already
  // have a corresponding slide. Useful for bringing pre-existing
  // manuscripts into the slides panel without retyping every slide.
  const handleCreateFromMarkers = async () => {
    if (!sermonId || !ownerUserId) return;
    if (!manuscript || !manuscript.trim()) {
      setError('Manuscript is empty.');
      return;
    }
    // Use renumberSlideMarkersInManuscript so we pick up BOTH numbered
    // markers like "<SLIDE #1 – Foo>" AND unnumbered shorthand like
    // "<SLIDE – Foo>" that the pastor scribbles inline while editing.
    // The helper walks markers in manuscript order, assigns sequential
    // numbers to every match, and returns the rewritten manuscript +
    // a list of slide stubs. Only marker tokens are rewritten — every
    // other character of the manuscript is preserved verbatim.
    const {
      newText: renumberedManuscript,
      slides: markers,
      renumbered,
      total,
    } = renumberSlideMarkersInManuscript(manuscript);

    if (total === 0) {
      setError(
        'No <SLIDE> markers found in the manuscript. Markers look like ' +
          '"<SLIDE #1 – Description>" or the unnumbered shorthand ' +
          '"<SLIDE – Description>".'
      );
      return;
    }

    // If renumbering would actually change manuscript text (because of
    // unnumbered shorthand or out-of-order numbers), we need permission
    // to write the manuscript back. A locked manuscript can't be
    // updated — surface the gate clearly rather than silently dropping
    // the unnumbered markers.
    const needsManuscriptRewrite =
      renumbered > 0 && renumberedManuscript !== manuscript;
    if (needsManuscriptRewrite && !onManuscriptChange) {
      setError(
        `Found ${total} marker${total === 1 ? '' : 's'} including ` +
          `${renumbered} that need${renumbered === 1 ? 's' : ''} renumbering ` +
          `(unnumbered shorthand or out-of-order numbers). The manuscript ` +
          `is locked, so we can't rewrite the marker numbers in place. ` +
          `Unlock the manuscript and try again.`
      );
      return;
    }

    // Dedupe: same description + same anchor paragraph as an existing
    // slide → skip. Match marker_description first (preferred) or fall
    // back to title (back-compat for slides created before the
    // marker_description column existed). We deliberately don't dedupe
    // on number — sequential renumbering means a given description's
    // number may shift from run to run, but the description+anchor
    // pair is stable.
    const newMarkers = markers.filter(
      (m) =>
        !slides.some(
          (s) =>
            s.anchor_paragraph_idx === m.paragraphIdx &&
            ((s.marker_description &&
              s.marker_description === m.description) ||
              s.title === m.description)
        )
    );
    const skipped = markers.length - newMarkers.length;

    if (newMarkers.length === 0 && !needsManuscriptRewrite) {
      setError(
        `All ${total} markers already have matching slides in the panel.`
      );
      return;
    }

    const renumberClause =
      needsManuscriptRewrite
        ? `\n\n${renumbered} marker${renumbered === 1 ? '' : 's'} ` +
          `(unnumbered shorthand or out-of-order numbers) will be renumbered ` +
          `sequentially in the manuscript. Only the <SLIDE …> tokens are ` +
          `touched — your prose isn't changed.`
        : '';
    const skippedClause =
      skipped > 0
        ? `\n\n${skipped} marker${skipped === 1 ? '' : 's'} already ` +
          `${skipped === 1 ? 'has' : 'have'} matching slides and will be ` +
          `skipped.`
        : '';
    if (
      !window.confirm(
        `Found ${total} <SLIDE> marker${total === 1 ? '' : 's'} in the ` +
          `manuscript.\n\n` +
          `Create ${newMarkers.length} new slide${newMarkers.length === 1 ? '' : 's'}?` +
          skippedClause +
          renumberClause +
          '\n\nAll new slides default to the "Content" type. You can ' +
          'edit type/body/notes after.'
      )
    ) {
      return;
    }

    setError(null);

    // Write the renumbered manuscript first (if changed). This is what
    // gives the unnumbered shorthand its number. Done before the slide
    // inserts so the new slides' anchor_paragraph_text matches the
    // text the pastor will see after the rewrite.
    if (needsManuscriptRewrite) {
      onManuscriptChange(renumberedManuscript);
    }

    const startOrder = slides.length;
    const created = [];
    try {
      for (let i = 0; i < newMarkers.length; i++) {
        const m = newMarkers[i];
        const row = await createSlide({
          sermonId,
          ownerUserId,
          sortOrder: startOrder + i,
          slideType: 'content',
          title: '',
          body: '',
          notes: '',
          anchorParagraphText: m.paragraphText,
          anchorParagraphIdx: m.paragraphIdx,
          markerDescription: m.description,
        });
        created.push(row);
      }
      setSlides((prev) => [...prev, ...created]);
    } catch (e) {
      setError(
        `Created ${created.length} of ${newMarkers.length} slides before failing: ${e.message || String(e)}`
      );
      if (created.length > 0) {
        setSlides((prev) => [...prev, ...created]);
      }
    }
  };

  // Strip every <SLIDE> marker from the manuscript. Useful when the
  // manuscript has accumulated stale markers from previous insert runs
  // and you want a clean slate before re-running "Insert markers".
  const handleClearMarkers = () => {
    if (!onManuscriptChange) {
      setError('Manuscript is locked or not editable. Unlock to clear markers.');
      return;
    }
    const { newText, removed } = clearSlideMarkersFromManuscript(
      manuscript || ''
    );
    if (removed === 0) {
      setError('No <SLIDE> markers found in the manuscript.');
      return;
    }
    if (
      !window.confirm(
        `Remove ${removed} <SLIDE> marker${removed === 1 ? '' : 's'} from the manuscript?\n\n` +
          'The slide list in the panel is untouched — only the inline markers in the manuscript text are stripped.'
      )
    ) {
      return;
    }
    setError(null);
    onManuscriptChange(newText);
  };

  // "Manuscript wins": renumber every <SLIDE> marker in the manuscript
  // sequentially in order of occurrence (catching unnumbered shorthand
  // like "<SLIDE – Idea>" too), rewrite the manuscript with the proper
  // numbers, then delete every panel slide and rebuild the list from
  // the renumbered markers. Use this when you've been editing markers
  // inline (with or without numbers) and want the panel + manuscript
  // to both reflect "manuscript order is the source of truth."
  const handleForceManuscriptToPanel = async () => {
    if (!sermonId || !ownerUserId) return;
    if (!manuscript || !manuscript.trim()) {
      setError('Manuscript is empty.');
      return;
    }
    const {
      newText,
      slides: markers,
      renumbered,
      total,
    } = renumberSlideMarkersInManuscript(manuscript);
    if (total === 0) {
      setError(
        'No <SLIDE> markers found in the manuscript. Add markers like ' +
          '"<SLIDE #1 – Description>" or shorthand "<SLIDE – Description>" first.'
      );
      return;
    }
    // Renumbering rewrites the manuscript text. If that's needed but
    // the manuscript is locked, bail before doing anything destructive.
    const needsRewrite = renumbered > 0 && newText !== manuscript;
    if (needsRewrite && !onManuscriptChange) {
      setError(
        'The manuscript has unnumbered or out-of-order markers that need renumbering, ' +
          'but the manuscript is locked. Unlock the manuscript and try again.'
      );
      return;
    }
    if (
      !window.confirm(
        `Force panel to match manuscript?\n\n` +
          `• Delete all ${slides.length} existing slide${slides.length === 1 ? '' : 's'} in the panel\n` +
          `• Recreate ${total} slide${total === 1 ? '' : 's'} from the markers in the manuscript\n` +
          (renumbered > 0
            ? `• Renumber ${renumbered} marker${renumbered === 1 ? '' : 's'} in the manuscript ` +
              `(unnumbered or out-of-order markers become sequential)\n`
            : '') +
          `\nNew slides default to the "Content" type. Slide bodies, notes, and image uploads on the deleted slides will NOT be carried over — only the marker description becomes the new slide title.`
      )
    ) {
      return;
    }
    setError(null);
    try {
      // Push the renumbered manuscript text first so the markers the
      // pastor sees match the panel we're about to build.
      if (needsRewrite) {
        onManuscriptChange(newText);
      }
      await deleteAllSlidesForSermon(sermonId);
      const created = [];
      for (let i = 0; i < markers.length; i++) {
        const m = markers[i];
        const row = await createSlide({
          sermonId,
          ownerUserId,
          sortOrder: i,
          slideType: 'content',
          title: '',
          body: '',
          notes: '',
          anchorParagraphText: m.paragraphText,
          anchorParagraphIdx: m.paragraphIdx,
          markerDescription: m.description,
        });
        created.push(row);
      }
      setSlides(created);
    } catch (e) {
      setError(e.message || String(e));
      // Best-effort: refetch so the panel reflects whatever DB state
      // actually landed (delete may have succeeded, recreate may have
      // partially failed).
      try {
        const rows = await fetchSlides(sermonId);
        setSlides(rows);
      } catch {
        /* swallow — error already surfaced */
      }
    }
  };

  // "Panel wins": clear every <SLIDE> marker from the manuscript, then
  // re-insert markers for the current panel slide list. Net effect:
  // manuscript markers exactly mirror the panel.
  const handleForcePanelToManuscript = () => {
    if (!onManuscriptChange) {
      setError('Manuscript is locked or not editable. Unlock to write markers.');
      return;
    }
    if (slides.length === 0) {
      setError('No slides in the panel.');
      return;
    }
    const cleared = clearSlideMarkersFromManuscript(manuscript || '');
    // Re-resolve anchors against the post-clear manuscript so paragraph
    // indices line up. (Clearing whole-marker paragraphs can shift
    // indices.)
    const postParagraphs = splitManuscriptParagraphs(cleared.newText);
    const reAnchoredSlides = slides.map((s) => {
      const r = resolveAnchor(s.anchor_paragraph_text, postParagraphs);
      const newIdx =
        r.status === 'exact' || r.status === 'modified' ? r.idx : null;
      return { ...s, anchor_paragraph_idx: newIdx };
    });
    const insert = insertSlideMarkersIntoManuscript(
      cleared.newText,
      reAnchoredSlides
    );
    const stranded = reAnchoredSlides.filter(
      (s) => s.anchor_paragraph_idx === null || s.anchor_paragraph_idx === undefined
    ).length;
    if (
      !window.confirm(
        `Force manuscript to match panel?\n\n` +
          `• Remove ${cleared.removed} existing marker${cleared.removed === 1 ? '' : 's'} from the manuscript\n` +
          `• Insert ${insert.inserted} marker${insert.inserted === 1 ? '' : 's'} for the panel slides\n` +
          (stranded > 0
            ? `\n${stranded} stranded slide${stranded === 1 ? ' has' : 's have'} no usable anchor and won't appear in the manuscript.\n`
            : '')
      )
    ) {
      return;
    }
    setError(null);
    onManuscriptChange(insert.newText);
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
    marker_description: '',
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
        markerDescription: addForm.marker_description,
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
      marker_description: slide.marker_description || '',
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
        marker_description: editForm.marker_description,
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
    const label = slide.title || slide.marker_description || '';
    if (
      !window.confirm(
        `Delete slide #${slideNumber}${label ? ` ("${label}")` : ''}?`
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
              onClick={handleInsertMarkers}
              disabled={
                slides.length === 0 ||
                !onManuscriptChange ||
                !manuscript ||
                !manuscript.trim()
              }
              className="btn-secondary text-xs disabled:opacity-50"
              title={
                !onManuscriptChange
                  ? 'Manuscript is locked. Unlock to insert markers.'
                  : slides.length === 0
                  ? 'Add at least one anchored slide first.'
                  : 'Add <SLIDE #N – Title> markers to the manuscript at each anchored slide\'s paragraph.'
              }
            >
              ↩ Insert markers in manuscript
            </button>
            <button
              type="button"
              onClick={handleCreateFromMarkers}
              disabled={!manuscript || !manuscript.trim()}
              className="btn-secondary text-xs disabled:opacity-50"
              title={
                !manuscript || !manuscript.trim()
                  ? 'Manuscript is empty.'
                  : 'Scan the manuscript for <SLIDE> markers (numbered OR unnumbered shorthand like "<SLIDE – Idea>") and create slide rows for each one. Unnumbered markers get numbered sequentially in the manuscript on the way through — only marker tokens are rewritten, your prose is untouched.'
              }
            >
              ↪ Create from markers
            </button>
            <span className="text-gray-300 px-1" aria-hidden="true">|</span>
            <button
              type="button"
              onClick={handleClearMarkers}
              disabled={
                !onManuscriptChange || !manuscript || !manuscript.trim()
              }
              className="btn-secondary text-xs disabled:opacity-50"
              title={
                !onManuscriptChange
                  ? 'Manuscript is locked. Unlock to clear markers.'
                  : 'Strip every <SLIDE> marker from the manuscript text. The panel slide list is untouched.'
              }
            >
              ✕ Clear markers
            </button>
            <button
              type="button"
              onClick={handleForceManuscriptToPanel}
              disabled={!manuscript || !manuscript.trim()}
              className="btn-secondary text-xs disabled:opacity-50 border-amber-300 text-amber-800 hover:bg-amber-50"
              title="Manuscript wins: rebuild the panel from <SLIDE> markers in the manuscript. Unnumbered shorthand like '<SLIDE – Idea>' is also picked up — every marker is renumbered sequentially in manuscript order."
            >
              ⇒ Force manuscript→panel
            </button>
            <button
              type="button"
              onClick={handleForcePanelToManuscript}
              disabled={
                !onManuscriptChange ||
                slides.length === 0 ||
                !manuscript ||
                !manuscript.trim()
              }
              className="btn-secondary text-xs disabled:opacity-50 border-amber-300 text-amber-800 hover:bg-amber-50"
              title={
                !onManuscriptChange
                  ? 'Manuscript is locked. Unlock to write markers.'
                  : 'Panel wins: clear every <SLIDE> marker from the manuscript, then insert fresh markers from the panel slide list.'
              }
            >
              ⇐ Force panel→manuscript
            </button>
            <span className="text-gray-300 px-1" aria-hidden="true">|</span>
            <button
              type="button"
              onClick={handleBatchLookupScripture}
              disabled={slides.length === 0 || batchLookup.running}
              className="btn-secondary text-xs disabled:opacity-50"
              title={
                slides.length === 0
                  ? 'Add at least one slide first.'
                  : 'Walk every slide whose Title or Slide description is a scripture reference (e.g. "Acts 17:23-28"), look it up in the NRSVUe via Claude, and fill the Body field. Slides that already have Body content are skipped.'
              }
            >
              {batchLookup.running
                ? `Looking up ${batchLookup.progress}…`
                : '✨ Fill scripture bodies (NRSVUe)'}
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

      {batchLookup.summary && (
        <div
          className={
            'text-xs rounded px-2 py-1.5 border ' +
            (batchLookup.summary.failed > 0
              ? 'bg-amber-50 border-amber-200 text-amber-900'
              : 'bg-green-50 border-green-200 text-green-900')
          }
        >
          <div className="flex items-baseline justify-between gap-2">
            <span>
              {batchLookup.summary.failed > 0
                ? `Batch scripture lookup finished with ${batchLookup.summary.failed} error${
                    batchLookup.summary.failed === 1 ? '' : 's'
                  }.`
                : 'Batch scripture lookup finished.'}
              {' '}
              Filled {batchLookup.summary.filled} Body field
              {batchLookup.summary.filled === 1 ? '' : 's'}
              {batchLookup.summary.skippedHadBody > 0
                ? `, skipped ${batchLookup.summary.skippedHadBody} that already had content`
                : ''}
              .
            </span>
            <button
              type="button"
              onClick={() =>
                setBatchLookup((b) => ({ ...b, summary: null }))
              }
              className="text-[10px] opacity-60 hover:opacity-100 underline"
            >
              dismiss
            </button>
          </div>
          {batchLookup.summary.errors.length > 0 && (
            <ul className="mt-1 list-disc list-inside text-[11px]">
              {batchLookup.summary.errors.map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
            </ul>
          )}
        </div>
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
          {!slide.title && slide.marker_description && (
            <span className="text-sm text-gray-600 italic">
              {slide.marker_description}
            </span>
          )}
        </div>
        {slide.title && slide.marker_description &&
          slide.title !== slide.marker_description && (
            <p className="text-[10px] text-gray-500 italic mt-0.5">
              from marker: {slide.marker_description}
            </p>
          )}
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
  const [scriptureLoading, setScriptureLoading] = useState(false);
  const [scriptureError, setScriptureError] = useState(null);

  const desc = (form.marker_description || '').trim();
  const hasDesc = desc.length > 0;
  const descLooksScripture = hasDesc && looksLikeScriptureReference(desc);

  // Anchored paragraph for the sentence picker. Anchor stored as a
  // string in form state ('' = unanchored).
  const anchorIdxNum =
    form.anchor_paragraph_idx === '' || form.anchor_paragraph_idx === null
      ? null
      : Number(form.anchor_paragraph_idx);
  const anchorPara =
    anchorIdxNum !== null && Number.isInteger(anchorIdxNum)
      ? paragraphs[anchorIdxNum]
      : null;
  const sentences = anchorPara ? splitIntoSentences(anchorPara.text) : [];

  const handleLookupScripture = async () => {
    if (!hasDesc) return;
    setScriptureLoading(true);
    setScriptureError(null);
    try {
      const text = await lookupScriptureNRSVUe(desc);
      update('body', text);
    } catch (e) {
      setScriptureError(e.message || String(e));
    } finally {
      setScriptureLoading(false);
    }
  };

  const handlePickSentence = (sentence) => {
    if (!sentence) return;
    const current = (form.body || '').trim();
    update('body', current ? current + ' ' + sentence : sentence);
  };

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

      {/* Slide description — captured from the manuscript marker. The
          pastor can copy it into Title or Body via the quick-links below. */}
      <label className="block text-xs">
        <span className="block text-[10px] uppercase tracking-wide text-gray-500 mb-1">
          Slide description
          <span className="ml-1 normal-case tracking-normal text-gray-400">
            (text after the dash in the manuscript &lt;SLIDE&gt; marker)
          </span>
        </span>
        <input
          type="text"
          value={form.marker_description || ''}
          onChange={(e) => update('marker_description', e.target.value)}
          className="input w-full text-sm"
          placeholder='e.g. "Acts 17:32-34" or "The world is changing fast"'
        />
      </label>

      <label className="block text-xs">
        <span className="flex items-baseline justify-between mb-1">
          <span className="block text-[10px] uppercase tracking-wide text-gray-500">
            Title (heading on the slide)
          </span>
          {hasDesc && (
            <button
              type="button"
              onClick={() => update('title', desc)}
              className="text-[10px] text-umc-700 hover:text-umc-900 underline"
              title="Copy slide description into the title field"
            >
              ↳ Use description
            </button>
          )}
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
        <span className="flex items-baseline justify-between gap-2 flex-wrap mb-1">
          <span className="block text-[10px] uppercase tracking-wide text-gray-500">
            Body (main slide content)
          </span>
          <span className="flex items-baseline gap-3 flex-wrap">
            {hasDesc && (
              <button
                type="button"
                onClick={() => update('body', desc)}
                className="text-[10px] text-umc-700 hover:text-umc-900 underline"
                title="Copy slide description into the body field"
              >
                ↳ Use description
              </button>
            )}
            {descLooksScripture && (
              <button
                type="button"
                onClick={handleLookupScripture}
                disabled={scriptureLoading}
                className="text-[10px] text-umc-700 hover:text-umc-900 underline disabled:opacity-50"
                title={`Fetch ${desc} from the NRSVUe translation via Claude`}
              >
                {scriptureLoading
                  ? 'Asking Claude…'
                  : `✨ Look up ${desc} (NRSVUe)`}
              </button>
            )}
            {sentences.length > 0 && (
              <select
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) {
                    handlePickSentence(v);
                    e.target.value = '';
                  }
                }}
                defaultValue=""
                className="text-[10px] border border-gray-300 rounded px-1 py-0.5 bg-white max-w-[220px]"
                title="Append a sentence from the anchor paragraph to the body"
              >
                <option value="" disabled>
                  ↳ Insert sentence from ¶{anchorIdxNum + 1}…
                </option>
                {sentences.map((s, i) => (
                  <option key={i} value={s}>
                    {paragraphPreview(s, 80)}
                  </option>
                ))}
              </select>
            )}
          </span>
        </span>
        <textarea
          value={form.body}
          onChange={(e) => update('body', e.target.value)}
          rows={3}
          className="input w-full text-sm"
        />
        {scriptureError && (
          <p className="text-[10px] text-red-700 mt-1">
            Scripture lookup failed: {scriptureError}
          </p>
        )}
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
