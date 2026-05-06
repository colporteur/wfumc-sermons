// Claude integration for the Sermon Archive app.
//
// Routes through the same `claude-proxy` Edge Function the bulletin app
// uses. The proxy is auth-gated (any authenticated user) — it pulls the
// Anthropic key from public.church_settings server-side so the key
// never leaves the server.

import { supabase, withTimeout } from './supabase';
import { prepareImageForUpload, blobToBase64 } from './imageHelpers';
import { publicResourceImageUrl } from './resourceImages';

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
    // Try to translate common Anthropic error patterns into something
    // a user can actually act on, instead of dumping raw JSON. Falls
    // through to the raw body if we can't recognize the pattern.
    let parsed;
    try {
      parsed = JSON.parse(errBody);
    } catch {
      parsed = null;
    }
    const apiMessage =
      parsed?.error?.message ||
      parsed?.message ||
      (typeof parsed === 'string' ? parsed : '');
    const apiType = parsed?.error?.type || '';

    // Anthropic-side content filter (output blocked AFTER generation).
    // The model wrote a response, but their safety filter refused to
    // return it. Usually triggered by verbatim excerpts of sensitive,
    // fringe, or copyrighted material.
    if (
      /Output blocked by content filtering policy/i.test(apiMessage) ||
      /content[_ ]filter/i.test(apiMessage)
    ) {
      throw new Error(
        "Claude generated a response but Anthropic's safety filter " +
          "refused to return it. This usually happens with verbatim " +
          'excerpts of fringe / mystical / copyrighted material. Try a ' +
          'different chunk of the source, a shorter selection, or split ' +
          'the source into smaller pieces.'
      );
    }
    if (apiType === 'overloaded_error' || res.status === 529) {
      throw new Error(
        "Anthropic's API is temporarily overloaded. Wait a minute and try again."
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'Claude proxy refused the request. Make sure you are signed in and the Anthropic API key is set in church_settings.'
      );
    }
    if (apiMessage) {
      throw new Error(`Claude error (${res.status}): ${apiMessage}`);
    }
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
 * Hardened JSON-array parser for long Claude responses where the strict
 * loose parser fails. Tries (in order):
 *
 *   1. The strict loose parser.
 *   2. Same input with trailing commas stripped (Claude sometimes emits
 *      "[{...}, {...},]" which JSON.parse rejects).
 *   3. Walk the input character by character tracking brace depth and
 *      string state, and collect every complete top-level object inside
 *      the array. This recovers when the response was truncated mid-
 *      object — we keep the N-1 complete objects and silently drop the
 *      truncated tail.
 *
 * Returns an array (possibly empty) on success, or null if no useful
 * structure could be extracted.
 */
function parseJsonArrayRobust(text) {
  if (!text) return null;

  // Stage 1: strict loose parser
  const strict = parseJsonArrayLoose(text);
  if (Array.isArray(strict)) return strict;

  // Strip code-fence wrapper if present, same as parseJsonArrayLoose.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1] : text;
  const start = candidate.indexOf('[');
  if (start === -1) return null;
  const inside = candidate.slice(start);

  // Stage 2: strip trailing commas
  const noTrailingCommas = inside.replace(/,(\s*[\]\}])/g, '$1');
  const cEnd = noTrailingCommas.lastIndexOf(']');
  if (cEnd !== -1) {
    try {
      const parsed = JSON.parse(noTrailingCommas.slice(0, cEnd + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* fall through to recovery */
    }
  }

  // Stage 3: walk + recover complete objects.
  const objects = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let objStart = -1;
  // Skip the opening [ at index 0
  for (let i = 1; i < inside.length; i++) {
    const ch = inside[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart !== -1) {
        const objText = inside.slice(objStart, i + 1);
        try {
          objects.push(JSON.parse(objText));
        } catch {
          // Try once more after stripping trailing commas inside.
          try {
            const fixed = objText.replace(/,(\s*[\]\}])/g, '$1');
            objects.push(JSON.parse(fixed));
          } catch {
            /* skip malformed */
          }
        }
        objStart = -1;
      }
    } else if (ch === ']' && depth === 0) {
      // Reached the close of the outer array.
      break;
    }
  }
  return objects.length > 0 ? objects : null;
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
 * Analyze a resource that has one or more images. Uses Claude vision —
 * fetches each image, downsizes + re-encodes as JPEG, sends as base64
 * alongside any existing text context. Returns suggestions for every
 * field (title, content/narrative, themes, scripture, tone) so the UI
 * can decide whether to overwrite existing values or only fill blanks.
 *
 * @param {Object} input
 * @param {Array<{ image_path: string, caption?: string }>} input.images
 * @param {Object} [input.existing]  Current resource fields, used for context
 *   (Claude can still suggest replacements; the UI decides what to apply).
 * @returns {Promise<{
 *   title: string,
 *   content: string,
 *   themes: string[],
 *   scripture_refs: string,
 *   tone: string,
 * }>}
 */
