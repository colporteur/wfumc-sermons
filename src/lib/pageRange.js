// Parse a human-typed page-range spec like "4-17, 22, 30-35" into a
// Set of 1-indexed page numbers. Used by the PDF extractor to limit
// resource extraction to a relevant section of a commentary.
//
// Accepts:
//   "4"              → {4}
//   "4-17"           → {4..17}
//   "4-17, 22"       → {4..17, 22}
//   "4-17, 22, 30-35"→ {4..17, 22, 30..35}
//   " "  or  ""      → null  (signals "no filter — all pages")
//
// Throws Error on malformed input. Caller should surface the message.

export function parsePageRangeSpec(spec) {
  if (typeof spec !== 'string') return null;
  const trimmed = spec.trim();
  if (trimmed === '') return null;

  const pages = new Set();
  const chunks = trimmed
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  if (chunks.length === 0) return null;

  for (const chunk of chunks) {
    // Range "4-17" — accept hyphen, en-dash, em-dash.
    const rangeMatch = chunk.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (rangeMatch) {
      const start = +rangeMatch[1];
      const end = +rangeMatch[2];
      if (start < 1 || end < 1) {
        throw new Error(`Pages start at 1; got "${chunk}".`);
      }
      if (end < start) {
        throw new Error(`Range "${chunk}" goes backward — start ≤ end.`);
      }
      for (let p = start; p <= end; p++) pages.add(p);
      continue;
    }
    // Single page "22".
    const singleMatch = chunk.match(/^(\d+)$/);
    if (singleMatch) {
      const p = +singleMatch[1];
      if (p < 1) throw new Error(`Pages start at 1; got "${chunk}".`);
      pages.add(p);
      continue;
    }
    throw new Error(
      `Couldn't parse "${chunk}". Use formats like "4", "4-17", or "4-17, 22, 30-35".`
    );
  }
  return pages;
}

/**
 * Format a Set of page numbers back to a compact human string.
 * {4,5,6,7,22,30,31} → "4-7, 22, 30-31"
 */
export function formatPageRange(pages) {
  if (!pages || pages.size === 0) return '';
  const sorted = Array.from(pages).sort((a, b) => a - b);
  const parts = [];
  let runStart = sorted[0];
  let runEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i];
    if (p === runEnd + 1) {
      runEnd = p;
    } else {
      parts.push(runStart === runEnd ? `${runStart}` : `${runStart}-${runEnd}`);
      runStart = p;
      runEnd = p;
    }
  }
  parts.push(runStart === runEnd ? `${runStart}` : `${runStart}-${runEnd}`);
  return parts.join(', ');
}
