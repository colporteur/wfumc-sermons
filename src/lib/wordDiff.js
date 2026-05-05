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
//   2. For paragraphs that changed: walk the paragraph ops looking
//      for adjacent del+add pairs whose word overlap (Jaccard) is
//      high enough that they're clearly modifications of the same
//      paragraph. Word-level LCS them in place; render the rest as
//      pure paragraph adds / deletes.
//
// This avoids the classic LCS pathology where a small match in the
// wrong place drags surrounding text into del/add territory.

const LCS_CELL_CAP = 4_000_000; // Word-LCS cap inside a single paragraph
const SIMILARITY_THRESHOLD = 0.3; // Jaccard cutoff for "this is a mod"

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

  const oldParas = splitParagraphs(oldText || '');
  const newParas = splitParagraphs(newText || '');

  if (oldParas.length === 0 && newParas.length === 0) return [];
  if (oldParas.length === 0) {
    return [{ type: 'add', text: newParas.join('') }];
  }
  if (newParas.length === 0) {
    return [{ type: 'del', text: oldParas.join('') }];
  }

  // Stage 1: paragraph-level LCS. Common paragraphs become anchors
  // that pin the diff so it can't wander.
  const paraOps = paragraphLcs(oldParas, newParas);

  // Stage 2: pair adjacent del+add paragraphs into modifications when
  // they're similar enough that they're clearly an edit of the same
  // paragraph. Then word-diff only inside those.
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
      // 'add'
      segments.push({ type: 'add', text: op.text });
    }
  }
  return coalesce(segments);
}

// =====================================================================
// Paragraph-level LCS
// =====================================================================

function paragraphLcs(a, b) {
  const m = a.length;
  const n = b.length;
  // Trim common prefix / suffix paragraphs first — same trick as inside
  // a paragraph, even more effective at this granularity.
  let pre = 0;
  while (pre < m && pre < n && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < m - pre &&
    suf < n - pre &&
    a[m - 1 - suf] === b[n - 1 - suf]
  ) {
    suf++;
  }
  const aMid = a.slice(pre, m - suf);
  const bMid = b.slice(pre, n - suf);

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ type: 'eq', text: a[i] });
  ops.push(...lcsParagraphMiddle(aMid, bMid));
  for (let i = m - suf; i < m; i++) ops.push({ type: 'eq', text: a[i] });
  return ops;
}

function lcsParagraphMiddle(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) return [];
  if (m === 0) return b.map((p) => ({ type: 'add', text: p }));
  if (n === 0) return a.map((p) => ({ type: 'del', text: p }));

  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    const ai = a[i - 1];
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= n; j++) {
      row[j] =
        ai === b[j - 1]
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
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
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
// Pair-up: turn adjacent (del, add) into (mod) when similar enough.
// Greedy left-to-right scan — handles the common case of Claude
// rewriting one paragraph at a time without the complexity of full
// bipartite matching.
// =====================================================================

function pairUpModifications(ops) {
  const out = [];
  let i = 0;
  while (i < ops.length) {
    const cur = ops[i];
    const next = ops[i + 1];
    if (
      next &&
      ((cur.type === 'del' && next.type === 'add') ||
        (cur.type === 'add' && next.type === 'del'))
    ) {
      const oldText = cur.type === 'del' ? cur.text : next.text;
      const newText = cur.type === 'add' ? cur.text : next.text;
      const sim = jaccardSimilarity(oldText, newText);
      if (sim >= SIMILARITY_THRESHOLD) {
        out.push({ type: 'mod', oldText, newText });
        i += 2;
        continue;
      }
    }
    out.push(cur);
    i += 1;
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
  const m = s.toLowerCase().match(/[a-z0-9'’]+/g) || [];
  for (const w of m) set.add(w);
  return set;
}

// =====================================================================
// Word-level LCS inside a single modified paragraph
// =====================================================================

function wordLevelDiff(oldText, newText) {
  if (oldText === newText) {
    return oldText ? [{ type: 'eq', text: oldText }] : [];
  }
  const oldTokens = tokenize(oldText || '');
  const newTokens = tokenize(newText || '');

  let pre = 0;
  const minLen = Math.min(oldTokens.length, newTokens.length);
  while (pre < minLen && oldTokens[pre] === newTokens[pre]) pre++;

  let suf = 0;
  while (
    suf < oldTokens.length - pre &&
    suf < newTokens.length - pre &&
    oldTokens[oldTokens.length - 1 - suf] ===
      newTokens[newTokens.length - 1 - suf]
  ) {
    suf++;
  }

  const oldMiddle = oldTokens.slice(pre, oldTokens.length - suf);
  const newMiddle = newTokens.slice(pre, newTokens.length - suf);

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
    middleSegments = wordLcs(oldMiddle, newMiddle);
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

function wordLcs(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) return [];
  if (m === 0) return [{ type: 'add', text: b.join('') }];
  if (n === 0) return [{ type: 'del', text: a.join('') }];

  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Uint32Array(n + 1);
  for (let i = 1; i <= m; i++) {
    const ai = a[i - 1];
    const row = dp[i];
    const prev = dp[i - 1];
    for (let j = 1; j <= n; j++) {
      row[j] =
        ai === b[j - 1]
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
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
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

// Merge consecutive segments of the same type into one — keeps the
// rendered DOM small and the visual change blocks readable.
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
