// Word-level diff for the Sermon Workspace.
//
// Returns a sequence of { type: 'eq' | 'add' | 'del', text: string }
// segments. Render directly: 'eq' → plain text, 'add' → green
// background, 'del' → red strikethrough.
//
// Two-stage strategy (the key to clean output on prose):
//
//   1. Split each text into paragraphs and run LCS at the paragraph
//      level. Unchanged paragraphs become solid anchors that prevent
//      the diff from misaligning huge chunks because of incidental
//      shared words elsewhere in the manuscript.
//
//   2. For groups of changed paragraphs (consecutive non-eq ops):
//      do bipartite matching by Jaccard similarity to pair each
//      deleted paragraph with its most-similar added paragraph.
//      Matched pairs become "modifications" — word-LCS them in
//      place. Unmatched paragraphs render as pure adds or deletes.
//
// Comparison ignores curly-vs-straight quote-style differences so a
// pipeline that re-encodes "isn't" as "isn't" doesn't show every
// contraction as a change. Display preserves whatever was actually
// in the manuscript.

const LCS_CELL_CAP = 4_000_000; // Word-LCS cap inside a single paragraph
const SIMILARITY_THRESHOLD = 0.3; // Jaccard cutoff for "this is a mod"

// Normalize curly/typographic quotes to straight ones for COMPARISON
// purposes only. Display still uses the original text.
function normCmp(s) {
  if (!s) return s;
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

// Split text into a sequence of tokens that, when concatenated, equal
// the original text exactly. Three classes:
//   - whitespace runs (\s+)
//   - punctuation runs ([.,;:!?'"“”‘’()—–\-])
//   - everything else (word / number runs)
const TOKEN_RE = /\s+|[.,;:!?'"“”‘’()—–\-]+|[^\s.,;:!?'"“”‘’()—–\-]+/g;

export function tokenize(s) {
  if (!s) return [];
  return s.match(TOKEN_RE) || [];
}

// Split text into paragraphs while preserving their trailing blank-line
// separators, so concatenating the result reproduces the original text
// exactly. A paragraph is anything between blank-line boundaries.
const PARA_SEPARATOR_RE = /\n[ \t]*\n+/g;

function splitParagraphs(text) {
  if (!text) return [];
  const parts = [];
  let lastIdx = 0;
  PARA_SEPARATOR_RE.lastIndex = 0;
  let m;
  while ((m = PARA_SEPARATOR_RE.exec(text)) !== null) {
    const endOfPara = m.index + m[0].length;
    parts.push(text.slice(lastIdx, endOfPara));
    lastIdx = endOfPara;
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }
  return parts;
}

// =====================================================================
// Public entry
// =====================================================================

export function diffWords(oldText, newText) {
  if (oldText === newText) {
    return oldText ? [{ type: 'eq', text: oldText }] : [];
  }
  // Quote-style-only difference? Treat as identical.
  if (normCmp(oldText) === normCmp(newText)) {
    return oldText ? [{ type: 'eq', text: oldText }] : [];
  }

  const oldParas = splitParagraphs(oldText || '');
  const newParas = splitParagraphs(newText || '');

  if (oldParas.length === 0 && newParas.length === 0) return [];
  if (oldParas.length === 0) {
    return [{ type: 'add', text: newParas.join('') }];
  }
  if (newParas.length === 0) {
    return [{ type: 'del', text: oldParas.join('') }];
  }

  // Stage 1: paragraph-level LCS. Common paragraphs become anchors.
  const paraOps = paragraphLcs(oldParas, newParas);

  // Stage 2: within each contiguous run of changed paragraphs,
  // bipartite-match dels to adds by similarity.
  const refined = pairUpModifications(paraOps);

  const segments = [];
  for (const op of refined) {
    if (op.type === 'eq') {
      segments.push({ type: 'eq', text: op.text });
    } else if (op.type === 'mod') {
      segments.push(...wordLevelDiff(op.oldText, op.newText));
    } else if (op.type === 'del') {
      segments.push({ type: 'del', text: op.text });
    } else {
      segments.push({ type: 'add', text: op.text });
    }
  }
  return coalesce(segments);
}

// =====================================================================
// Paragraph-level LCS
// Comparison uses normalized text so smart-quote-only differences
// don't fragment the alignment; the original text is what we emit.
// =====================================================================

function paragraphLcs(a, b) {
  const m = a.length;
  const n = b.length;
  const aN = a.map(normCmp);
  const bN = b.map(normCmp);

  // Trim common prefix / suffix paragraphs first.
  let pre = 0;
  while (pre < m && pre < n && aN[pre] === bN[pre]) pre++;
  let suf = 0;
  while (
    suf < m - pre &&
    suf < n - pre &&
    aN[m - 1 - suf] === bN[n - 1 - suf]
  ) {
    suf++;
  }
  const aMid = a.slice(pre, m - suf);
  const bMid = b.slice(pre, n - suf);
  const aMidN = aN.slice(pre, m - suf);
  const bMidN = bN.slice(pre, n - suf);

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ type: 'eq', text: a[i] });
  ops.push(...lcsParagraphMiddle(aMid, bMid, aMidN, bMidN));
  for (let i = m - suf; i < m; i++) ops.push({ type: 'eq', text: a[i] });
  return ops;
}

