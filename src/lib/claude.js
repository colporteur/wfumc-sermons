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
 */
export async function callClaude(body) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new Error('Not signed in');
  }
  const res = await withTimeout(
    fetch(`${supabaseUrl}/functions/v1/claude-proxy`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
    }),
    30000
  );
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
 * Classify a batch of imported notes into resource types.
 *
 * @param {Array<{ id: string, title?: string, snippet: string }>} items
 * @returns {Promise<Record<string, 'story'|'quote'|'illustration'|'joke'|'note'|'photo'>>}
 *   Map of input id → suggested type. Items Claude can't classify
 *   default to 'note'.
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
    const system = [
      'You categorize sermon-prep notes into one of:',
      '  story         — a narrative anecdote (personal or 3rd-person)',
      '  quote         — a short attributed saying or excerpt',
      '  illustration  — a metaphor or analogy used to teach',
      '  joke          — humor, intentionally light',
      '  note          — generic notes, ideas, observations',
      '  photo         — describes a visual reference',
      '',
      'Return ONLY a JSON array of objects: [{"id": "<the id>", "type": "<one of the above>"}, ...]',
      'Use the exact ids you receive. No explanation, no prose.',
    ].join('\n');
    const lines = batch.map(
      (it) =>
        `id=${it.id}\ntitle: ${it.title || '(untitled)'}\nsnippet: ${(
          it.snippet || ''
        ).slice(0, 200).replace(/\s+/g, ' ')}`
    );
    const user = `Classify these ${batch.length} items:\n\n${lines.join('\n---\n')}`;

    let parsed = null;
    try {
      const response = await callClaude({
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: 1500,
      });
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
          if (VALID.has(t)) out[row.id] = t;
        }
      }
    }
    // Anything Claude missed → default to 'note'
    for (const it of batch) {
      if (!out[it.id]) out[it.id] = 'note';
    }
  }
  return out;
}
