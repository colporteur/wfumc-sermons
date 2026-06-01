import SYNOPTIC_PARALLELS from '../data/synopticParallels.json';

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

// Common abbreviations and Roman-numeral variants that show up in the
// pastor's existing data (resources imported from spreadsheets, ENEX
// notes, etc.) Keys are lowercased; values are the canonical book name.
//
// Used both for parsing references AND for collapsing the Book of Bible
// dropdown filter so that "Matt" and "Matthew" don't appear as separate
// entries.
const BOOK_ALIASES = {
  // --- Roman numerals → arabic --------------------------------------
  'i samuel': '1 Samuel', 'ii samuel': '2 Samuel',
  'i kings': '1 Kings', 'ii kings': '2 Kings',
  'i chronicles': '1 Chronicles', 'ii chronicles': '2 Chronicles',
  'i corinthians': '1 Corinthians', 'ii corinthians': '2 Corinthians',
  'i thessalonians': '1 Thessalonians', 'ii thessalonians': '2 Thessalonians',
  'i timothy': '1 Timothy', 'ii timothy': '2 Timothy',
  'i peter': '1 Peter', 'ii peter': '2 Peter',
  'i john': '1 John', 'ii john': '2 John', 'iii john': '3 John',

  // --- Old Testament abbreviations ----------------------------------
  'gen': 'Genesis', 'gn': 'Genesis',
  'exo': 'Exodus', 'exod': 'Exodus', 'ex': 'Exodus',
  'lev': 'Leviticus', 'lv': 'Leviticus',
  'num': 'Numbers', 'nm': 'Numbers', 'nu': 'Numbers',
  'deut': 'Deuteronomy', 'dt': 'Deuteronomy', 'deu': 'Deuteronomy',
  'josh': 'Joshua', 'jos': 'Joshua',
  'judg': 'Judges', 'jdg': 'Judges', 'jgs': 'Judges',
  'ru': 'Ruth', 'rth': 'Ruth',
  '1 sam': '1 Samuel', '1sam': '1 Samuel', '1 sm': '1 Samuel',
  '2 sam': '2 Samuel', '2sam': '2 Samuel', '2 sm': '2 Samuel',
  '1 kg': '1 Kings', '1 kgs': '1 Kings', '1kgs': '1 Kings', '1 kin': '1 Kings',
  '2 kg': '2 Kings', '2 kgs': '2 Kings', '2kgs': '2 Kings', '2 kin': '2 Kings',
  '1 chr': '1 Chronicles', '1 chron': '1 Chronicles', '1chr': '1 Chronicles',
  '2 chr': '2 Chronicles', '2 chron': '2 Chronicles', '2chr': '2 Chronicles',
  'ezr': 'Ezra',
  'neh': 'Nehemiah',
  'est': 'Esther', 'esth': 'Esther',
  'jb': 'Job',
  'psalm': 'Psalms', 'ps': 'Psalms', 'psa': 'Psalms', 'psm': 'Psalms',
  'pss': 'Psalms', 'pslm': 'Psalms',
  'pr': 'Proverbs', 'prov': 'Proverbs', 'prv': 'Proverbs', 'prvb': 'Proverbs',
  'eccl': 'Ecclesiastes', 'ec': 'Ecclesiastes', 'eccle': 'Ecclesiastes',
  'qoh': 'Ecclesiastes', 'qoheleth': 'Ecclesiastes',
  'song': 'Song of Solomon', 'song of songs': 'Song of Solomon',
  'sos': 'Song of Solomon', 'sg': 'Song of Solomon',
  'canticles': 'Song of Solomon',
  'isa': 'Isaiah', 'is': 'Isaiah',
  'jer': 'Jeremiah', 'jr': 'Jeremiah',
  'lam': 'Lamentations',
  'ezek': 'Ezekiel', 'eze': 'Ezekiel', 'ezk': 'Ezekiel',
  'dan': 'Daniel', 'dn': 'Daniel',
  'hos': 'Hosea',
  'jl': 'Joel',
  'am': 'Amos',
  'ob': 'Obadiah', 'obad': 'Obadiah',
  'jon': 'Jonah', 'jnh': 'Jonah',
  'mic': 'Micah', 'mi': 'Micah',
  'nah': 'Nahum', 'na': 'Nahum',
  'hab': 'Habakkuk',
  'zeph': 'Zephaniah', 'zep': 'Zephaniah',
  'hag': 'Haggai',
  'zech': 'Zechariah', 'zec': 'Zechariah',
  'mal': 'Malachi',

  // --- New Testament abbreviations ----------------------------------
  'matt': 'Matthew', 'mt': 'Matthew',
  'mk': 'Mark', 'mar': 'Mark', 'mrk': 'Mark',
  'lk': 'Luke', 'luk': 'Luke',
  'jn': 'John', 'jhn': 'John',
  'ac': 'Acts',
  'rom': 'Romans', 'rm': 'Romans', 'ro': 'Romans',
  '1 cor': '1 Corinthians', '1 co': '1 Corinthians', '1cor': '1 Corinthians',
  '2 cor': '2 Corinthians', '2 co': '2 Corinthians', '2cor': '2 Corinthians',
  'gal': 'Galatians',
  'eph': 'Ephesians',
  'phil': 'Philippians', 'php': 'Philippians', 'phl': 'Philippians',
  'col': 'Colossians',
  '1 thess': '1 Thessalonians', '1 thes': '1 Thessalonians', '1 th': '1 Thessalonians',
  '2 thess': '2 Thessalonians', '2 thes': '2 Thessalonians', '2 th': '2 Thessalonians',
  '1 tim': '1 Timothy', '1 tm': '1 Timothy',
  '2 tim': '2 Timothy', '2 tm': '2 Timothy',
  'tit': 'Titus',
  'phlm': 'Philemon', 'phm': 'Philemon',
  'heb': 'Hebrews',
  'jas': 'James', 'jms': 'James', 'jm': 'James',
  '1 pet': '1 Peter', '1 pt': '1 Peter',
  '2 pet': '2 Peter', '2 pt': '2 Peter',
  '1 jn': '1 John', '1 jhn': '1 John',
  '2 jn': '2 John', '2 jhn': '2 John',
  '3 jn': '3 John', '3 jhn': '3 John',
  'jud': 'Jude', 'jd': 'Jude',
  'rev': 'Revelation', 'revelations': 'Revelation', 'rv': 'Revelation',
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
//   "23"               → [{ch 23, v 1-ANY}]
//   "17:22"            → [{ch 17, v 22-22}]
//   "17:22-31"         → [{ch 17, v 22-31}]
//   "17:22-18:5"       → [{ch 17, v 22-ANY}, {ch 18, v 1-5}]   (cross-chapter)
//   "17-19"            → [{ch 17, v 1-ANY}, {ch 18, v 1-ANY}, {ch 19, v 1-ANY}]
//   "9:9-13, 18-26"    → [{ch 9, v 9-13}, {ch 9, v 18-26}]      (chained)
//   "9:9, 12"          → [{ch 9, v 9}, {ch 9, v 12}]
//   "5:1-12, 6:9-13"   → [{ch 5, v 1-12}, {ch 6, v 9-13}]
//
// Strategy: split on commas first, then parse each piece while
// tracking the most-recent chapter. Pieces without a colon inherit
// that chapter (so "18-26" after "9:9-13" means verses 18-26 of ch 9,
// NOT chapters 18-26). The first piece, if colon-less, is treated as
// a chapter range (so "1-3" by itself means whole chapters 1-3).
function parseChapterVerse(s) {
  if (!s) return [];
  const pieces = s.split(',').map((p) => p.trim()).filter(Boolean);
  const out = [];
  let lastChapter = null;

  for (const piece of pieces) {
    // Normalize en/em dashes to hyphen, then drop everything that isn't
    // a digit, colon, or hyphen. Strips trailing translation markers
    // ("3:16 NRSV" → "3:16"), parens, and stray whitespace.
    const t = piece.replace(/[–—]/g, '-').replace(/[^\d:\-]/g, '').trim();
    if (!t) continue;

    // Cross-chapter range "17:22-18:5"
    let m = t.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
    if (m) {
      const startCh = +m[1];
      const startV = +m[2];
      const endCh = +m[3];
      const endV = +m[4];
      if (startCh === endCh) {
        out.push({ chapter: startCh, startVerse: startV, endVerse: endV });
      } else {
        out.push({ chapter: startCh, startVerse: startV, endVerse: ANY_VERSE });
        for (let ch = startCh + 1; ch < endCh; ch++) {
          out.push({ chapter: ch, startVerse: 1, endVerse: ANY_VERSE });
        }
        out.push({ chapter: endCh, startVerse: 1, endVerse: endV });
      }
      lastChapter = endCh;
      continue;
    }

    // Single chapter, verse range "17:22-31"
    m = t.match(/^(\d+):(\d+)-(\d+)$/);
    if (m) {
      out.push({ chapter: +m[1], startVerse: +m[2], endVerse: +m[3] });
      lastChapter = +m[1];
      continue;
    }

    // Single verse "17:22"
    m = t.match(/^(\d+):(\d+)$/);
    if (m) {
      const ch = +m[1];
      const v = +m[2];
      out.push({ chapter: ch, startVerse: v, endVerse: v });
      lastChapter = ch;
      continue;
    }

    // Ambiguous "17-19" — chapter range if first piece, verse range in
    // lastChapter otherwise. This is what makes "9:9-13, 18-26" do the
    // right thing.
    m = t.match(/^(\d+)-(\d+)$/);
    if (m) {
      const a = +m[1];
      const b = +m[2];
      if (lastChapter !== null) {
        out.push({ chapter: lastChapter, startVerse: a, endVerse: b });
      } else {
        for (let ch = a; ch <= b; ch++) {
          out.push({ chapter: ch, startVerse: 1, endVerse: ANY_VERSE });
        }
        lastChapter = b;
      }
      continue;
    }

    // Ambiguous bare "23" — whole chapter if first piece, single verse
    // in lastChapter otherwise (so "9:9, 12, 15" parses cleanly).
    m = t.match(/^(\d+)$/);
    if (m) {
      const n = +m[1];
      if (lastChapter !== null) {
        out.push({ chapter: lastChapter, startVerse: n, endVerse: n });
      } else {
        out.push({ chapter: n, startVerse: 1, endVerse: ANY_VERSE });
        lastChapter = n;
      }
      continue;
    }
    // Piece didn't match any pattern — skip it. The caller no longer
    // falls back to "whole book" for an unparseable piece.
  }

  return out;
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
      // Couldn't make sense of the chapter:verse — DROP the citation
      // rather than falling back to "whole book". The whole-book
      // fallback caused a search for "Matthew 9:9-13, 18-26" to match
      // every resource tagged with any chapter of Matthew, because the
      // unparseable comma-list became "all of Matthew". If you want
      // whole-book behavior, write the citation as just "Matthew".
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

// =====================================================================
// Synoptic parallels
//
// Backed by /src/data/synopticParallels.json — parsed from the Aland
// synopsis table on bible-researcher.com. Each pericope lists the
// passage in each gospel it appears in (Matthew, Mark, Luke, John,
// any of which may be null).
//
// expandWithSynopticParallels takes a target range array (as produced
// by parseScriptureRanges) and returns a new array that ALSO contains
// the parallel passages from the other gospels for every pericope any
// input range overlaps.
//
// Use case: pastor searches "Matt 9:9-13" with the synoptic-parallels
// box ticked. We look up pericope 44 (Call of Levi), and add Mark
// 2:13-17 + Luke 5:27-32 to the target set. The downstream overlap
// loop then matches resources tagged with any of those three.
// =====================================================================

// Map gospel key → canonical BIBLE_BOOKS name. Lets us reuse rangesOverlap.
const GOSPEL_KEY_TO_BOOK = {
  matthew: 'Matthew',
  mark: 'Mark',
  luke: 'Luke',
  john: 'John',
};

// Pre-parse each pericope's gospel references once at module load. The
// chart has ~117 entries × up to 4 gospels — a few hundred range parses
// total. Worth caching since every search re-uses them.
const PERICOPE_RANGES = (() => {
  const out = [];
  for (const p of SYNOPTIC_PARALLELS) {
    const byGospel = {};
    for (const [key, book] of Object.entries(GOSPEL_KEY_TO_BOOK)) {
      const ref = p[key];
      if (!ref) continue;
      // The data file stores bare chapter:verse strings (e.g. "9:9-13").
      // Reconstitute with the gospel name so parseScriptureRanges can
      // handle the book lookup.
      const ranges = parseScriptureRanges(`${book} ${ref}`);
      if (ranges.length > 0) byGospel[key] = ranges;
    }
    out.push({
      no: p.no,
      pericope: p.pericope,
      byGospel,
    });
  }
  return out;
})();

/**
 * For every input range, find pericopes it overlaps and add the OTHER
 * gospels' ranges to the result. The original input ranges are always
 * preserved. Each added range carries `.parallelOf` = formatted source
 * range so the UI can explain *why* it was added.
 *
 * Returns a new array — does not mutate the input.
 */
export function expandWithSynopticParallels(inputRanges) {
  if (!Array.isArray(inputRanges) || inputRanges.length === 0) {
    return inputRanges || [];
  }
  // Dedupe by range identity so a pericope that gets matched twice
  // (e.g. by overlapping ranges in the user's input) doesn't double up.
  const out = [...inputRanges];
  const seen = new Set(out.map(rangeKey));

  for (const pericope of PERICOPE_RANGES) {
    // Which input range(s) triggered this pericope (if any)?
    const triggers = [];
    for (const [gKey, ranges] of Object.entries(pericope.byGospel)) {
      const book = GOSPEL_KEY_TO_BOOK[gKey];
      for (const ir of inputRanges) {
        if (ir.book !== book) continue;
        for (const pr of ranges) {
          if (rangesOverlap(ir, pr)) {
            triggers.push(ir);
            break;
          }
        }
        if (triggers.length > 0 && triggers[triggers.length - 1] === ir) break;
      }
    }
    if (triggers.length === 0) continue;

    // Add every OTHER gospel's ranges. Tag each with parallelOf info.
    const triggerLabel = triggers.map(formatRange).join(', ');
    for (const [gKey, ranges] of Object.entries(pericope.byGospel)) {
      const book = GOSPEL_KEY_TO_BOOK[gKey];
      // Skip the gospel(s) the trigger already covered.
      if (triggers.some((t) => t.book === book)) continue;
      for (const r of ranges) {
        const key = rangeKey(r);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ...r,
          parallelOf: triggerLabel,
          parallelPericope: pericope.pericope,
        });
      }
    }
  }
  return out;
}

function rangeKey(r) {
  return `${r.book}|${r.chapter ?? '*'}|${r.startVerse}|${r.endVerse}`;
}