export async function analyzeResourceWithImages({ images, existing = {} }) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error('No images attached to analyze.');
  }
  // Cap to 4 images to keep token use sane (Claude vision per-image cost).
  const subset = images.slice(0, 4);

  // Fetch + downsize + base64-encode each image in parallel.
  const prepared = await Promise.all(
    subset.map(async (img) => {
      const url = publicResourceImageUrl(img.image_path);
      // Fetch as blob so we can pipe through prepareImageForUpload (which
      // re-encodes to JPEG — Anthropic's vision endpoint requires
      // JPEG/PNG/GIF/WEBP and a clean encoding).
      const res = await withTimeout(fetch(url), 30000);
      if (!res.ok) {
        throw new Error(`Couldn't fetch image (${res.status})`);
      }
      const blob = await res.blob();
      const { blob: jpeg, mediaType } = await prepareImageForUpload(
        blob,
        1600,
        0.85
      );
      const data = await blobToBase64(jpeg);
      return { mediaType, data, caption: img.caption };
    })
  );

  const system = [
    'You help a United Methodist pastor (who preaches the Revised Common',
    "Lectionary) catalog visual resources in their sermon-prep library.",
    '',
    "Look at the attached image(s) and propose a complete set of",
    'metadata for the resource. Return ONLY a JSON object with these keys:',
    '  title:          a concrete 4-8 word title',
    '  content:        a short narrative description (2-4 sentences) of',
    '                  what the image shows AND how it could be used in',
    '                  preaching (its preachable angle). NOT just a',
    '                  description — include the homiletical hook.',
    '  themes:         array of 3-6 short lowercase theme tags',
    '  scripture_refs: relevant Bible references, semicolon-separated.',
    '                  Prefer Revised Common Lectionary passages where they',
    '                  fit. Empty string is fine if nothing connects.',
    '  tone:           one short descriptor (tender, hopeful, convicting,',
    '                  somber, humorous, etc.)',
    '',
    "If the user has already filled in some fields (shown below as context),",
    "still propose your best suggestions for ALL fields. The UI will let",
    "the user choose whether to overwrite or only fill blanks.",
    'No explanation, no prose — just the JSON object.',
  ].join('\n');

  // Build a text block summarizing whatever the user has so far.
  const ctxLines = [];
  if (existing.title) ctxLines.push(`Current title: ${existing.title}`);
  if (existing.content)
    ctxLines.push(`Current content:\n${existing.content}`);
  if (existing.source) ctxLines.push(`Source: ${existing.source}`);
  if (existing.themes?.length)
    ctxLines.push(`Current themes: ${existing.themes.join(', ')}`);
  if (existing.scripture_refs)
    ctxLines.push(`Current scripture: ${existing.scripture_refs}`);
  if (existing.tone) ctxLines.push(`Current tone: ${existing.tone}`);
  if (existing.resource_type)
    ctxLines.push(`Resource type: ${existing.resource_type}`);
  const ctxBlock =
    ctxLines.length > 0
      ? `Context (what the user has filled in so far):\n${ctxLines.join(
          '\n'
        )}\n\n`
      : '';

  // Compose the multimodal user message: text intro + each image + a
  // closing instruction.
  const contentBlocks = [
    {
      type: 'text',
      text:
        ctxBlock +
        `Here ${subset.length === 1 ? 'is the image' : `are ${subset.length} images`} attached to this resource:`,
    },
  ];
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i];
    if (p.caption) {
      contentBlocks.push({
        type: 'text',
        text: `Image ${i + 1} caption: ${p.caption}`,
      });
    }
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: p.mediaType,
        data: p.data,
      },
    });
  }
  contentBlocks.push({
    type: 'text',
    text:
      'Now return the JSON object with title, content, themes, ' +
      'scripture_refs, and tone.',
  });

  const response = await callClaude(
    {
      system,
      messages: [{ role: 'user', content: contentBlocks }],
      max_tokens: 1500,
    },
    { timeoutMs: 120000 }
  );
  const text = extractText(response);
  const parsed = parseJsonLoose(text);
  if (!parsed) {
    throw new Error("Couldn't parse Claude's response as JSON.");
  }
  const themes = Array.isArray(parsed.themes)
    ? parsed.themes
        .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : ''))
        .filter(Boolean)
    : [];
  return {
    title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
    content: typeof parsed.content === 'string' ? parsed.content.trim() : '',
    themes,
    scripture_refs:
      typeof parsed.scripture_refs === 'string'
        ? parsed.scripture_refs.trim()
        : '',
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

/**
 * Mine a non-manuscript SOURCE (article, book chapter, blog post, etc.)
 * for sermon-illustration resources. Same shape as
 * extractResourcesFromManuscript but with a prompt adapted to material
 * the pastor *read*, not material the pastor wrote.
 */
export async function extractResourcesFromSource({
  sourceText,
  sourceLabel = '',
}) {
  if (!sourceText || !sourceText.trim()) {
    throw new Error('No source text to extract from.');
  }

  const system = [
    'You help a United Methodist pastor mine reading material — articles,',
    'book chapters, blog posts, talks they listened to — for reusable',
    'sermon-illustration resources. Identify discrete stories, quotes,',
    'illustrations, and jokes that could stand alone and might land in',
    'a future sermon.',
    '',
    'Be CONSERVATIVE — only extract concrete artifacts that work standalone.',
    '',
    'DO extract:',
    '  - Personal anecdotes or stories (the author\'s own or someone else\'s)',
    '  - Memorable, attributable quotes',
    '  - Illustrations: metaphors, analogies, parable-style teaching images',
    '  - Jokes',
    '  - Concrete examples drawn from history, news, science, literature',
    '',
    'DO NOT extract:',
    '  - The author\'s argument, theological reflection, or doctrinal exposition',
    '  - Exegesis or interpretation of a Bible passage',
    '  - Transitions, framing language, throat-clearing',
    '  - General observations that aren\'t tied to a concrete story, quote, or image',
    '',
    'Rule of thumb: if the passage primarily REFLECTS or TEACHES, skip it.',
    'If it primarily TELLS, QUOTES, or PAINTS A PICTURE, extract it.',
    '',
    'For each extracted item, return an object with these keys:',
    '  proposed_title: a short title for the resource (5-10 words)',
    '  content:        the actual excerpt, copied verbatim from the source',
    '                  with light cleanup (fix obvious OCR/typo issues, drop',
    '                  filler). Multiple paragraphs are fine. Don\'t paraphrase.',
    '  type:           one of "story", "quote", "illustration", "joke"',
    '  themes:         array of 3-5 short lowercase theme tags',
    '  scripture_refs: relevant Bible refs the resource might illustrate,',
    '                  semicolon-separated, or "" if none come to mind',
    '  tone:           one short descriptor (humorous, tender, convicting, etc.)',
    '',
    'When suggesting scripture refs, prefer Revised Common Lectionary',
    'passages (Years A/B/C) when they fit. The pastor preaches RCL.',
    '',
    'Return ONLY a JSON array of these objects. No prose, no commentary.',
    'If nothing in the source is worth extracting, return [].',
  ].join('\n');

  const ctx = sourceLabel ? `Source: ${sourceLabel}\n\n` : '';
  // Cap input so we don't burn tokens on giant PDFs. 60k chars ~= 15k
  // tokens of input — generous for a chapter or article.
  const trimmed =
    sourceText.length > 60000
      ? sourceText.slice(0, 60000) + '\n…[truncated]'
      : sourceText;
  const userMessage = `${ctx}Source text:\n\n${trimmed.trim()}`;

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

/**
 * Auto-complete sermon metadata fields from the manuscript.
 *
 * Sends the manuscript + the current draft state to Claude and asks
 * for proposed values for the empty/blank fields. Already-populated
 * fields are preserved (Claude is told not to change them; the caller
 * also filters again as a safety net).
 *
 * Returns an object whose keys are the field names and values are
 * Claude's proposals for the BLANK fields only. Suitable for the
 * caller to merge directly into the form's draft state.
 *
 * Fields proposed (when blank in `current`):
 *   title              — short, evocative sermon title
 *   scripture_reference — primary text the sermon is on
 *   theme              — one phrase (e.g., "grace", "stewardship", "Easter")
 *   timeless           — "Yes" / "No" / "Yes, with modification"
 *   is_eulogy          — boolean
 *   major_stories      — comma-separated list of stories used
 *
 * Fields NOT proposed:
 *   lectionary_year — domain-specific code Claude wouldn't reliably know
 *   strength        — subjective; pastor's call
 *   preached_at     — date Claude can't infer
 *   notes           — pastor's private observations
 */
export async function autocompleteSermonMetadata({ manuscriptText, current = {} }) {
  if (!manuscriptText || !manuscriptText.trim()) {
    throw new Error('No manuscript to analyze.');
  }
  // Cap the manuscript length to keep token costs predictable. Sermon
  // manuscripts above 30k chars are unusual; if it happens, the
  // first 30k usually contains enough to identify text + theme.
  const trimmed =
    manuscriptText.length > 30000
      ? manuscriptText.slice(0, 30000) + '\n…[truncated]'
      : manuscriptText;

  // What's already filled — Claude should leave these alone.
  const blank = (v) =>
    v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  const fieldsToFill = [];
  if (blank(current.title)) fieldsToFill.push('title');
  if (blank(current.scripture_reference)) fieldsToFill.push('scripture_reference');
  if (blank(current.theme)) fieldsToFill.push('theme');
  if (blank(current.timeless)) fieldsToFill.push('timeless');
  if (current.is_eulogy === undefined || current.is_eulogy === null) {
    fieldsToFill.push('is_eulogy');
  }
  if (blank(current.major_stories)) fieldsToFill.push('major_stories');

  if (fieldsToFill.length === 0) {
    return { proposals: {}, fieldsConsidered: [] };
  }

  const filledNote =
    Object.entries(current)
      .filter(([k]) => !fieldsToFill.includes(k))
      .filter(([, v]) => !blank(v))
      .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
      .join('\n') || '  (none)';

  const system = `You are helping a pastor fill in metadata about a sermon they wrote, using the sermon manuscript as context. You will be given the manuscript and the list of fields to propose values for. Return ONLY a JSON object — no markdown code fences, no commentary.

Field rules:
- "title": A short, evocative sermon title — 3-7 words. Look at the manuscript's opening, recurring phrase, or main image. If the manuscript has a heading that looks like a title, use that. Don't invent — if no title is clear, propose null.
- "scripture_reference": The primary biblical text the sermon is preaching on. Format like "John 3:1-21" or "1 Corinthians 13" or "Mark 12:28-34". If multiple texts are central, separate with semicolons. If no scripture is clearly central, propose null.
- "theme": One short phrase capturing the sermon's main theme — e.g., "grace", "Easter", "stewardship", "Trinity Sunday", "forgiveness". Lowercase unless a proper noun.
- "timeless": One of "Yes", "No", or "Yes, with modification". "Yes" if the sermon could be re-preached at any time of year. "No" if it's tied to a specific event/season (Christmas Eve, an election, a funeral). "Yes, with modification" for borderline cases.
- "is_eulogy": Boolean. True if this is a funeral/memorial sermon for a specific person.
- "major_stories": Comma-separated list of the major stories, illustrations, or jokes used in the sermon. Just short labels (3-7 words each), not full retellings. Empty string if none stand out.

Only return the fields you were asked to fill. Be honest — if you genuinely can't tell, return null. Don't invent.`;

  const userText = `Fields to propose values for:
${fieldsToFill.map((f) => `  - ${f}`).join('\n')}

Already-populated fields (do NOT change these):
${filledNote}

Manuscript:
${trimmed}

Return the JSON now.`;

  const response = await callClaude(
    {
      system,
      messages: [{ role: 'user', content: userText }],
      max_tokens: 1200,
    },
    { timeoutMs: 90000 }
  );
  const text = extractText(response);
  const parsed = parseJsonLoose(text);
  if (!parsed) {
    throw new Error("Couldn't parse Claude's response as JSON.");
  }

  // Filter to only the fields we asked for, drop nulls/empty proposals.
  const proposals = {};
  for (const f of fieldsToFill) {
    if (!(f in parsed)) continue;
    const v = parsed[f];
    if (v === null || v === undefined) continue;
    if (f === 'is_eulogy') {
      proposals[f] = Boolean(v);
    } else if (typeof v === 'string') {
      const t = v.trim();
      if (t) proposals[f] = t;
    } else {
      proposals[f] = v;
    }
  }
  return { proposals, fieldsConsidered: fieldsToFill };
}

/**
 * Parse a liturgy text body into discrete sections.
 *
 * Liturgies typically include several distinct units in one document:
 * call to worship, opening prayer, scripture, sermon, pastoral
 * prayer, communion, announcements, benediction. We ask Claude to
 * identify them so each can be displayed and reused independently.
 *
 * Announcements get explicitly flagged so the display layer can hide
 * them by default — old announcements aren't relevant to a future
 * sermon's planning workflow.
 *
 * Returns: array of { section_kind, title, body, is_announcement, sort_order }
 */
export async function parseLiturgyIntoSections({ liturgyTitle, liturgyBody }) {
  if (!liturgyBody || !liturgyBody.trim()) {
    throw new Error('Empty liturgy body.');
  }
  const trimmed =
    liturgyBody.length > 30000
      ? liturgyBody.slice(0, 30000) + '\n…[truncated]'
      : liturgyBody;

  const system = [
    'You are parsing a United Methodist worship liturgy into structured',
    'sections so each piece can be reused independently in future bulletins.',
    '',
    'Identify discrete sections. Common section kinds (use the value in',
    'parentheses for section_kind):',
    '  - Call to Worship (call_to_worship)',
    '  - Opening Prayer (opening_prayer)',
    '  - Pastoral Prayer (pastoral_prayer)',
    '  - Confession (confession)',
    '  - Words of Assurance / Pardon (assurance)',
    '  - Responsive Reading (responsive_reading)',
    '  - Affirmation of Faith / Creed (affirmation)',
    '  - Scripture Reading (scripture)',
    '  - Sermon — usually just a title placeholder, not the manuscript (sermon)',
    '  - Hymn (hymn)',
    '  - Offering Prayer / Doxology (offering_prayer)',
    '  - Communion liturgy (communion)',
    '  - Announcements / News (announcements)',
    '  - Benediction / Dismissal (benediction)',
    '  - Anything else you see (other)',
    '',
    'For each section return:',
    '  section_kind:    one of the values above',
    '  title:           the heading you found, or a short label if none',
    '  body:            the verbatim text of that section, lightly cleaned',
    '                   (collapse runs of whitespace, drop obvious typos).',
    '                   Multiple paragraphs are fine. Don\'t paraphrase.',
    '  is_announcement: true if this is an announcements / news / events section',
    '',
    'Return ONLY a JSON array of these objects, in the order they appear in',
    'the liturgy. No prose, no commentary. If you can\'t identify any clear',
    'sections (e.g., the document is just one big block of text), return a',
    'single section with section_kind="other" and the full body.',
  ].join('\n');

  const userText = `Liturgy title: ${liturgyTitle || '(none)'}

Liturgy body:
${trimmed}

Return the JSON array now.`;

  const response = await callClaude(
    {
      system,
      messages: [{ role: 'user', content: userText }],
      max_tokens: 4096,
    },
    { timeoutMs: 120000 }
  );
  const text = extractText(response);
  const parsed = parseJsonArrayLoose(text);
  if (!Array.isArray(parsed)) {
    throw new Error("Couldn't parse Claude's response as a JSON array.");
  }
  // Normalize.
  return parsed
    .filter((s) => s && typeof s === 'object' && typeof s.body === 'string' && s.body.trim())
    .map((s, i) => ({
      section_kind:
        typeof s.section_kind === 'string' ? s.section_kind.trim().toLowerCase() : 'other',
      title: typeof s.title === 'string' ? s.title.trim() : null,
      body: s.body.trim(),
      is_announcement:
        Boolean(s.is_announcement) ||
        (typeof s.section_kind === 'string' &&
          s.section_kind.toLowerCase().includes('announcement')),
      sort_order: i,
    }));
}

/**
 * Sermon Workspace — revise (or draft from scratch) a sermon manuscript.
 *
 * Sends the full conversation to Claude along with: the pastor's voice
 * guide + exemplar sermons, the manuscript markers reference, the
 * sermon's scripture / title / notes, the current manuscript text, and
 * the new revision instruction. Asks Claude to return ONLY the revised
 * manuscript (no preamble, no explanation) so we can drop the response
 * straight into the artifact pane.
 *
 * @param {Object} input
 * @param {Object} input.sermon                 - sermon row (title, scripture_reference, notes)
 * @param {string} input.manuscript             - current manuscript text (may be empty for from-scratch)
 * @param {string} [input.voiceSystemPrompt]    - pre-rendered voice guide (from loadVoiceGuideForPrompt)
 * @param {string} [input.markersReference]     - rendered markers reference (so Claude uses the right markers)
 * @param {string} [input.resourcesContext]     - selected resources bundled as text (added later in #188)
 * @param {Array<{role:'user'|'assistant', content:string}>} input.history - prior chat turns
 * @param {string} input.instruction            - the new user instruction this turn
 * @returns {Promise<string>} the revised manuscript text
 */
export async function reviseSermonManuscript({
  sermon,
  manuscript,
  voiceSystemPrompt = '',
  markersReference = '',
  resourcesContext = '',
  history = [],
  instruction,
}) {
  if (!instruction || !instruction.trim()) {
    throw new Error('Tell Claude what to change.');
  }

  const baseSystem = [
    "You are helping a United Methodist pastor write and revise sermon manuscripts.",
    'Each turn the pastor gives you an instruction. Your job is to return a revised',
    'manuscript that reflects exactly that instruction, nothing more.',
    '',
    '== Output rules ==',
    '- Return ONLY the full revised manuscript text. No preamble like "Here is...",',
    '  no closing remarks, no explanation of what you changed, no markdown fences.',
    '- Preserve the manuscript markers exactly as documented below — do not',
    '  invent your own.',
    '- Preserve hand edits the pastor made between turns. Do not silently undo a',
    '  change he made unless his current instruction explicitly asks you to.',
    '- Do not editorialize about the voice or theology you are matching. Just write',
    '  in the voice.',
    '- If the instruction is small (a sentence tweak), make a small targeted change',
    '  and leave the rest alone.',
    '- If the instruction is large (rewrite the second movement), do the rewrite,',
    "  but keep parts the instruction didn't address.",
  ].join('\n');

  const systemParts = [baseSystem];
  if (voiceSystemPrompt && voiceSystemPrompt.trim()) {
    systemParts.push(voiceSystemPrompt.trim());
  }
  if (markersReference && markersReference.trim()) {
    systemParts.push(markersReference.trim());
  }
  if (resourcesContext && resourcesContext.trim()) {
    systemParts.push(
      '# Selected resources for this revision\n\n' +
        'These are stories, illustrations, and quotes the pastor selected. ' +
        'Use them only if the instruction calls for them; do not force them in.\n\n' +
        resourcesContext.trim()
    );
  }

  // Sermon metadata header — gives Claude the scripture and title up front.
  const sermonHeader = [];
  if (sermon?.title) sermonHeader.push(`Sermon title: ${sermon.title}`);
  if (sermon?.scripture_reference)
    sermonHeader.push(`Scripture reference: ${sermon.scripture_reference}`);
  if (sermon?.notes) sermonHeader.push(`Pastor's private notes:\n${sermon.notes}`);

  // The first user message in the conversation always carries the
  // CURRENT manuscript so Claude has it as ground truth even on long
  // chats. Subsequent assistant turns will replace the manuscript;
  // for the next user turn we re-anchor with the live manuscript again.
  const anchor = [
    sermonHeader.length ? sermonHeader.join('\n') + '\n\n' : '',
    manuscript && manuscript.trim()
      ? '== CURRENT MANUSCRIPT ==\n\n' + manuscript
      : '== NO MANUSCRIPT YET ==\n\nStart from scratch. Draft a new manuscript based on the scripture and the instruction below.',
  ].join('');

  // Build the messages array. Strategy:
  //   1) Synthetic first turn: anchor (manuscript + metadata)
  //   2) Synthetic first assistant turn: acknowledges receipt
  //   3) Prior chat history (real turns from earlier this session)
  //   4) The new instruction as the final user turn
  const messages = [
    { role: 'user', content: anchor },
    {
      role: 'assistant',
      content:
        "Got it. I have the current manuscript and the sermon context. Tell me what to change.",
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: instruction.trim() },
  ];

  // Manuscripts can be long; allow up to 64k output tokens. Claude sonnet
  // 4 supports that; the proxy passes through whatever model is configured
  // server-side. 4 minutes timeout is generous for a long revision.
  const response = await callClaude(
    {
      system: systemParts.join('\n\n'),
      messages,
      max_tokens: 16000,
    },
    { timeoutMs: 240000 }
  );
  const text = extractText(response);
  return (text || '').trim();
}

/**
 * The static markers reference Claude needs to know about. Mirrors the
 * MANUSCRIPT_MARKERS in lib/printPreferences.js but rendered as prose
 * suitable for a system prompt.
 */
export function buildMarkersReferenceText() {
  return [
    '# Manuscript markers',
    '',
    'When you draft or revise a manuscript, use these inline markers exactly. The Word',
    'exporter will detect them automatically and apply the right formatting; you should',
    'not try to format anything yourself.',
    '',
    '- "Don\'t Read Scripture First" instruction → write it on its own line, exactly that text.',
    '- "Read [Scripture Reference]" instruction → write it on its own line, e.g. "Read Acts 2:42-47".',
    '- Slide markers → write them as <SLIDE #N – Description>, where N is the slide number',
    '  and Description is a short label. Slide markers can be on their own line, or',
    "  inline within a body paragraph if that's how the narrative flow wants them.",
    '- Body text → just write naturally. Use smart quotes (" ") for scripture quotations,',
    '  not italics. Italics are reserved for foreign / Latin terms (e.g. risus paschalis)',
    '  and book or work titles.',
  ].join('\n');
}

/**
 * Sermon Workspace — propose how to use one or more resources in the
 * current manuscript, WITHOUT writing the revised manuscript itself.
 *
 * Distinct from reviseSermonManuscript: that helper produces a finished
 * draft. This helper produces a SHORT, ACTIONABLE PLAN in second person
 * — "place this story between paragraphs 4 and 5; quote it in full;
 * land on the line about hope" — that the pastor reads and reacts to
 * before committing to a revision turn.
 *
 * Output format (markdown-ish, two short sections):
 *   ## Where it goes
 *   ...one short paragraph naming the spot in the manuscript...
 *
 *   ## How it lands
 *   ...one short paragraph naming the rhetorical move...
 *
 * The conversation supports refinement: the pastor can give feedback
 * ("that's too early — try moving it after the second illustration")
 * and Claude returns a revised proposal. History flows back as a
 * normal user/assistant chat.
 *
 * @param {Object} input
 * @param {Object} input.sermon
 * @param {string} input.manuscript
 * @param {string} [input.voiceSystemPrompt]
 * @param {string} [input.markersReference]
 * @param {string} input.resourcesContext  - resources to consider, formatted by buildResourcesContext
 * @param {Array<{role:'user'|'assistant', content:string}>} [input.history]
 *   Prior chat turns within this exploration. The first turn is
 *   synthesized by the caller (or this helper) — see below.
 * @param {string} [input.feedback] - optional pastor feedback for refinement
 * @returns {Promise<string>} the proposal text
 */
export async function proposeResourceUsage({
  sermon,
  manuscript,
  voiceSystemPrompt = '',
  markersReference = '',
  resourcesContext = '',
  history = [],
  feedback = '',
}) {
  if (!resourcesContext || !resourcesContext.trim()) {
    throw new Error('No resources to explore.');
  }

  const baseSystem = [
    'You are helping a United Methodist pastor decide HOW to use one or',
    'more sermon-prep resources in an existing sermon manuscript.',
    '',
    "Your job on this turn is NOT to rewrite the manuscript. Your job is",
    'to PROPOSE a plan in plain English that the pastor reads and reacts',
    'to. Be specific. Reference paragraph numbers or distinctive phrases',
    "from the manuscript so it's clear where the resource lands.",
    '',
    'Always return the proposal in this exact two-section format:',
    '',
    '## Where it goes',
    '',
    'One short paragraph (2-4 sentences). Name the spot — paragraph index,',
    'a distinctive sentence, or "right after the second illustration about',
    'doubt." Be concrete about position; never say "anywhere" or "early in',
    'the sermon."',
    '',
    '## How it lands',
    '',
    'One short paragraph (2-4 sentences). Name the rhetorical move:',
    'illustration of an existing point, pivot to a new movement, image',
    'before the application, etc. Note any shaping the resource needs to',
    "fit (trim, partial quote, paraphrase). Don't write the actual prose;",
    'describe the move.',
    '',
    'If the pastor pushes back with feedback, revise the proposal and',
    'return the same two sections again. Do not include preambles, do not',
    'apologize, do not summarize the manuscript or the resource — just',
    'the two sections.',
  ].join('\n');

  const systemParts = [baseSystem];
  if (voiceSystemPrompt && voiceSystemPrompt.trim()) {
    systemParts.push(voiceSystemPrompt.trim());
  }
  if (markersReference && markersReference.trim()) {
    systemParts.push(markersReference.trim());
  }
  systemParts.push(
    '# Resources under consideration\n\n' + resourcesContext.trim()
  );

  const sermonHeader = [];
  if (sermon?.title) sermonHeader.push(`Sermon title: ${sermon.title}`);
  if (sermon?.scripture_reference)
    sermonHeader.push(`Scripture reference: ${sermon.scripture_reference}`);
  const headerBlock = sermonHeader.length
    ? sermonHeader.join('\n') + '\n\n'
    : '';

  // Number paragraphs so Claude can reference them by index in
  // "Where it goes." Mirrors what suggestSlidesForManuscript does.
  const paragraphs = (manuscript || '')
    .split(/\n[ \t]*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const numbered = paragraphs.map((p, i) => `[¶${i}] ${p}`).join('\n\n');
  const anchor =
    headerBlock +
    'Manuscript paragraphs (numbered):\n\n' +
    numbered;

  // First turn: anchor; second turn: assistant ack; then history; then
  // current ask (proposal request OR refinement feedback).
  const initialUserAsk =
    history.length === 0
      ? 'Propose how to use the resource(s) under consideration in this manuscript. Two sections: Where it goes / How it lands.'
      : feedback ||
        'Refine the proposal based on the conversation above and return the same two sections again.';

  const messages = [
    { role: 'user', content: anchor },
    {
      role: 'assistant',
      content:
        'Got it. I have the manuscript and the resource(s). Tell me what you want to consider.',
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: initialUserAsk },
  ];

  const response = await callClaude(
    {
      system: systemParts.join('\n\n'),
      messages,
      max_tokens: 2000,
    },
    { timeoutMs: 90000 }
  );
  const text = extractText(response);
  return (text || '').trim();
}

/**
 * Sermon Workspace — propose slides for a manuscript.
 *
 * Sends the numbered manuscript paragraphs to Claude and asks for a
 * batch of slide proposals. Each proposal carries a slide_type, title,
 * body, speaker notes, the anchor paragraph index, and a one-sentence
 * rationale. The pastor reviews the batch in a modal and accepts/edits/
 * rejects each one before they land in the workspace_slides table.
 *
 * @param {Object} input
 * @param {Object} input.sermon          - sermon row (title, scripture_reference)
 * @param {string} input.manuscript      - current manuscript text
 * @param {number[]} [input.skipParagraphIdxs] - paragraph indices that already
 *   have a slide anchored; Claude is told to skip these so we don't
 *   duplicate.
 * @returns {Promise<Array<{
 *   slide_type: 'title'|'scripture'|'quote'|'image'|'content'|'blank',
 *   title: string,
 *   body: string,
 *   notes: string,
 *   anchor_paragraph_idx: number|null,
 *   rationale: string,
 * }>>}
 */
export async function suggestSlidesForManuscript({
  sermon,
  manuscript,
  skipParagraphIdxs = [],
}) {
  if (!manuscript || !manuscript.trim()) {
    throw new Error('Nothing to suggest slides for — manuscript is empty.');
  }

  // Number the paragraphs explicitly so Claude can reference them by
  // index in its anchor_paragraph_idx field.
  const paragraphs = manuscript
    .split(/\n[ \t]*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) {
    throw new Error('Manuscript has no paragraphs to anchor slides to.');
  }
  const numbered = paragraphs
    .map((p, i) => `[¶${i}] ${p}`)
    .join('\n\n');

  const skipList =
    skipParagraphIdxs.length > 0
      ? `\n\nDo NOT propose slides anchored to these paragraph indices (they already have slides): ${skipParagraphIdxs.join(', ')}.`
      : '';

  const sermonHeader = [];
  if (sermon?.title) sermonHeader.push(`Sermon title: ${sermon.title}`);
  if (sermon?.scripture_reference)
    sermonHeader.push(`Scripture reference: ${sermon.scripture_reference}`);
  const headerBlock = sermonHeader.length
    ? sermonHeader.join('\n') + '\n\n'
    : '';

  const system = [
    'You are helping a United Methodist pastor build a sermon-day slide deck.',
    '',
    'Slide types:',
    '  - title:     Opening title slide (sermon title + scripture reference). Usually slide 1.',
    '  - scripture: Display a scripture passage in full so the congregation can read along.',
    '  - quote:     A pull quote from the sermon — a single striking sentence the preacher wants on screen.',
    '  - image:     A scene the slide should depict (you describe what kind of image; a designer or stock photo will be picked later).',
    '  - content:   A few bullet points / a heading that summarizes a teaching moment.',
    '  - blank:     Deliberate visual pause (blank screen) — only when the manuscript explicitly calls for it.',
    '',
    'Guidelines:',
    '  - Aim for ONE SLIDE PER MAJOR BEAT in the sermon. For a 2000-3000-word manuscript that\'s usually 8-15 slides total.',
    '  - Most paragraphs do NOT need a slide. Connective prose and theological setup are usually slide-less. Only propose a slide when there\'s a real visual payoff.',
    '  - If the manuscript starts with the standard "Don\'t Read Scripture First" / "Read [Reference]" instructions, the first content slide should be a title slide. Anchor it to paragraph 0 (or the first non-instruction paragraph).',
    '  - For scripture slides: only quote what the manuscript itself quotes. Do not invent passages.',
    '  - For pull-quote slides: pick the preacher\'s actual words from the manuscript. Don\'t paraphrase.',
    '  - For image slides: describe what the image should show in 1-2 sentences. Don\'t pretend you can pick the actual photo.',
    '  - Keep slide titles short (max ~6 words). Bodies should fit on a single slide read at preaching pace.',
    '  - The anchor_paragraph_idx is the 0-based index of the paragraph in the manuscript where the preacher should advance to this slide.',
    '',
    'Output: a JSON array of slide proposals. Return ONLY the JSON array. No prose, no markdown fences. Each proposal:',
    '  {',
    '    "slide_type": one of the types above,',
    '    "title": short heading on the slide,',
    '    "body": main slide content (verse text, the quote, the bullets, or the image description),',
    '    "notes": one or two sentences of context for the preacher (why this slide, what to do with it),',
    '    "anchor_paragraph_idx": 0-based paragraph index where the preacher advances to this slide,',
    '    "rationale": one sentence on why you proposed this slide',
    '  }',
  ].join('\n');

  const userMsg =
    headerBlock +
    'Manuscript paragraphs (numbered):\n\n' +
    numbered +
    skipList;

  const response = await callClaude(
    {
      system,
      messages: [{ role: 'user', content: userMsg }],
      // Bumped from 8k → 16k so 12-15 slides with full bodies + notes
      // don't get truncated mid-array.
      max_tokens: 16000,
    },
    { timeoutMs: 180000 }
  );
  const text = extractText(response);
  // Use the robust parser: handles trailing commas and recovers complete
  // objects when the response was truncated mid-element.
  const parsed = parseJsonArrayRobust(text);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    const snippet = (text || '').slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(
      "Couldn't parse Claude's slide suggestions as a JSON array. " +
        `Response started with: "${snippet}${snippet.length >= 200 ? '…' : ''}". ` +
        'Try clicking "Generate suggestions" again.'
    );
  }

  const validTypes = new Set(['title', 'scripture', 'quote', 'image', 'content', 'blank']);
  return parsed
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const slideType = validTypes.has(s.slide_type) ? s.slide_type : 'content';
      const idx =
        Number.isInteger(s.anchor_paragraph_idx) &&
        s.anchor_paragraph_idx >= 0 &&
        s.anchor_paragraph_idx < paragraphs.length
          ? s.anchor_paragraph_idx
          : null;
      return {
        slide_type: slideType,
        title: typeof s.title === 'string' ? s.title.trim() : '',
        body: typeof s.body === 'string' ? s.body.trim() : '',
        notes: typeof s.notes === 'string' ? s.notes.trim() : '',
        anchor_paragraph_idx: idx,
        anchor_paragraph_text: idx !== null ? paragraphs[idx] : null,
        rationale: typeof s.rationale === 'string' ? s.rationale.trim() : '',
      };
    });
}
