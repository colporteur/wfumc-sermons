// Claude integration for the Sermon Archive app.
//
// Routes through the same `claude-proxy` Edge Function the bulletin app
// uses. The proxy is auth-gated (any authenticated user) — it pulls the
// Anthropic key from public.church_settings server-side so the key
// never leaves the server.

import { supabase, withTimeout } from './supabase';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;

/**
 * Low-level proxy call. Mirrors the bulletin app's callClaude.
 * @param {Object} body { messages, system?, max_tokens?, model? }
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=60000] Claude inference can be slow;
 *   default 60s. Bigger jobs (manuscript extraction) should pass more.
 */
export async function callClaude(body, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('Not signed in');
  }
  let res;
  try {
    res = await withTimeout(
      fetch(`${supabaseUrl}/functions/v1/claude-proxy`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(body),
      }),
      timeoutMs
    );
  } catch (e) {
    // Replace withTimeout's generic "clear localStorage" message with one
    // that's accurate for Claude calls — they're slow LLM jobs, not
    // network/auth issues.
    if (String(e?.message || '').includes('Request timed out')) {
      throw new Error(
        `Claude took longer than ${Math.round(timeoutMs / 1000)}s to respond. ` +
          `For long manuscripts this can happen — try again, or break it into smaller pieces.`
      );
    }
    throw e;
  }
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Claude proxy error ${res.status}: ${errBody}`);
  }
  return res.json();
}

/**
 * Pulls the first text block out of a Claude /messages response.
 */
function extractText(response) {
  const block = response?.content?.find((c) => c.type === 'text');
  return block?.text ?? '';
}

/**
 * Best-effort JSON extraction. Claude sometimes wraps JSON in prose or
 * code fences; pull out the first {...} block.
 */
function parseJsonLoose(text) {
  if (!text) return null;
  // Strip ```json ... ``` fences if present.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  // Find the first { and the last } — should be the JSON object.
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Same idea, but for top-level JSON arrays.
 */
function parseJsonArrayLoose(text) {
  if (!text) return null;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Analyze a sermon-prep resource (story / quote / illustration / joke /
 * note) and suggest themes, scripture connections, and tone.
 *
 * @param {Object} input
 * @param {string} input.content - the resource body
 * @param {string} [input.type]  - story | quote | illustration | joke | note
 * @param {string} [input.title] - optional title (gives Claude more context)
 * @param {string} [input.source] - optional attribution
 * @returns {Promise<{ themes: string[], scripture_refs: string, tone: string }>}
 */
export async function analyzeResource({ content, type, title, source }) {
  if (!content || !content.trim()) {
    throw new Error('Nothing to analyze — add some content first.');
  }

  const system = [
    'You help a United Methodist pastor catalog sermon-prep resources',
    '(stories, quotes, illustrations, jokes, notes) by suggesting metadata.',
    '',
    'Return ONLY a JSON object with three keys:',
    '  themes:         array of 3-6 short theme tags (e.g., "grace", "forgiveness", "stewardship", "holy week")',
    '  scripture_refs: a string of relevant Bible references, semicolon-separated (e.g., "Luke 15:11-32; Romans 8:1")',
    '  tone:           a single short descriptor (e.g., "humorous", "convicting", "tender", "hopeful", "somber")',
    '',
    'Themes should be lowercase, concise, and reusable as filter tags.',
    'Only include scripture refs that genuinely connect — empty string is fine.',
    'When suggesting scripture refs, prefer passages from the Revised Common',
    'Lectionary (3-year cycle, Years A/B/C) when they fit the content. The',
    'pastor preaches lectionary-based sermons, so RCL connections are most',
    'useful. Non-RCL passages are still fine when they\'re a clearer match.',
    'No explanation, no prose — just the JSON object.',
  ].join('\n');

  const parts = [];
  if (type) parts.push(`Type: ${type}`);
  if (title) parts.push(`Title: ${title}`);
  if (source) parts.push(`Source: ${source}`);
  parts.push('Content:');
  parts.push(content.trim());
  const userMessage = parts.join('\n');

  const response = await callClaude({
    system,
    messages: [{ role: 'user', content: userMessage }],
    max_tokens: 600,
  });
  const text = extractText(response);
  const parsed = parseJsonLoose(text);
  if (!parsed) {
    throw new Error("Couldn't parse Claude's response as JSON.");
  }
  // Sanitize: themes → array of trimmed lowercase strings; refs/tone → strings.
  const themes = Array.isArray(parsed.themes)
    ? parsed.themes
        .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
        .filter(Boolean)
    : [];
  return {
    themes,
    scripture_refs:
      typeof parsed.scripture_refs === 'string' ? parsed.scripture_refs.trim() : '',
    tone: typeof parsed.tone === 'string' ? parsed.tone.trim() : '',
  };
}

/**
 * Extract reusable resources (stories / quotes / illustrations / jokes)
 * from a sermon manuscript. Returns Claude's proposed list — the UI is
 * responsible for letting the pastor edit/accept/reject before saving.
 *
 * @param {Object} input
 * @param {string} input.manuscriptText      - the full manuscript
 * @param {Object} [input.sermonContext]     - optional: title, scripture, theme
 * @returns {Promise<Array<{
 *   proposed_title: string,
 *   content: string,
 *   type: 'story' | 'quote' | 'illustration' | 'joke',
 *   themes: string[],
 *   scripture_refs: string,
 *   tone: string
 * }>>}
 */
export async function extractResourcesFromManuscript({
  manuscriptText,
  sermonContext = {},
}) {
  if (!manuscriptText || !manuscriptText.trim()) {
    throw new Error('No manuscript text to extract from.');
  }

  const system = [
    'You help a United Methodist pastor mine their own sermon manuscripts',
    'for reusable building blocks. Identify discrete stories, quotes,',
    'illustrations, and jokes that could stand alone as a resource the',
    'pastor (or a co-pastor) might use again in a future sermon.',
    '',
    'Be CONSERVATIVE — only extract concrete artifacts that work standalone.',
    '',
    'DO extract:',
    '  - Personal anecdotes or stories (the pastor\'s own or someone else\'s)',
    '  - Attributed quotes from books, people, songs, films',
    '  - Illustrations: metaphors, analogies, parable-style teaching images',
    '  - Jokes',
    '  - Concrete examples drawn from history, news, science, literature',
    '',
    'DO NOT extract (these are the sermon\'s argument, not reusable resources):',
    '  - Theological reflection or doctrinal exposition',
    '  - Discussion, exegesis, or interpretation of a Bible passage',
    '  - Application of scripture to the congregation\'s situation',
    '  - Transitions, throat-clearing, framing language',
    '  - General observations about Christian life that aren\'t tied to a',
    '    concrete story, quote, or image',
    '',
    'Rule of thumb: if the passage primarily REFLECTS or TEACHES, skip it.',
    'If it primarily TELLS, QUOTES, or PAINTS A PICTURE, extract it.',
    '',
    'For each extracted item, return an object with these keys:',
    '  proposed_title: a short title for the resource (5-10 words)',
    '  content:        the actual excerpt, copied verbatim from the manuscript',
    '                  with light cleanup (fix obvious typos, drop verbal',
    '                  filler). Multiple paragraphs are fine. Don\'t paraphrase.',
    '  type:           one of "story", "quote", "illustration", "joke"',
    '  themes:         array of 3-5 short lowercase theme tags',
    '  scripture_refs: relevant Bible refs, semicolon-separated, or ""',
    '  tone:           one short descriptor (humorous, tender, convicting, etc.)',
    '',
    'When suggesting scripture refs, prefer Revised Common Lectionary',
    'passages (Years A/B/C) when they fit. The pastor preaches RCL.',
    '',
    'Return ONLY a JSON array of these objects. No prose, no commentary.',
    'If nothing in the manuscript is worth extracting, return [].',
  ].join('\n');

  const ctxLines = [];
  if (sermonContext.title) ctxLines.push(`Sermon title: ${sermonContext.title}`);
  if (sermonContext.scripture_reference)
    ctxLines.push(`Scripture: ${sermonContext.scripture_reference}`);
  if (sermonContext.theme) ctxLines.push(`Theme: ${sermonContext.theme}`);
  const ctxBlock = ctxLines.length > 0 ? ctxLines.join('\n') + '\n\n' : '';

  const userMessage =
    `${ctxBlock}Manuscript:\n\n${manuscriptText.trim()}`;

  // Manuscripts can be long. 4096 max tokens for the response gives us
  // room for a fair number of extractions. Allow up to 3 minutes — full
  // sermons + extraction reasoning routinely take 60-90s.
  const response = await callClaude(
    {
      system,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 4096,
    },
    { timeoutMs: 180000 }
  );
  const text = extractText(response);
  const parsed = parseJsonArrayLoose(text);
  if (!Array.isArray(parsed)) {
    throw new Error("Couldn't parse Claude's response as a JSON array.");
  }

  const VALID_TYPES = new Set(['story', 'quote', 'illustration', 'joke']);
  return parsed
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      proposed_title:
        typeof r.proposed_title === 'string' ? r.proposed_title.trim() : '',
      content: typeof r.content === 'string' ? r.content.trim() : '',
      type:
        typeof r.type === 'string' && VALID_TYPES.has(r.type.trim().toLowerCase())
          ? r.type.trim().toLowerCase()
          : 'story',
      themes: Array.isArray(r.themes)
        ? r.themes
            .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
            .filter(Boolean)
        : [],
      scripture_refs:
        typeof r.scripture_refs === 'string' ? r.scripture_refs.trim() : '',
      tone: typeof r.tone === 'string' ? r.tone.trim() : '',
    }))
    .filter((r) => r.content.length > 0);
}

// Treat these (case-insensitive) as "no real title, please regenerate".
const GENERIC_TITLE_RE =
  /^\s*(\(?untitled\)?( note)?|note|new note|untitled \d*)\s*$/i;

export function isGenericTitle(s) {
  if (!s || typeof s !== 'string') return true;
  if (s.trim().length === 0) return true;
  return GENERIC_TITLE_RE.test(s);
}

/**
 * Classify a batch of imported notes into resource types AND propose a
 * short title for any input whose title was missing or generic
 * (e.g., "Untitled Note").
 *
 * @param {Array<{ id: string, title?: string, snippet: string }>} items
 * @returns {Promise<Record<string, { type: string, title?: string }>>}
 *   Map of input id → { type, title? }. `title` is only present when the
 *   input title was generic AND Claude proposed something. Items Claude
 *   can't classify default to type 'note', no title.
 */
export async function classifyResources(items) {
  if (!items?.length) return {};
  const VALID = new Set([
    'story', 'quote', 'illustration', 'joke', 'note', 'photo',
  ]);
  const out = {};

  // Batch in groups of 20 to keep prompts small and responses parseable.
  const BATCH = 20;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    // Tell Claude WHICH inputs need a fresh title, so it doesn't waste
    // tokens regenerating titles that are already fine.
    const needTitle = new Set(
      batch.filter((it) => isGenericTitle(it.title)).map((it) => it.id)
    );
    const system = [
      'You categorize sermon-prep notes (for a United Methodist pastor who',
      'preaches the Revised Common Lectionary) into one of:',
      '  story         — a narrative anecdote (personal or 3rd-person)',
      '  quote         — a short attributed saying or excerpt',
      '  illustration  — a metaphor or analogy used to teach',
      '  joke          — humor, intentionally light',
      '  note          — generic notes, ideas, observations',
      '  photo         — describes a visual reference',
      '',
      'For each item, return:',
      '  { "id": "<the id>", "type": "<one of the above>", "title": "<only if needs_title>" }',
      'When `needs_title` is true on an input, propose a concrete 4-8 word title',
      'based on the snippet. Otherwise omit the "title" field.',
      '',
      'Return ONLY a JSON array. Use the exact ids you receive.',
      'No explanation, no prose.',
    ].join('\n');
    const lines = batch.map((it) => {
      const parts = [
        `id=${it.id}`,
        `needs_title=${needTitle.has(it.id)}`,
        `title: ${it.title || '(untitled)'}`,
        `snippet: ${(it.snippet || '')
          .slice(0, 250)
          .replace(/\s+/g, ' ')}`,
      ];
      return parts.join('\n');
    });
    const user = `Classify these ${batch.length} items:\n\n${lines.join('\n---\n')}`;

    let parsed = null;
    try {
      const response = await callClaude(
        {
          system,
          messages: [{ role: 'user', content: user }],
          max_tokens: 2000,
        },
        { timeoutMs: 90000 }
      );
      const text = extractText(response);
      parsed = parseJsonArrayLoose(text);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('classify batch failed, defaulting to note:', e);
    }
    if (Array.isArray(parsed)) {
      for (const row of parsed) {
        if (row && typeof row.id === 'string' && typeof row.type === 'string') {
          const t = row.type.trim().toLowerCase();
          if (VALID.has(t)) {
            const entry = { type: t };
            if (
              needTitle.has(row.id) &&
              typeof row.title === 'string' &&
              row.title.trim().length > 0 &&
              !isGenericTitle(row.title)
            ) {
              entry.title = row.title.trim();
            }
            out[row.id] = entry;
          }
        }
      }
    }
    // Anything Claude missed → default to 'note', no title proposal.
    for (const it of batch) {
      if (!out[it.id]) out[it.id] = { type: 'note' };
    }
  }
  return out;
}
