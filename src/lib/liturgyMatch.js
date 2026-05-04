// Auto-link a liturgy to one or more of the user's sermons by matching
// the liturgy's title (and any scripture refs detected on it) against
// the sermons table.
//
// Output for each candidate match:
//   { sermon_id, link_kind, confidence, approved }
//
// Confidence rules (high → auto-approved, lower → pending review):
//
//   high   — exact title contains an exact sermon title (>=4 chars),
//            OR scripture refs share a verse-level overlap.
//   medium — significant title-word overlap (>=2 words >=4 chars),
//            OR scripture refs share a chapter (no verse overlap).
//   low    — single significant word in common, OR same scripture book
//            with no chapter/verse match.
//
// Higher of the two (title vs scripture) wins. Multiple sermons may
// match a single liturgy — we return all candidates above the low
// threshold; the import flow auto-creates approved=true for high and
// approved=false for medium/low.

// ---- Scripture parsing (lightweight; we don't ship the full worship-app parser here) ----

const BIBLE_BOOK_PATTERNS = [
  // OT
  ['Genesis', /\bgen(?:esis)?\b/i],
  ['Exodus', /\bexod(?:us)?\b|\bex\b/i],
  ['Leviticus', /\blev(?:iticus)?\b/i],
  ['Numbers', /\bnum(?:bers)?\b/i],
  ['Deuteronomy', /\bdeut(?:eronomy)?\b|\bdt\b/i],
  ['Joshua', /\bjosh(?:ua)?\b/i],
  ['Judges', /\bjudg(?:es)?\b/i],
  ['Ruth', /\bruth\b/i],
  ['1 Samuel', /\b(?:1|i)\s*sam(?:uel)?\b/i],
  ['2 Samuel', /\b(?:2|ii)\s*sam(?:uel)?\b/i],
  ['1 Kings', /\b(?:1|i)\s*kings?\b/i],
  ['2 Kings', /\b(?:2|ii)\s*kings?\b/i],
  ['1 Chronicles', /\b(?:1|i)\s*chr(?:on(?:icles)?)?\b/i],
  ['2 Chronicles', /\b(?:2|ii)\s*chr(?:on(?:icles)?)?\b/i],
  ['Ezra', /\bezra\b/i],
  ['Nehemiah', /\bneh(?:emiah)?\b/i],
  ['Esther', /\besth?(?:er)?\b/i],
  ['Job', /\bjob\b/i],
  ['Psalms', /\bpsalms?\b|\bps\b/i],
  ['Proverbs', /\bprov(?:erbs)?\b/i],
  ['Ecclesiastes', /\beccl(?:esiastes)?\b/i],
  ['Song of Solomon', /\bsong\s+of\s+(?:solomon|songs)\b|\bsos\b/i],
  ['Isaiah', /\bis(?:aiah|a)?\b/i],
  ['Jeremiah', /\bjer(?:emiah)?\b/i],
  ['Lamentations', /\blam(?:entations)?\b/i],
  ['Ezekiel', /\bezek(?:iel)?\b/i],
  ['Daniel', /\bdan(?:iel)?\b/i],
  ['Hosea', /\bhos(?:ea)?\b/i],
  ['Joel', /\bjoel\b/i],
  ['Amos', /\bamos\b/i],
  ['Obadiah', /\bobad(?:iah)?\b/i],
  ['Jonah', /\bjonah\b/i],
  ['Micah', /\bmic(?:ah)?\b/i],
  ['Nahum', /\bnah(?:um)?\b/i],
  ['Habakkuk', /\bhab(?:akkuk)?\b/i],
  ['Zephaniah', /\bzeph(?:aniah)?\b/i],
  ['Haggai', /\bhag(?:gai)?\b/i],
  ['Zechariah', /\bzech(?:ariah)?\b/i],
  ['Malachi', /\bmal(?:achi)?\b/i],
  // NT
  ['Matthew', /\bmatt?(?:hew)?\b/i],
  ['Mark', /\bmark\b|\bmk\b/i],
  ['Luke', /\bluke\b|\blk\b/i],
  ['John', /\bjohn\b|\bjn\b/i],
  ['Acts', /\bacts\b/i],
  ['Romans', /\brom(?:ans)?\b/i],
  ['1 Corinthians', /\b(?:1|i)\s*cor(?:inthians)?\b/i],
  ['2 Corinthians', /\b(?:2|ii)\s*cor(?:inthians)?\b/i],
  ['Galatians', /\bgal(?:atians)?\b/i],
  ['Ephesians', /\beph(?:esians)?\b/i],
  ['Philippians', /\bphil(?:ippians)?\b/i],
  ['Colossians', /\bcol(?:ossians)?\b/i],
  ['1 Thessalonians', /\b(?:1|i)\s*thess?(?:alonians)?\b/i],
  ['2 Thessalonians', /\b(?:2|ii)\s*thess?(?:alonians)?\b/i],
  ['1 Timothy', /\b(?:1|i)\s*tim(?:othy)?\b/i],
  ['2 Timothy', /\b(?:2|ii)\s*tim(?:othy)?\b/i],
  ['Titus', /\btitus\b/i],
  ['Philemon', /\bphlm\b|\bphilemon\b/i],
  ['Hebrews', /\bheb(?:rews)?\b/i],
  ['James', /\bjas\b|\bjames\b/i],
  ['1 Peter', /\b(?:1|i)\s*pet(?:er)?\b/i],
  ['2 Peter', /\b(?:2|ii)\s*pet(?:er)?\b/i],
  ['1 John', /\b(?:1|i)\s*j(?:n|ohn)\b/i],
  ['2 John', /\b(?:2|ii)\s*j(?:n|ohn)\b/i],
  ['3 John', /\b(?:3|iii)\s*j(?:n|ohn)\b/i],
  ['Jude', /\bjude\b/i],
  ['Revelation', /\brev(?:elation)?\b/i],
];

