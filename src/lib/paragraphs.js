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
export function insertSlideMarkersIntoManuscript(text, slides) {
  const paragraphs = splitManuscriptParagraphs(text || '');
  // Map paragraph idx → working text so we can mutate without losing
  // the original index.
  const byIdx = new Map(paragraphs.map((p) => [p.idx, p.text]));

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const idx = slide.anchor_paragraph_idx;
    if (idx === null || idx === undefined) {
      skipped++;
      continue;
    }
    const para = byIdx.get(idx);
    if (para === undefined) {
      // The anchor paragraph no longer exists in the current manuscript
      // (slide is stranded). Skip — the user should triage in the panel.
      skipped++;
      continue;
    }

    const slideNumber = i + 1;
    const description = (slide.title || '(untitled)').trim();
    const markerText = `<SLIDE #${slideNumber} – ${description}>`;

    // Skip if a marker for this slide number already exists in the paragraph.
    const existsRe = new RegExp(`<SLIDE\\s+#?${slideNumber}\\s*[-–—]`, 'i');
    if (existsRe.test(para)) {
      skipped++;
      continue;
    }

    byIdx.set(idx, markerText + '\n\n' + para);
    inserted++;
  }

  // Reassemble the manuscript with paragraph separators preserved.
  const newText = paragraphs.map((p) => byIdx.get(p.idx)).join('\n\n');

  return { newText, inserted, skipped };
}
