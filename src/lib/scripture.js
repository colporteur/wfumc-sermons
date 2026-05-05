// Helpers for parsing scripture references like "John 3:16-21" or
// "1 Corinthians 13:1-13; Mark 12:28-34" into the book name(s).
//
// Edge cases handled:
//   - Continuations: "Genesis 2:15-17; 3:1-7" → only "Genesis"
//     (the second chunk "3:1-7" inherits the previous chunk's book
//     instead of being treated as a new citation).
//   - Translation markers: "John 3:16 KJV" → only "John"
//     (KJV / NRSV / NIV / etc. are not books).

// Standard Protestant canon books, in roughly canonical order.
// Used to map common variants ("1 Cor", "I Corinthians") back to a
// canonical name.
export const BIBLE_BOOKS = [
  // Old Testament
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy',
  'Joshua', 'Judges', 'Ruth', '1 Samuel', '2 Samuel',
  '1 Kings', '2 Kings', '1 Chronicles', '2 Chronicles',
  'Ezra', 'Nehemiah', 'Esther', 'Job', 'Psalms', 'Proverbs',
  'Ecclesiastes', 'Song of Solomon', 'Isaiah', 'Jeremiah',
  'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
  'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah',
  'Haggai', 'Zechariah', 'Malachi',
  // New Testament
  'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans',
  '1 Corinthians', '2 Corinthians', 'Galatians', 'Ephesians',
  'Philippians', 'Colossians', '1 Thessalonians', '2 Thessalonians',
  '1 Timothy', '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James',
  '1 Peter', '2 Peter', '1 John', '2 John', '3 John', 'Jude',
  'Revelation',
];

// Common abbreviations and Roman-numeral variants that the spreadsheet
// uses. Keys are lowercased; values are the canonical book name.
const BOOK_ALIASES = {
  // Roman numerals → arabic
  'i samuel': '1 Samuel', 'ii samuel': '2 Samuel',
  'i kings': '1 Kings', 'ii kings': '2 Kings',
  'i chronicles': '1 Chronicles', 'ii chronicles': '2 Chronicles',
  'i corinthians': '1 Corinthians', 'ii corinthians': '2 Corinthians',
  'i thessalonians': '1 Thessalonians', 'ii thessalonians': '2 Thessalonians',
  'i timothy': '1 Timothy', 'ii timothy': '2 Timothy',
  'i peter': '1 Peter', 'ii peter': '2 Peter',
  'i john': '1 John', 'ii john': '2 John', 'iii john': '3 John',
  // Common short forms
  'psalm': 'Psalms', 'song of songs': 'Song of Solomon',
  'canticles': 'Song of Solomon',
  'rev': 'Revelation', 'revelations': 'Revelation',
};

const LOWER_BOOK_LOOKUP = (() => {
  const map = new Map();
  for (const b of BIBLE_BOOKS) map.set(b.toLowerCase(), b);
  for (const [k, v] of Object.entries(BOOK_ALIASES)) map.set(k, v);
  return map;
})();

// Common Bible translation abbreviations. If the parser thinks a token
// is a book but it's actually one of these, drop it.
const TRANSLATIONS = new Set([
  'KJV', 'NKJV', 'NIV', 'NIRV', 'TNIV',
  'NRSV', 'NRSVUE', 'NRSVCE', 'RSV',
  'ESV', 'NASB', 'NASB95', 'NASB20',
  'CEB', 'CEV', 'GNT', 'GNB', 'TEV',
  'MSG', 'NLT', 'TLB', 'WEB', 'BBE',
  'AMP', 'AMPC', 'ASV', 'YLT', 'DRA',
  'JB', 'NJB', 'NABRE', 'NAB',
  'TPT', 'PHILLIPS', 'WYC', 'GW',
]);

function isTranslationToken(s) {
  if (!s) return false;
  return TRANSLATIONS.has(s.replace(/[\s()]+/g, '').toUpperCase());
}

// Parse a single citation chunk like "John 3:16-21" or "1 Corinthians 13"
// → "John" or "1 Corinthians". Returns null if unrecognized OR if the
// candidate looks like a translation marker rather than a book.
export function bookFromCitation(citation) {
  if (!citation) return null;
  const trimmed = citation.trim();
  if (!trimmed) return null;
  // Strip everything from the first chapter:verse onward.
  // The book name is everything up to the first space-then-digit
  // sequence (allowing for the leading "1"/"2"/"3" or "I"/"II"/"III").
  const match = trimmed.match(/^([1-3IVi]?[Iv]*\s?[A-Za-z][A-Za-z'’]*(?:\s+(?:of\s+)?[A-Za-z][A-Za-z'’]*)*)\s+\d/);
  const candidate = (match ? match[1] : trimmed).trim();
  if (!candidate) return null;
  if (isTranslationToken(candidate)) return null;
  const lookup = LOWER_BOOK_LOOKUP.get(candidate.toLowerCase());
  return lookup || candidate || null;
}

