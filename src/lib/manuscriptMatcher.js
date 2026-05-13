// Score candidate sermons against the signals extracted from an
// imported manuscript. Returns the top 3 candidates with confidence
// 0-100 plus a bucket label ('high' | 'medium' | 'low' | 'none').
//
// Scoring philosophy:
//   - Title match (fuzzy):   up to 40 pts
//   - Scripture match:       up to 35 pts
//   - Date match (±days):    up to 25 pts
//
// Exact title or exact scripture both push high-confidence on their
// own; combined two-of-three signals reliably hit "high" bucket.

// ---- Scripture parsing helpers ------------------------------------

const BOOK_ALIASES = {
  // Normalize common variants so "1Cor", "1 Corinthians", "I Cor" all match.
  '1cor': '1corinthians', '1corinthians': '1corinthians', '1 cor': '1corinthians', 'i cor': '1corinthians',
  '2cor': '2corinthians', '2corinthians': '2corinthians', '2 cor': '2corinthians', 'ii cor': '2corinthians',
  '1thess': '1thessalonians', '1 thess': '1thessalonians',
  '2thess': '2thessalonians', '2 thess': '2thessalonians',
  '1tim': '1timothy', '2tim': '2timothy',
  '1pet': '1peter', '2pet': '2peter',
  '1jn': '1john', '2jn': '2john', '3jn': '3john',
  'matt': 'matthew', 'mk': 'mark', 'lk': 'luke', 'jn': 'john',
  'rom': 'romans', 'gal': 'galatians', 'eph': 'ephesians', 'phil': 'philippians',
  'col': 'colossians', 'rev': 'revelation', 'heb': 'hebrews', 'js': 'james',
  'gen': 'genesis', 'ex': 'exodus', 'exod': 'exodus', 'lev': 'leviticus',
  'num': 'numbers', 'deut': 'deuteronomy', 'josh': 'joshua', 'judg': 'judges',
  'ps': 'psalms', 'psa': 'psalms', 'psalm': 'psalms',
  'prov': 'proverbs', 'eccl': 'ecclesiastes', 'isa': 'isaiah', 'jer': 'jeremiah',
  'lam': 'lamentations', 'ezek': 'ezekiel', 'dan': 'daniel',
};

// Normalize a scripture reference for comparison: lowercase, strip
// punctuation, dedupe spaces, alias the book.
function normalizeScripture(s) {
  if (!s || typeof s !== 'string') return null;
  let t = s.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  // Try book aliasing — match the longest alias first.
  for (const alias of Object.keys(BOOK_ALIASES).sort((a, b) => b.length - a.length)) {
    if (t.startsWith(alias)) {
      t = BOOK_ALIASES[alias] + t.slice(alias.length);
      break;
    }
  }
  return t;
}

// Compare two scripture references and return 0-1 similarity.
//   1.0 = same book + same chapter:verse range
//   0.7 = same book + same chapter (different verse range)
//   0.5 = same book (different chapter)
//   0.0 = different book
function scriptureSimilarity(a, b) {
  const na = normalizeScripture(a);
  const nb = normalizeScripture(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  // Pull out book and chapter:verse parts.
  const split = (s) => {
    const m = /^([0-9a-z ]+?)\s+(\d+)(?::(\d+(?:[-–]\d+)?))?/.exec(s);
    return m ? { book: m[1].trim(), chapter: m[2], verse: m[3] || null } : null;
  };
  const pa = split(na), pb = split(nb);
  if (!pa || !pb) return 0;
  if (pa.book !== pb.book) return 0;
  if (pa.chapter !== pb.chapter) return 0.5;
  if (pa.verse === pb.verse) return 1;
  // Same chapter, different verses — 0.7. (Pastoral references often
  // crop or extend verse ranges between manuscripts and sermon detail
  // pages.)
  return 0.7;
}

// ---- Title fuzzy match --------------------------------------------

function tokenize(s) {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'sermon',
  'rev', 'pastor', 'preached', 'preaching', 'church', 'umc',
]);

// Jaccard similarity on token sets, plus a small bonus for a
// whole-substring match between the two titles.
function titleSimilarity(a, b) {
  if (!a || !b) return 0;
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.length === 0 || B.length === 0) return 0;
  const sa = new Set(A), sb = new Set(B);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  let j = union === 0 ? 0 : inter / union;
  // Whole-substring bonus.
  const an = a.toLowerCase(), bn = b.toLowerCase();
  if (an.length >= 6 && bn.length >= 6 && (an.includes(bn) || bn.includes(an))) {
    j = Math.min(1, j + 0.3);
  }
  return j;
}

// ---- Date proximity -----------------------------------------------

function dateProximity(isoA, isoB) {
  if (!isoA || !isoB) return 0;
  const a = new Date(isoA).getTime();
  const b = new Date(isoB).getTime();
  if (isNaN(a) || isNaN(b)) return 0;
  const days = Math.abs(a - b) / (1000 * 60 * 60 * 24);
  if (days === 0) return 1;
  if (days <= 1) return 0.95;
  if (days <= 7) return 0.85;
  if (days <= 14) return 0.7;
  if (days <= 30) return 0.4;
  if (days <= 90) return 0.2;
  return 0;
}

// ---- Top-level: score a single candidate --------------------------

function scoreCandidate(signals, sermon) {
  let titleSim = 0, scriptureSim = 0, dateSim = 0;
  if (signals.title && sermon.title) {
    titleSim = titleSimilarity(signals.title, sermon.title);
  }
  if (signals.scripture && sermon.scripture_reference) {
    scriptureSim = scriptureSimilarity(signals.scripture, sermon.scripture_reference);
  }
  // Pull a date off the sermon — could be on sermons.preached_at_first
  // OR on the joined preachings list. The matcher caller passes the
  // best date it knows about as `preached_at` on the sermon record.
  if (signals.preached_at && sermon.preached_at) {
    dateSim = dateProximity(signals.preached_at, sermon.preached_at);
  }
  // Weighted score (max 100).
  const score = Math.round(
    titleSim * 40 + scriptureSim * 35 + dateSim * 25
  );
  return {
    sermon_id: sermon.id,
    sermon,
    score,
    breakdown: {
      title: Math.round(titleSim * 100),
      scripture: Math.round(scriptureSim * 100),
      date: Math.round(dateSim * 100),
    },
  };
}

// Bucket by score.
//   >= 85 → high
//   50-84 → medium
//   25-49 → low
//   < 25  → none
function bucketFor(score) {
  if (score >= 85) return 'high';
  if (score >= 50) return 'medium';
  if (score >= 25) return 'low';
  return 'none';
}

// Public entry: rank all sermons against the manuscript signals,
// return top 3 + a bucket for the BEST candidate.
export function rankCandidates(signals, sermons) {
  if (!signals || !Array.isArray(sermons) || sermons.length === 0) {
    return { topCandidates: [], bucket: 'none' };
  }
  const scored = sermons
    .map((s) => scoreCandidate(signals, s))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const bucket = scored.length > 0 ? bucketFor(scored[0].score) : 'none';
  return { topCandidates: scored, bucket };
}