// Detect scripture refs in a text. Returns array of
// { book, chapter, verses: Set<number>|null }.
// Tries to find "Book Chapter:Verse(s)" patterns.
export function detectScriptureRefs(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  for (const [book, pattern] of BIBLE_BOOK_PATTERNS) {
    // Build a more specific regex: book name + optional space + chapter[:verses]
    const re = new RegExp(
      pattern.source +
        '\\s*(\\d+)(?:\\s*:\\s*([\\d,\\s\\-–—]+))?',
      'gi'
    );
    let m;
    while ((m = re.exec(text)) !== null) {
      const chapter = parseInt(m[1], 10);
      if (!Number.isFinite(chapter)) continue;
      const verseSpec = (m[2] || '').trim();
      let verses = null;
      if (verseSpec) {
        verses = new Set();
        for (const part of verseSpec.split(/\s*,\s*/)) {
          const range = part.split(/\s*[-–—]\s*/);
          if (range.length === 1) {
            const v = parseInt(range[0], 10);
            if (Number.isFinite(v)) verses.add(v);
          } else {
            const start = parseInt(range[0], 10);
            const end = parseInt(range[1], 10);
            if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
              for (let v = start; v <= end && verses.size < 200; v++) verses.add(v);
            }
          }
        }
        if (verses.size === 0) verses = null;
      }
      out.push({ book, chapter, verses });
    }
  }
  return out;
}

// Compare two parsed-ref arrays. Returns strongest tier:
//   'verse' | 'chapter' | 'book' | 'none'
export function compareRefs(refsA, refsB) {
  let best = 'none';
  const rank = { verse: 3, chapter: 2, book: 1, none: 0 };
  for (const a of refsA) {
    for (const b of refsB) {
      if (a.book !== b.book) continue;
      let tier = 'book';
      if (a.chapter === b.chapter) {
        tier = 'chapter';
        if (a.verses && b.verses) {
          for (const v of a.verses) {
            if (b.verses.has(v)) {
              tier = 'verse';
              break;
            }
          }
        } else {
          tier = 'verse'; // one whole-chapter ref counts as verse-level overlap
        }
      }
      if (rank[tier] > rank[best]) best = tier;
      if (best === 'verse') return best;
    }
  }
  return best;
}

// ---- Title matching ----

// Strip noise from a title for comparison: lowercase, drop punctuation,
// drop short words.
export function titleTokens(s) {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4); // drop "the", "of", "a", etc.
}