// Given a free-form scripture_reference (possibly multiple citations
// separated by ;, ,, or "and"), return the unique set of canonical
// book names found.
export function booksFromReference(ref) {
  if (!ref) return [];
  const chunks = ref
    .split(/[;]|,(?=\s*[1-3]?\s?[A-Za-z])|(?:\s+and\s+)/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = new Set();
  // Track the most recent book so chunks like "3:1-7" (a continuation
  // of an earlier "Genesis 2:15-17") inherit it instead of being
  // misread as a brand-new book.
  let lastBook = null;
  for (const c of chunks) {
    // Pure chapter:verse continuation — no letters at all (or only a
    // translation marker hanging on). Inherit the previous book.
    const hasLetters = /[A-Za-z]/.test(c);
    const onlyTranslation = hasLetters && isTranslationToken(c);
    if (!hasLetters || onlyTranslation) {
      if (lastBook) out.add(lastBook);
      continue;
    }
    const b = bookFromCitation(c);
    if (b) {
      out.add(b);
      lastBook = b;
    }
  }
  return Array.from(out);
}

// =====================================================================
// Verse-level overlap
//
// parseScriptureRanges() turns a free-form reference into an array of
// normalized ranges:
//   { book: 'Acts', chapter: 17, startVerse: 22, endVerse: 31 }
//
// Special values:
//   - chapter: null  → "any chapter" (the citation was book-only,
//                       e.g. "Acts" with no number)
//   - endVerse: ANY_VERSE → "to end of chapter" (e.g. "Acts 17"
//                          or the first chapter of a multi-chapter span)
//
// rangesOverlap() returns true if two ranges share at least one verse.
// referencesOverlap() runs that across the cross-product of all ranges
// from two free-form references.
// =====================================================================

export const ANY_VERSE = 999;

// Strip a citation chunk down to the chapter:verse part (everything
// after the book name). Returns '' if there's no number portion.
function chapterVersePartOf(chunk) {
  const m = chunk.match(
    /^[1-3IVi]?[Iv]*\s?[A-Za-z][A-Za-z'’]*(?:\s+(?:of\s+)?[A-Za-z][A-Za-z'’]*)*\s+(\d.*)$/
  );
  return m ? m[1].trim() : '';
}

// Parse a chapter:verse expression and return an array of ranges.
// Handles:
//   "23"            → [{ch 23, v 1-ANY}]
//   "17:22"         → [{ch 17, v 22-22}]
//   "17:22-31"      → [{ch 17, v 22-31}]
//   "17:22-18:5"    → [{ch 17, v 22-ANY}, {ch 18, v 1-5}]   (cross-chapter)
//   "17-19"         → [{ch 17, v 1-ANY}, {ch 18, v 1-ANY}, {ch 19, v 1-ANY}]
function parseChapterVerse(s) {
  if (!s) return [];
  // Normalize en/em dashes to hyphen, then drop everything that isn't
  // a digit, colon, or hyphen. That cleanly strips trailing translation
  // markers ("3:16 NRSV" → "3:16"), parens, and stray whitespace.
  const t = s.replace(/[–—]/g, '-').replace(/[^\d:\-]/g, '').trim();
  if (!t) return [];

  // Cross-chapter range "17:22-18:5"
  let m = t.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
  if (m) {
    const startCh = +m[1];
    const startV = +m[2];
    const endCh = +m[3];
    const endV = +m[4];
    if (startCh === endCh) {
      return [{ chapter: startCh, startVerse: startV, endVerse: endV }];
    }
    const out = [{ chapter: startCh, startVerse: startV, endVerse: ANY_VERSE }];
    for (let ch = startCh + 1; ch < endCh; ch++) {
      out.push({ chapter: ch, startVerse: 1, endVerse: ANY_VERSE });
    }
    out.push({ chapter: endCh, startVerse: 1, endVerse: endV });
    return out;
  }

  // Single chapter, verse range "17:22-31"
  m = t.match(/^(\d+):(\d+)-(\d+)$/);
  if (m) {
    return [{ chapter: +m[1], startVerse: +m[2], endVerse: +m[3] }];
  }

  // Single verse "17:22"
  m = t.match(/^(\d+):(\d+)$/);
  if (m) {
    const ch = +m[1];
    const v = +m[2];
    return [{ chapter: ch, startVerse: v, endVerse: v }];
  }

  // Chapter range "17-19"
  m = t.match(/^(\d+)-(\d+)$/);
  if (m) {
    const start = +m[1];
    const end = +m[2];
    const out = [];
    for (let ch = start; ch <= end; ch++) {
      out.push({ chapter: ch, startVerse: 1, endVerse: ANY_VERSE });
    }
    return out;
  }

  // Just a chapter "23" (e.g. "Psalm 23")
  m = t.match(/^(\d+)$/);
  if (m) {
    return [{ chapter: +m[1], startVerse: 1, endVerse: ANY_VERSE }];
  }

  return [];
}