function lcsParagraphMiddle(a, b, aN, bN) {
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) return [];
  if (m === 0) return b.map((p) => ({ type: 'add', text: p }));
  if (n === 0) return a.map((p) => ({ type: 'del', text: p }));

  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    const ai = aN[i - 1];
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= n; j++) {
      row[j] =
        ai === bN[j - 1]
          ? prev[j - 1] + 1
          : prev[j] >= row[j - 1]
          ? prev[j]
          : row[j - 1];
    }
  }

  const ops = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aN[i - 1] === bN[j - 1]) {
      ops.push({ type: 'eq', text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'add', text: b[j - 1] });
      j--;
    } else {
      ops.push({ type: 'del', text: a[i - 1] });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

// =====================================================================
// Pair-up: bipartite matching within each contiguous change group.
// Greedy by descending similarity — for each (del, add) pair above
// the threshold, assign matches highest-sim-first until no more
// candidates remain. Unmatched dels and adds stay as pure ops.
// =====================================================================

function pairUpModifications(ops) {
  const out = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'eq') {
      out.push(ops[i]);
      i++;
      continue;
    }
    // Walk to the end of the contiguous non-eq group.
    const groupStart = i;
    while (i < ops.length && ops[i].type !== 'eq') i++;
    const groupEnd = i;

    // Index dels and adds within the group, preserving original order.
    const dels = [];
    const adds = [];
    for (let k = groupStart; k < groupEnd; k++) {
      const op = ops[k];
      if (op.type === 'del') dels.push({ pos: k, text: op.text });
      else adds.push({ pos: k, text: op.text });
    }

    // Score every (del, add) pair above the similarity threshold.
    const candidates = [];
    for (let d = 0; d < dels.length; d++) {
      for (let aIdx = 0; aIdx < adds.length; aIdx++) {
        const sim = jaccardSimilarity(dels[d].text, adds[aIdx].text);
        if (sim >= SIMILARITY_THRESHOLD) {
          candidates.push({ d, a: aIdx, sim });
        }
      }
    }
    candidates.sort((x, y) => y.sim - x.sim);

    const matchedD = new Set();
    const matchedA = new Set();
    const dToA = new Map();
    for (const c of candidates) {
      if (matchedD.has(c.d) || matchedA.has(c.a)) continue;
      matchedD.add(c.d);
      matchedA.add(c.a);
      dToA.set(c.d, c.a);
    }

    // Emit results in the original op order. A matched del emits a
    // 'mod' op carrying its paired add's text; a matched add is
    // skipped (its mod was already emitted at the del's position).
    let dCursor = 0;
    let aCursor = 0;
    for (let k = groupStart; k < groupEnd; k++) {
      const op = ops[k];
      if (op.type === 'del') {
        if (dToA.has(dCursor)) {
          const aIdx = dToA.get(dCursor);
          out.push({
            type: 'mod',
            oldText: dels[dCursor].text,
            newText: adds[aIdx].text,
          });
        } else {
          out.push({ type: 'del', text: op.text });
        }
        dCursor++;
      } else {
        // 'add'
        if (!matchedA.has(aCursor)) {
          out.push({ type: 'add', text: op.text });
        }
        aCursor++;
      }
    }
  }
  return out;
}

