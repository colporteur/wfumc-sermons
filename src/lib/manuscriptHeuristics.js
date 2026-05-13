// Heuristic extractors for matching imported manuscripts to existing
// sermon detail pages.
//
// Each manuscript can carry up to three signals we use for matching:
//   - title (string, possibly fuzzy)
//   - scripture reference (string, possibly fuzzy)
//   - preached_at date (ISO YYYY-MM-DD)
//
// We mine them from two sources:
//   - the FILENAME (often more reliable than document content because
//     the pastor named the file deliberately)
//   - the document TEXT (especially the first ~500 chars for title +
//     scripture, and the last ~1500 for footer date)
//
// The matcher consumes the merged signal set and scores against
// candidate sermons.

// Common Bible book name variants — used both for scripture detection
// and for cleaning books out of titles when they collide with Pastor
// Todd's filename patterns ("Whom We Worship - Acts 17.docx").
const BIBLE_BOOK_RE =
  /\b(Genesis|Exodus|Leviticus|Numbers|Deuteronomy|Joshua|Judges|Ruth|1 ?Samuel|2 ?Samuel|1 ?Kings|2 ?Kings|1 ?Chronicles|2 ?Chronicles|Ezra|Nehemiah|Esther|Job|Psalms?|Proverbs|Ecclesiastes|Song of (?:Songs|Solomon)|Isaiah|Jeremiah|Lamentations|Ezekiel|Daniel|Hosea|Joel|Amos|Obadiah|Jonah|Micah|Nahum|Habakkuk|Zephaniah|Haggai|Zechariah|Malachi|Matthew|Mark|Luke|John|Acts|Romans|1 ?Corinthians|2 ?Corinthians|Galatians|Ephesians|Philippians|Colossians|1 ?Thessalonians|2 ?Thessalonians|1 ?Timothy|2 ?Timothy|Titus|Philemon|Hebrews|James|1 ?Peter|2 ?Peter|1 ?John|2 ?John|3 ?John|Jude|Revelation)\b/i;

// Full scripture reference including chapter/verse, e.g. "John 3:16-21",
// "1 Corinthians 13", "Acts 17:22-31".
const SCRIPTURE_REF_RE = new RegExp(
  BIBLE_BOOK_RE.source + '\\s+\\d+(?::\\d+(?:[-–]\\d+)?)?',
  'gi'
);

// Date patterns in filenames — try a few common shapes.
const FILENAME_DATE_PATTERNS = [
  /\b(\d{4})-(\d{2})-(\d{2})\b/,                        // 2023-04-09
  /\b(\d{4})_(\d{2})_(\d{2})\b/,                        // 2023_04_09
  /\b(\d{4})\.(\d{2})\.(\d{2})\b/,                      // 2023.04.09
  /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/,                    // 4-9-2023
  /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/,                  // 4.9.2023
];

function pad2(n) { return String(n).padStart(2, '0'); }

// Try to pull a YYYY-MM-DD out of an arbitrary string. Tries the
// strict patterns first, then falls back to Date.parse for things
// like "April 9, 2023".
export function extractDateFromString(s) {
  if (!s) return null;
  for (const re of FILENAME_DATE_PATTERNS) {
    const m = re.exec(s);
    if (!m) continue;
    let y, mo, d;
    if (m[0].length === 10 && m[0][4] && /[-_.]/.test(m[0][4])) {
      // YYYY-MM-DD-ish
      y = m[1]; mo = m[2]; d = m[3];
    } else {
      // M-D-YYYY-ish — bail if month or day exceed reasonable bounds
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > 12 || b > 31 || a < 1 || b < 1) continue;
      y = m[3]; mo = pad2(a); d = pad2(b);
    }
    const iso = `${y}-${mo}-${d}`;
    if (!isNaN(new Date(iso).getTime())) return iso;
  }
  // Fallback: Date.parse can handle "April 9, 2023" etc.
  const direct = new Date(s);
  if (!isNaN(direct.getTime()) && /\d{4}/.test(s)) {
    return direct.toISOString().slice(0, 10);
  }
  return null;
}