// Parse a free-form scripture reference into an array of normalized
// ranges. Handles continuations the same way booksFromReference does.
export function parseScriptureRanges(ref) {
  if (!ref) return [];
  const chunks = ref
    .split(/[;]|,(?=\s*[1-3]?\s?[A-Za-z])|(?:\s+and\s+)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  let lastBook = null;

  for (const c of chunks) {
    const hasLetters = /[A-Za-z]/.test(c);
    const onlyTranslation = hasLetters && isTranslationToken(c);

    // Pure continuation chunk like "3:1-7" — inherit the last book.
    if (!hasLetters || onlyTranslation) {
      if (!lastBook) continue;
      const part = c.replace(/[A-Za-z()\s]/g, '');
      const subs = parseChapterVerse(part);
      for (const s of subs) out.push({ book: lastBook, ...s });
      continue;
    }

    const book = bookFromCitation(c);
    if (!book) continue;

    const after = chapterVersePartOf(c);
    if (!after) {
      // Book-only citation. Match anything in that book.
      out.push({ book, chapter: null, startVerse: 1, endVerse: ANY_VERSE });
      lastBook = book;
      continue;
    }

    const subs = parseChapterVerse(after);
    if (subs.length === 0) {
      // Couldn't make sense of the chapter:verse — fall back to book-only.
      out.push({ book, chapter: null, startVerse: 1, endVerse: ANY_VERSE });
    } else {
      for (const s of subs) out.push({ book, ...s });
    }
    lastBook = book;
  }

  return out;
}

// True if two ranges share at least one verse.
//   - Different book → never.
//   - Either chapter == null (book-only citation) → match if same book
//     (a book-only citation is a wildcard within its book).
//   - Same book + same chapter → standard interval overlap.
export function rangesOverlap(a, b) {
  if (!a || !b) return false;
  if (a.book !== b.book) return false;
  if (a.chapter == null || b.chapter == null) return true;
  if (a.chapter !== b.chapter) return false;
  return a.startVerse <= b.endVerse && b.startVerse <= a.endVerse;
}

// True if any range in refA overlaps any range in refB.
export function referencesOverlap(refA, refB) {
  const aRanges = parseScriptureRanges(refA);
  const bRanges = parseScriptureRanges(refB);
  for (const a of aRanges) {
    for (const b of bRanges) {
      if (rangesOverlap(a, b)) return true;
    }
  }
  return false;
}

// Return the ranges from refB that overlap any range in refA, so the
// UI can show *which* part of refB matched.
export function findOverlappingRanges(refA, refB) {
  const aRanges = parseScriptureRanges(refA);
  const bRanges = parseScriptureRanges(refB);
  const out = [];
  for (const b of bRanges) {
    for (const a of aRanges) {
      if (rangesOverlap(a, b)) {
        out.push(b);
        break;
      }
    }
  }
  return out;
}

// Pretty-print a normalized range.
//   { Acts, ch null }            → "Acts"
//   { Acts, ch 17, sv 1, ev 999 }→ "Acts 17"
//   { Acts, ch 17, sv 22, ev 22 }→ "Acts 17:22"
//   { Acts, ch 17, sv 22, ev 31 }→ "Acts 17:22-31"
export function formatRange(r) {
  if (!r) return '';
  if (r.chapter == null) return r.book;
  if (r.endVerse >= ANY_VERSE && r.startVerse <= 1) {
    return `${r.book} ${r.chapter}`;
  }
  if (r.startVerse === r.endVerse) {
    return `${r.book} ${r.chapter}:${r.startVerse}`;
  }
  if (r.endVerse >= ANY_VERSE) {
    return `${r.book} ${r.chapter}:${r.startVerse}-end`;
  }
  return `${r.book} ${r.chapter}:${r.startVerse}-${r.endVerse}`;
}
