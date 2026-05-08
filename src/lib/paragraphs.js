// Paragraph-level helpers used by the Sermon Workspace slides feature.
//
// Splits a manuscript into discrete paragraphs and resolves slide
// anchors against the current paragraph list, classifying each anchor
// as exact / modified / stranded so the slides UI can react.

// Split text into paragraphs (blank-line separated). Returns an array
// of { idx, text } objects with the trimmed paragraph text. Slide
// anchors operate on this list, so it's important the indices here
// match what the user sees as "paragraph N".
export function splitManuscriptParagraphs(text) {
  if (!text) return [];
  const parts = text
    .split(/\n[ \t]*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((paragraphText, idx) => ({ idx, text: paragraphText }));
}

// Normalized fingerprint for fast exact-match anchor resolution.
// Lowercase, collapse whitespace, truncate. Two paragraphs with the
// same fingerprint are considered "the same paragraph" for anchor
// purposes (whitespace-only changes don't strand a slide).
export function paragraphFingerprint(text) {
  if (!text) return '';
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 500);
}

// Word-set Jaccard similarity. Used as the fallback when the exact
// fingerprint doesn't match — a paragraph that Claude tightened still
// shares most of its words with the original, so similarity catches it.
export function paragraphSimilarity(a, b) {
  const wa = wordSet(a);
  const wb = wordSet(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function wordSet(s) {
  const set = new Set();
  if (!s) return set;
  // Normalize curly/straight quote variants for comparison.
  const m = s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .match(/[a-z0-9']+/g) || [];
  for (const w of m) set.add(w);
  return set;
}

// Threshold above which a paragraph match is "modified" rather than
// "stranded". 0.5 means at least half the words overlap — empirically
// catches Claude-tightened paragraphs without false positives across
// totally unrelated paragraphs.
const SIMILARITY_THRESHOLD = 0.5;

// Resolve a slide's anchor against a current manuscript paragraph list.
//
// Returns one of:
//   { status: 'unanchored' }
//     — slide was never anchored (or anchor_paragraph_text is empty).
//   { status: 'exact', idx, paragraph }
//     — same paragraph still exists. paragraph is the live { idx, text }.
//   { status: 'modified', idx, paragraph, similarity }
//     — best-similarity match above the threshold. The paragraph has
//       changed but is recognizably the same one.
//   { status: 'stranded', anchorText }
//     — couldn't find a similar enough paragraph. The slide needs
//       triage (re-anchor, drop anchor, or delete).
export function resolveAnchor(anchorParagraphText, paragraphs) {
  if (!anchorParagraphText || !anchorParagraphText.trim()) {
    return { status: 'unanchored' };
  }

  const fingerprint = paragraphFingerprint(anchorParagraphText);

  // Stage 1: exact fingerprint match.
  for (const p of paragraphs) {
    if (paragraphFingerprint(p.text) === fingerprint) {
      return { status: 'exact', idx: p.idx, paragraph: p };
    }
  }

  // Stage 2: best similarity above the threshold.
  let best = { idx: -1, similarity: 0, paragraph: null };
  for (const p of paragraphs) {
    const sim = paragraphSimilarity(anchorParagraphText, p.text);
    if (sim > best.similarity) {
      best = { idx: p.idx, similarity: sim, paragraph: p };
    }
  }

  if (best.similarity >= SIMILARITY_THRESHOLD) {
    return {
      status: 'modified',
      idx: best.idx,
      paragraph: best.paragraph,
      similarity: best.similarity,
    };
  }

  return { status: 'stranded', anchorText: anchorParagraphText };
}

// Short preview of a paragraph (or anchor text) for compact display
// next to a slide. ~80 chars with an ellipsis if truncated.
export function paragraphPreview(text, maxLen = 80) {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1) + '…';
}

// =====================================================================
// Manuscript ↔ slide marker sync
//
// Pastor Todd's manuscripts use inline markers of the form
//   <SLIDE #N – Description>
// to mark where the slide deck advances. The Workspace stores slide
// content in the workspace_slides table; these helpers move data
// between the two representations:
//
//   findManuscriptSlideMarkers(text)
//     → scan the manuscript for existing markers, returning their
//       number / description / paragraph index. Used by the
//       "Create from markers" action.
//
//   insertSlideMarkersIntoManuscript(text, slides)
//     → for each anchored slide, prepend a <SLIDE #N – Title> marker
//       to its anchor paragraph. Skips paragraphs that already contain
//       a marker for that slide number. Used by the "Insert markers"
//       action.
// =====================================================================

// Same marker pattern used by the docx exporter (with the # optional
// and tolerant of plain hyphen / en-dash / em-dash).
const SLIDE_MARKER_RE = /<SLIDE\s+#?(\d+)\s*[-–—]\s*([^>]+)>/g;

export function findManuscriptSlideMarkers(text) {
  const out = [];
  if (!text) return out;
  const paragraphs = splitManuscriptParagraphs(text);
  for (const p of paragraphs) {
    SLIDE_MARKER_RE.lastIndex = 0;
    let m;
    while ((m = SLIDE_MARKER_RE.exec(p.text)) !== null) {
      out.push({
        number: parseInt(m[1], 10),
        description: m[2].trim(),
        paragraphIdx: p.idx,
        paragraphText: p.text,
        rawMarker: m[0],
      });
    }
  }
  return out;
}

// Insert <SLIDE #N – Description> markers at the start of each
// anchored slide's paragraph, using the slide's 1-based index in
// `slides` as N and `slide.title || '(untitled)'` as the description.
//
// Returns { newText, inserted, skipped } where inserted/skipped are
// counts. The original text is left alone for paragraphs that already
// contain a marker for that slide number.
//
// When multiple slides share the same anchor paragraph, all their
// markers are emitted together at the top of that paragraph, sorted by
// slide number ascending — so the manuscript always reads in slide
// order even when several slides advance on the same paragraph.
export function insertSlideMarkersIntoManuscript(text, slides) {
  const paragraphs = splitManuscriptParagraphs(text || '');
  // Map paragraph idx → working text so we can mutate without losing
  // the original index.
  const byIdx = new Map(paragraphs.map((p) => [p.idx, p.text]));

  let inserted = 0;
  let skipped = 0;

  // Step 1: group slides by their anchor paragraph idx. Each entry
  // also carries the slide's 1-based panel position (= slide number).
  const byAnchor = new Map(); // idx → [{ slideNumber, description }]
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const idx = slide.anchor_paragraph_idx;
    const slideNumber = i + 1;

    if (idx === null || idx === undefined) {
      skipped++;
      continue;
    }
    if (!byIdx.has(idx)) {
      // Anchor paragraph no longer exists (slide is stranded).
      skipped++;
      continue;
    }

    const description = (slide.title || '(untitled)').trim();
    if (!byAnchor.has(idx)) byAnchor.set(idx, []);
    byAnchor.get(idx).push({ slideNumber, description });
  }

  // Step 2: for each anchor paragraph, sort its slides ascending by
  // number, drop any whose marker is already present in the paragraph
  // (by number OR by matching description for that paragraph), then
  // prepend the combined marker block in one shot.
  for (const [idx, entries] of byAnchor.entries()) {
    const para = byIdx.get(idx);
    entries.sort((a, b) => a.slideNumber - b.slideNumber);

    // Collect existing slide NUMBERS in this paragraph so we don't
    // double-insert the same slide. We deliberately do NOT dedupe by
    // description — multiple slides can legitimately share a description
    // (e.g., two "Acts 17:32-34" callbacks at the same anchor).
    const existingNumbers = new Set();
    SLIDE_MARKER_RE.lastIndex = 0;
    let m;
    while ((m = SLIDE_MARKER_RE.exec(para)) !== null) {
      existingNumbers.add(parseInt(m[1], 10));
    }

    const markersToInsert = [];
    for (const e of entries) {
      if (existingNumbers.has(e.slideNumber)) {
        skipped++;
        continue;
      }
      markersToInsert.push(`<SLIDE #${e.slideNumber} – ${e.description}>`);
      existingNumbers.add(e.slideNumber);
      inserted++;
    }

    if (markersToInsert.length > 0) {
      byIdx.set(idx, markersToInsert.join('\n\n') + '\n\n' + para);
    }
  }

  // Reassemble the manuscript with paragraph separators preserved.
  const newText = paragraphs.map((p) => byIdx.get(p.idx)).join('\n\n');

  return { newText, inserted, skipped };
}

// Strip every <SLIDE> marker (numbered OR unnumbered) from the
// manuscript and collapse the blank lines that result (so a paragraph
// that consisted of nothing but markers doesn't leave a hole).
//
// Returns { newText, removed } where `removed` is how many markers were
// stripped. Used by:
//   * "Clear markers from manuscript" — straight cleanup
//   * "Force panel → manuscript" — clear, then re-insert from panel
export function clearSlideMarkersFromManuscript(text) {
  if (!text) return { newText: '', removed: 0 };
  let removed = 0;
  // Permissive: optional number group so unnumbered shorthand like
  // "<SLIDE – Idea>" is also caught.
  const re = /<SLIDE(?:\s+#?\d+)?\s*[-–—]\s*[^>]+>/g;
  const stripped = text.replace(re, () => {
    removed++;
    return '';
  });
  // Cleanup: trim trailing whitespace on each line (markers often left
  // a leading space behind), then collapse 3+ blank lines into 2 so the
  // paragraph structure stays intact.
  const cleaned = stripped
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n');
  return { newText: cleaned, removed };
}

// Walk the manuscript in paragraph order, find every <SLIDE> marker
// (numbered like "<SLIDE #5 – Title>" OR unnumbered shorthand like
// "<SLIDE – Title>"), and renumber every match sequentially 1..N in
// the order they appear in the manuscript. Returns the rewritten
// manuscript plus a list of slide stubs ready to feed createSlide().
//
// Used by the "Force manuscript → panel" rebuild flow so the pastor
// can scribble inline cues without bothering with numbers, and the
// system can pin everything down with the correct sequential numbers
// in one pass.
//
// Returns: { newText, slides, renumbered, total }
//   slides[] = [{ number, description, paragraphIdx, paragraphText }]
//   renumbered = how many markers got a different number than before
//                (unnumbered counts as different from any number)
//   total      = total markers found
export function renumberSlideMarkersInManuscript(text) {
  if (!text) return { newText: '', slides: [], renumbered: 0, total: 0 };
  const paragraphs = splitManuscriptParagraphs(text);
  const slideStubs = [];
  let counter = 0;
  let renumbered = 0;
  // First pass: rewrite each paragraph's text with sequentially-numbered
  // markers, collecting slide stubs as we go.
  const newParagraphTexts = paragraphs.map((p) => {
    // Fresh regex per paragraph so lastIndex doesn't leak across calls.
    const re = /<SLIDE(?:\s+#?(\d+))?\s*[-–—]\s*([^>]+)>/g;
    return p.text.replace(re, (_match, numStr, desc) => {
      counter++;
      const description = (desc || '').trim();
      slideStubs.push({
        number: counter,
        description,
        paragraphIdx: p.idx,
      });
      const oldNum = numStr ? parseInt(numStr, 10) : null;
      if (oldNum !== counter) renumbered++;
      return `<SLIDE #${counter} – ${description}>`;
    });
  });
  // Second pass: stamp each stub with the POST-renumber paragraph
  // text so future anchor resolution uses the canonical (renumbered)
  // form. paragraphs[i].idx === i, so direct index lookup works.
  const slides = slideStubs.map((s) => ({
    ...s,
    paragraphText: newParagraphTexts[s.paragraphIdx],
  }));
  return {
    newText: newParagraphTexts.join('\n\n'),
    slides,
    renumbered,
    total: counter,
  };
}
