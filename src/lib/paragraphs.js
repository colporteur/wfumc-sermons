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
