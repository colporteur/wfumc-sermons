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