// Strip the .docx / .enex suffix and any leading/trailing path remnants.
function basename(filename) {
  return (filename || '')
    .split(/[\\/]/).pop()
    .replace(/\.(docx|doc|enex|txt|md)$/i, '')
    .trim();
}

// Pull a scripture-shaped reference out of an arbitrary string.
// Returns the FIRST match, normalized.
export function extractScriptureFromString(s) {
  if (!s) return null;
  SCRIPTURE_REF_RE.lastIndex = 0;
  const m = SCRIPTURE_REF_RE.exec(s);
  return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}

// Extract a likely TITLE from the filename. Strips date, scripture,
// location markers, and common separators, then returns what's left.
export function extractTitleFromFilename(filename) {
  let s = basename(filename);
  if (!s) return null;
  // Strip dates (any of the patterns we recognize).
  for (const re of FILENAME_DATE_PATTERNS) {
    s = s.replace(re, '');
  }
  // Strip scripture refs.
  s = s.replace(SCRIPTURE_REF_RE, '');
  // Strip common location markers — Pastor Todd's churches.
  s = s.replace(/\b(Wedowee|WFUMC|Grace|Epworth|UMC)\b/gi, '');
  // Strip leading/trailing separators and double spaces.
  s = s.replace(/[-_·•]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s || null;
}

// Extract a likely TITLE from document content — usually the first
// non-empty paragraph, capped at ~80 chars.
export function extractTitleFromContent(text) {
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 5)) {
    // Skip lines that look like scripture refs or date-only lines.
    if (SCRIPTURE_REF_RE.test(line)) {
      SCRIPTURE_REF_RE.lastIndex = 0;
      continue;
    }
    SCRIPTURE_REF_RE.lastIndex = 0;
    if (extractDateFromString(line)) continue;
    if (line.length < 4) continue;
    return line.slice(0, 120);
  }
  return null;
}

// Extract a likely SCRIPTURE reference. Look in filename first, then
// the first ~500 chars of the document (sermons often print the
// reference under the title).
export function extractScriptureFromFilenameOrContent(filename, text) {
  const fromName = extractScriptureFromString(filename);
  if (fromName) return fromName;
  const head = (text || '').slice(0, 500);
  return extractScriptureFromString(head);
}

// Extract a likely DATE following the precedence:
//   (1) filename
//   (2) footerDate (already extracted by manuscriptParser)
//   (3) fileModifiedAt fallback
// Returns { date, source } so the matcher can weight by source quality.
export function pickPreachedDate({ filename, footerDate, fileModifiedAt }) {
  const fromFilename = extractDateFromString(basename(filename));
  if (fromFilename) return { date: fromFilename, source: 'filename' };
  if (footerDate) return { date: footerDate, source: 'footer' };
  if (fileModifiedAt) return { date: fileModifiedAt, source: 'fileModified' };
  return { date: null, source: null };
}

// All-in-one signal extractor used by the importer. Takes a parsed
// manuscript record (from manuscriptParser) and returns the signals
// the matcher will score against.
export function extractSignals(parsed) {
  const filenameTitle = extractTitleFromFilename(parsed.filename);
  const contentTitle = extractTitleFromContent(parsed.text);
  // Prefer filename title if it's substantial; ENEX entries often have
  // a meaningful note title set by the pastor too.
  const title =
    parsed.enexTitle ||
    (filenameTitle && filenameTitle.length >= 4 ? filenameTitle : contentTitle) ||
    contentTitle ||
    filenameTitle;
  const scripture = extractScriptureFromFilenameOrContent(
    parsed.filename,
    parsed.text
  );
  const preached = pickPreachedDate({
    filename: parsed.filename,
    footerDate: parsed.footerDate,
    fileModifiedAt: parsed.fileModifiedAt,
  });
  return {
    title: title || null,
    scripture: scripture || null,
    preached_at: preached.date,
    preached_at_source: preached.source,
  };
}
