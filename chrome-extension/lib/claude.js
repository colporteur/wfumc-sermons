// Direct Anthropic Messages API wrapper.
//
// Uses the `anthropic-dangerous-direct-browser-access` header so that
// the API accepts requests originating from a browser context (Chrome
// extensions count). Your API key lives in chrome.storage.sync only on
// your own browser.
//
// Two helpers:
//   summarizePage(text, url)       — 1-2 paragraph summary for the
//                                    resource content field.
//   analyzeResource({content,url}) — JSON: { title, themes[], scripture_refs,
//                                    tone, type, source, notes } to pre-fill
//                                    the form.

import { getSettings } from './storage.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-5';

class ClaudeError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function callClaude({ system, messages, max_tokens = 1500 }) {
  const { anthropicApiKey } = await getSettings();
  if (!anthropicApiKey) {
    throw new ClaudeError(
      'Anthropic API key not set. Open the extension Settings page.'
    );
  }
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens,
      system,
      messages,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ClaudeError(
      body?.error?.message || `Claude API error (${res.status})`,
      res.status,
      body
    );
  }
  return body;
}

export async function summarizePage({ text, url, title }) {
  if (!text || !text.trim()) {
    throw new ClaudeError('Page has no readable text to summarize.');
  }
  // Cap input — Claude can take a lot, but pages can be huge and we
  // want to keep cost predictable.
  const trimmed = text.length > 30000 ? text.slice(0, 30000) + '…[truncated]' : text;
  const system =
    'You are summarizing a web page so it can be saved into a pastor\'s sermon-prep resource library. ' +
    'Return a tight 1-2 paragraph summary in plain prose — no headers, no markdown, no bullet lists. ' +
    'Capture the central point and any vivid detail that would be useful in a sermon. ' +
    'Skip navigation, ads, comments. If the page seems to be primarily an article or essay, summarize the article. ' +
    'If the page has multiple unrelated items, pick the most substantive one. Do not include the URL in the summary.';
  const userText = `URL: ${url || '(unknown)'}
Title: ${title || '(unknown)'}

Page text:
${trimmed}`;
  const result = await callClaude({
    system,
    messages: [{ role: 'user', content: userText }],
    max_tokens: 600,
  });
  return result?.content?.[0]?.text?.trim() || '';
}

// Analyze the captured content + context and propose values for the
// resource form fields. Returns:
//   {
//     title: string,
//     resource_type: 'story'|'quote'|'illustration'|'joke'|'note'|'photo',
//     source: string,
//     themes: string[],     // tags
//     scripture_refs: string,
//     tone: string,
//     notes: string,
//   }
export async function analyzeResource({ content, sourceUrl, pageTitle, currentType }) {
  if (!content || !content.trim()) {
    throw new ClaudeError('No content to analyze.');
  }
  const trimmed = content.length > 12000 ? content.slice(0, 12000) + '…[truncated]' : content;
  const typeNote = currentType
    ? `The user has tentatively chosen resource_type="${currentType}". Keep that unless the content is clearly a different kind.`
    : 'Pick the resource_type that best fits the content.';
  const system = `You are helping a pastor classify a piece of source material for their sermon-prep resource library.

You will receive a snippet of content (text, summary, or photo description), the source URL, and the page title.

Return ONLY a JSON object — no markdown code fences, no commentary. Schema:
{
  "title": string,                                                     // short, descriptive title (4-8 words). Pick something the pastor would search for.
  "resource_type": "story"|"quote"|"illustration"|"joke"|"note"|"photo", // the kind of resource
  "source": string|null,                                                // attribution: who said this / where it's from. Free-form. Use the page's author/site if relevant.
  "themes": string[],                                                   // 1-5 lowercase, hyphenated theme tags (e.g. "grace", "forgiveness", "stewardship"). Use the broadest accurate themes a pastor might preach on.
  "scripture_refs": string|null,                                        // semicolon-separated scripture connections if any are clearly evoked, e.g. "Mark 12:28-34; Romans 13:8". Leave null if no clear connection.
  "tone": string|null,                                                  // one word: "humorous"|"somber"|"hopeful"|"convicting"|"reflective"|"inspiring"|etc. Leave null if unclear.
  "notes": string|null                                                  // optional 1-sentence note about how/where this might land in a sermon. Leave null if you have nothing useful to add.
}

${typeNote}

Be honest — if you can't tell something, return null. Don't invent attributions or scripture connections.`;
  const userText = `SOURCE URL: ${sourceUrl || '(unknown)'}
PAGE TITLE: ${pageTitle || '(unknown)'}

CONTENT:
${trimmed}

Return the JSON now.`;
  const result = await callClaude({
    system,
    messages: [{ role: 'user', content: userText }],
    max_tokens: 800,
  });
  const text = result?.content?.[0]?.text?.trim();
  if (!text) throw new ClaudeError('Claude returned an empty response.');
  let parsed;
  try {
    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '')
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ClaudeError(
      `Couldn't parse Claude's response as JSON. Raw: ${text.slice(0, 200)}`
    );
  }
  // Normalize types
  if (!Array.isArray(parsed.themes)) parsed.themes = [];
  parsed.themes = parsed.themes
    .map((t) => (typeof t === 'string' ? t.trim().toLowerCase() : null))
    .filter(Boolean);
  return parsed;
}
