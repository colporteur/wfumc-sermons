// Word-level diff for the Sermon Workspace.
//
// Returns a sequence of { type: 'eq' | 'add' | 'del', text: string }
// segments. Render directly: 'eq' → plain text, 'add' → green
// background, 'del' → red strikethrough.
//
// Strategy:
//   1. Tokenize both versions into words / punctuation / whitespace
//      runs. Tokenizing punctuation separately means "hope" → "hope,"
//      shows just an inserted comma, not a whole-word swap.
//   2. Trim the longest common prefix and suffix. Most Claude turns
//      change one paragraph in a multi-thousand-word manuscript, so
//      this collapses 95% of the work.
//   3. Run LCS on the differing middle to compute the actual edit
//      script. Capped at 4M cells (~16MB) to bound memory; bigger
//      diffs fall back to a coarse "everything changed" rendering.

const LCS_CELL_CAP = 4_000_000;

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

// Main entry: returns the segment list.
export function diffWords(oldText, newText) {
  if (oldText === newText) {
    return oldText ? [{ type: 'eq', text: oldText }] : [];
  }
  const oldTokens = tokenize(oldText || '');
  const newTokens = tokenize(newText || '');

  // Trim common prefix.
  let pre = 0;
  const minLen = Math.min(oldTokens.length, newTokens.length);
  while (pre < minLen && oldTokens[pre] === newTokens[pre]) pre++;

  // Trim common suffix.
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
    // Too big for LCS — coarse fallback. We can't meaningfully merge
    // the two; just show the whole old chunk as deleted then the new
    // chunk as added. The pastor will still see the prefix/suffix in
    // their original place.
    middleSegments = [];
    if (oldMiddle.length) {
      middleSegments.push({ type: 'del', text: oldMiddle.join('') });
    }
    if (newMiddle.length) {
      middleSegments.push({ type: 'add', text: newMiddle.join('') });
    }
  } else {
    middleSegments = lcsDiff(oldMiddle, newMiddle);
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

// Standard LCS-based diff. O(m*n) time and space; safe inside the cap.
function lcsDiff(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0 && n === 0) return [];
  if (m === 0) return [{ type: 'add', text: b.join('') }];
  if (n === 0) return [{ type: 'del', text: a.join('') }];

  // Build LCS length table. Uint32 is plenty for any manuscript-sized diff.
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

  // Walk back, push then reverse (avoids O(n) unshift per step).
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