export function exactTitleContains(haystack, needle) {
  if (!haystack || !needle || needle.length < 4) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// ---- Match one liturgy against an array of sermons. ----

/**
 * @param {Object} liturgy  { title, scripture_refs, body? }
 * @param {Array}  sermons  [{ id, title, scripture_reference }]
 * @returns {Array<{sermon_id, link_kind, confidence, approved, why}>}
 */
export function matchLiturgyToSermons(liturgy, sermons) {
  if (!liturgy || !Array.isArray(sermons) || sermons.length === 0) return [];
  const litTitle = (liturgy.title || '').trim();
  const litTitleTokens = titleTokens(litTitle);
  // Try to detect scripture from BOTH the liturgy's title AND its
  // scripture_refs field. Pastor often puts the text in the title.
  const litRefs = [
    ...detectScriptureRefs(litTitle),
    ...detectScriptureRefs(liturgy.scripture_refs || ''),
  ];

  const candidates = [];
  for (const s of sermons) {
    if (!s.id) continue;
    const sermonTitle = (s.title || '').trim();
    const sermonRefs = detectScriptureRefs(s.scripture_reference || '');

    // Title matching
    let titleScore = null; // 'high' | 'medium' | 'low' | null
    let titleWhy = null;
    if (sermonTitle && exactTitleContains(litTitle, sermonTitle)) {
      titleScore = 'high';
      titleWhy = `Liturgy title contains sermon title "${sermonTitle}".`;
    } else {
      const sermonTokens = titleTokens(sermonTitle);
      const overlap = sermonTokens.filter((t) =>
        litTitleTokens.includes(t)
      );
      if (overlap.length >= 3) {
        titleScore = 'medium';
        titleWhy = `Title shares ${overlap.length} significant words: ${overlap.join(', ')}.`;
      } else if (overlap.length >= 2) {
        titleScore = 'medium';
        titleWhy = `Title shares 2 words: ${overlap.join(', ')}.`;
      } else if (overlap.length === 1) {
        titleScore = 'low';
        titleWhy = `Title shares one word: ${overlap[0]}.`;
      }
    }

    // Scripture matching
    let scriptureScore = null;
    let scriptureWhy = null;
    if (litRefs.length > 0 && sermonRefs.length > 0) {
      const tier = compareRefs(litRefs, sermonRefs);
      if (tier === 'verse') {
        scriptureScore = 'high';
        scriptureWhy = `Scripture refs share verse-level overlap (${sermonRefs[0].book} ${sermonRefs[0].chapter}).`;
      } else if (tier === 'chapter') {
        scriptureScore = 'medium';
        scriptureWhy = `Scripture refs share chapter ${sermonRefs[0].book} ${sermonRefs[0].chapter}.`;
      } else if (tier === 'book') {
        scriptureScore = 'low';
        scriptureWhy = `Scripture refs share book ${sermonRefs[0].book}.`;
      }
    }

    // Combine — strongest wins, with link_kind reflecting which won.
    const rank = { high: 3, medium: 2, low: 1 };
    let best = null;
    let kind = null;
    let why = null;
    if (titleScore && (!scriptureScore || rank[titleScore] >= rank[scriptureScore])) {
      best = titleScore;
      kind = 'title_match';
      why = titleWhy;
    } else if (scriptureScore) {
      best = scriptureScore;
      kind = 'scripture_match';
      why = scriptureWhy;
    }

    if (!best) continue;
    candidates.push({
      sermon_id: s.id,
      link_kind: kind,
      confidence: best,
      approved: best === 'high',
      why,
    });
  }
  return candidates;
}

// ---- Reverse direction: given a sermon, find candidate liturgies ----

/**
 * Match one sermon against an array of liturgies. Mirror of
 * matchLiturgyToSermons but flipped: rates each liturgy against the
 * given sermon by title overlap and scripture overlap.
 *
 * @param {Object} sermon       { title, scripture_reference }
 * @param {Array}  liturgies    [{ id, title, scripture_refs }]
 * @returns {Array<{liturgy_id, link_kind, confidence, why}>}
 */
export function matchSermonToLiturgies(sermon, liturgies) {
  if (!sermon || !Array.isArray(liturgies) || liturgies.length === 0) {
    return [];
  }
  const sermonTitle = (sermon.title || '').trim();
  const sermonTokens = titleTokens(sermonTitle);
  const sermonRefs = detectScriptureRefs(sermon.scripture_reference || '');

  const out = [];
  for (const l of liturgies) {
    if (!l.id) continue;
    const litTitle = (l.title || '').trim();
    const litTitleTokens = titleTokens(litTitle);
    const litRefs = [
      ...detectScriptureRefs(litTitle),
      ...detectScriptureRefs(l.scripture_refs || ''),
    ];

    let titleScore = null;
    let titleWhy = null;
    if (sermonTitle && exactTitleContains(litTitle, sermonTitle)) {
      titleScore = 'high';
      titleWhy = `Liturgy title contains sermon title.`;
    } else {
      const overlap = sermonTokens.filter((t) => litTitleTokens.includes(t));
      if (overlap.length >= 3) {
        titleScore = 'medium';
        titleWhy = `${overlap.length} shared title words: ${overlap.join(', ')}.`;
      } else if (overlap.length === 2) {
        titleScore = 'medium';
        titleWhy = `2 shared title words: ${overlap.join(', ')}.`;
      } else if (overlap.length === 1) {
        titleScore = 'low';
        titleWhy = `1 shared title word: ${overlap[0]}.`;
      }
    }

    let scriptureScore = null;
    let scriptureWhy = null;
    if (litRefs.length > 0 && sermonRefs.length > 0) {
      const tier = compareRefs(litRefs, sermonRefs);
      if (tier === 'verse') {
        scriptureScore = 'high';
        scriptureWhy = `Verse-level scripture overlap (${sermonRefs[0].book} ${sermonRefs[0].chapter}).`;
      } else if (tier === 'chapter') {
        scriptureScore = 'medium';
        scriptureWhy = `Same chapter (${sermonRefs[0].book} ${sermonRefs[0].chapter}).`;
      } else if (tier === 'book') {
        scriptureScore = 'low';
        scriptureWhy = `Same book (${sermonRefs[0].book}).`;
      }
    }

    const rank = { high: 3, medium: 2, low: 1 };
    let best = null;
    let kind = null;
    let why = null;
    if (titleScore && (!scriptureScore || rank[titleScore] >= rank[scriptureScore])) {
      best = titleScore;
      kind = 'title_match';
      why = titleWhy;
    } else if (scriptureScore) {
      best = scriptureScore;
      kind = 'scripture_match';
      why = scriptureWhy;
    }
    if (!best) continue;
    out.push({
      liturgy_id: l.id,
      link_kind: kind,
      confidence: best,
      why,
    });
  }
  return out;
}

// ---- Single-mode matchers (used by the on-demand "Find by X" buttons) ----
//
// These return ALL candidates above a 'none' tier scored by ONE axis only,
// with the other axis ignored. Useful for the inline "show me possible
// scripture matches" / "show me possible title matches" panels — the
// user wants to see the full set in one direction without it being mixed
// with the other axis's results.

/** Liturgy → sermons, scripture-only matching. */
export function findSermonsByScripture(liturgy, sermons) {
  const litRefs = [
    ...detectScriptureRefs(liturgy.title || ''),
    ...detectScriptureRefs(liturgy.scripture_refs || ''),
  ];
  if (litRefs.length === 0) return [];
  const out = [];
  for (const s of sermons) {
    const sRefs = detectScriptureRefs(s.scripture_reference || '');
    if (sRefs.length === 0) continue;
    const tier = compareRefs(litRefs, sRefs);
    if (tier === 'none') continue;
    const conf = tier === 'verse' ? 'high' : tier === 'chapter' ? 'medium' : 'low';
    out.push({
      sermon_id: s.id,
      link_kind: 'scripture_match',
      confidence: conf,
      why:
        tier === 'verse'
          ? `Verse overlap (${sRefs[0].book} ${sRefs[0].chapter})`
          : tier === 'chapter'
            ? `Same chapter (${sRefs[0].book} ${sRefs[0].chapter})`
            : `Same book (${sRefs[0].book})`,
    });
  }
  return out.sort(
    (a, b) =>
      ({ high: 3, medium: 2, low: 1 }[b.confidence] || 0) -
      ({ high: 3, medium: 2, low: 1 }[a.confidence] || 0)
  );
}

/** Liturgy → sermons, title-only matching. */
export function findSermonsByTitle(liturgy, sermons) {
  const litTitle = (liturgy.title || '').trim();
  if (!litTitle) return [];
  const litTokens = titleTokens(litTitle);
  const out = [];
  for (const s of sermons) {
    const sTitle = (s.title || '').trim();
    if (!sTitle) continue;
    if (exactTitleContains(litTitle, sTitle)) {
      out.push({
        sermon_id: s.id,
        link_kind: 'title_match',
        confidence: 'high',
        why: 'Liturgy title contains sermon title.',
      });
      continue;
    }
    const sTokens = titleTokens(sTitle);
    const overlap = sTokens.filter((t) => litTokens.includes(t));
    if (overlap.length >= 3) {
      out.push({
        sermon_id: s.id,
        link_kind: 'title_match',
        confidence: 'medium',
        why: `${overlap.length} shared words: ${overlap.join(', ')}`,
      });
    } else if (overlap.length === 2) {
      out.push({
        sermon_id: s.id,
        link_kind: 'title_match',
        confidence: 'medium',
        why: `2 shared words: ${overlap.join(', ')}`,
      });
    } else if (overlap.length === 1) {
      out.push({
        sermon_id: s.id,
        link_kind: 'title_match',
        confidence: 'low',
        why: `1 shared word: ${overlap[0]}`,
      });
    }
  }
  return out.sort(
    (a, b) =>
      ({ high: 3, medium: 2, low: 1 }[b.confidence] || 0) -
      ({ high: 3, medium: 2, low: 1 }[a.confidence] || 0)
  );
}

/** Sermon → liturgies, scripture-only matching. */
export function findLiturgiesByScripture(sermon, liturgies) {
  const sRefs = detectScriptureRefs(sermon.scripture_reference || '');
  if (sRefs.length === 0) return [];
  const out = [];
  for (const l of liturgies) {
    const litRefs = [
      ...detectScriptureRefs(l.title || ''),
      ...detectScriptureRefs(l.scripture_refs || ''),
    ];
    if (litRefs.length === 0) continue;
    const tier = compareRefs(litRefs, sRefs);
    if (tier === 'none') continue;
    const conf = tier === 'verse' ? 'high' : tier === 'chapter' ? 'medium' : 'low';
    out.push({
      liturgy_id: l.id,
      link_kind: 'scripture_match',
      confidence: conf,
      why:
        tier === 'verse'
          ? `Verse overlap (${sRefs[0].book} ${sRefs[0].chapter})`
          : tier === 'chapter'
            ? `Same chapter (${sRefs[0].book} ${sRefs[0].chapter})`
            : `Same book (${sRefs[0].book})`,
    });
  }
  return out.sort(
    (a, b) =>
      ({ high: 3, medium: 2, low: 1 }[b.confidence] || 0) -
      ({ high: 3, medium: 2, low: 1 }[a.confidence] || 0)
  );
}

/** Sermon → liturgies, title-only matching. */
export function findLiturgiesByTitle(sermon, liturgies) {
  const sTitle = (sermon.title || '').trim();
  if (!sTitle) return [];
  const sTokens = titleTokens(sTitle);
  const out = [];
  for (const l of liturgies) {
    const litTitle = (l.title || '').trim();
    if (!litTitle) continue;
    if (exactTitleContains(litTitle, sTitle)) {
      out.push({
        liturgy_id: l.id,
        link_kind: 'title_match',
        confidence: 'high',
        why: 'Liturgy title contains sermon title.',
      });
      continue;
    }
    const litTokens = titleTokens(litTitle);
    const overlap = sTokens.filter((t) => litTokens.includes(t));
    if (overlap.length >= 3) {
      out.push({
        liturgy_id: l.id,
        link_kind: 'title_match',
        confidence: 'medium',
        why: `${overlap.length} shared words: ${overlap.join(', ')}`,
      });
    } else if (overlap.length === 2) {
      out.push({
        liturgy_id: l.id,
        link_kind: 'title_match',
        confidence: 'medium',
        why: `2 shared words: ${overlap.join(', ')}`,
      });
    } else if (overlap.length === 1) {
      out.push({
        liturgy_id: l.id,
        link_kind: 'title_match',
        confidence: 'low',
        why: `1 shared word: ${overlap[0]}`,
      });
    }
  }
  return out.sort(
    (a, b) =>
      ({ high: 3, medium: 2, low: 1 }[b.confidence] || 0) -
      ({ high: 3, medium: 2, low: 1 }[a.confidence] || 0)
  );
}