function jaccardSimilarity(a, b) {
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
  // Normalize quote style before extracting words so contractions
  // round-trip ("isn't" / "isn't" both become "isn't").
  const m = normCmp(s).toLowerCase().match(/[a-z0-9']+/g) || [];
  for (const w of m) set.add(w);
  return set;
}

// =====================================================================
// Word-level LCS inside a single modified paragraph
// Uses the same quote-normalization for comparison.
// =====================================================================

function wordLevelDiff(oldText, newText) {
  if (oldText === newText) {
    return oldText ? [{ type: 'eq', text: oldText }] : [];
  }
  if (normCmp(oldText) === normCmp(newText)) {
    return oldText ? [{ type: 'eq', text: oldText }] : [];
  }
  const oldTokens = tokenize(oldText || '');
  const newTokens = tokenize(newText || '');
  const oldNorm = oldTokens.map(normCmp);
  const newNorm = newTokens.map(normCmp);

  let pre = 0;
  const minLen = Math.min(oldTokens.length, newTokens.length);
  while (pre < minLen && oldNorm[pre] === newNorm[pre]) pre++;

  let suf = 0;
  while (
    suf < oldTokens.length - pre &&
    suf < newTokens.length - pre &&
    oldNorm[oldTokens.length - 1 - suf] ===
      newNorm[newTokens.length - 1 - suf]
  ) {
    suf++;
  }

  const oldMiddle = oldTokens.slice(pre, oldTokens.length - suf);
  const newMiddle = newTokens.slice(pre, newTokens.length - suf);
  const oldMiddleN = oldNorm.slice(pre, oldTokens.length - suf);
  const newMiddleN = newNorm.slice(pre, newTokens.length - suf);

  let middleSegments;
  if (oldMiddle.length * newMiddle.length > LCS_CELL_CAP) {
    middleSegments = [];
    if (oldMiddle.length) {
      middleSegments.push({ type: 'del', text: oldMiddle.join('') });
    }
    if (newMiddle.length) {
      middleSegments.push({ type: 'add', text: newMiddle.join('') });
    }
  } else {
    middleSegments = wordLcs(oldMiddle, newMiddle, oldMiddleN, newMiddleN);
  }

  const out = [];
  if (pre > 0) {
    out.push({ type: 'eq', text: oldTokens.slice(0, pre).join('') });
  }
  out.push(...middleSegments);
  if (suf > 0) {
    out.push({
      type: 'eq',
      text: oldTokens.slice(oldTokens.length - suf).join(''),
    });
  }
  return coalesce(out);
}

function wordLcs(a, b, aN, bN) {
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) return [];
  if (m === 0) return [{ type: 'add', text: b.join('') }];
  if (n === 0) return [{ type: 'del', text: a.join('') }];

  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    const ai = aN[i - 1];
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= n; j++) {
      row[j] =
        ai === bN[j - 1]
          ? prev[j - 1] + 1
          : prev[j] >= row[j - 1]
          ? prev[j]
          : row[j - 1];
    }
  }

  const segs = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aN[i - 1] === bN[j - 1]) {
      segs.push({ type: 'eq', text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      segs.push({ type: 'add', text: b[j - 1] });
      j--;
    } else {
      segs.push({ type: 'del', text: a[i - 1] });
      i--;
    }
  }
  segs.reverse();
  return segs;
}

// Merge consecutive segments of the same type into one.
function coalesce(segs) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.type === s.type) {
      last.text += s.text;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

// Quick word-count delta summary for the diff modal header.
export function diffStats(oldText, newText) {
  const oldWords = wordCount(oldText);
  const newWords = wordCount(newText);
  return {
    oldWords,
    newWords,
    delta: newWords - oldWords,
  };
}

function wordCount(s) {
  if (!s) return 0;
  const trimmed = s.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
