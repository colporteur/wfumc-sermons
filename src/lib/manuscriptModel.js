// Choice of Claude model for sermon manuscript work specifically.
//
// The choice is persisted in localStorage so it survives page reloads
// and PWA restarts. Defaults to "default" — which means "let the proxy
// pick" (currently Sonnet 4.6). Pastor can opt into Opus 4.8 for
// higher-quality manuscript work at higher cost / latency.
//
// This setting ONLY affects the two manuscript-revision call sites:
//   - reviseSermonManuscript (the chat-revise loop)
//   - reviseManuscriptSnippet (the highlight-and-revise flow)
// Brainstorm, slide suggester, NRSVUe lookup, resource extraction,
// etc. all continue to use the proxy default.
//
// If Anthropic publishes a different identifier than what we have
// here, just update the `id` field — UI labels and storage key stay
// the same so the pastor's saved selection survives.

export const MANUSCRIPT_MODEL_OPTIONS = [
  {
    key: 'default',
    id: null, // null means "send no model field; proxy decides"
    label: 'Sonnet 4.6 (default — faster, cheaper)',
    short: 'Sonnet 4.6',
  },
  {
    key: 'opus-4-8',
    id: 'claude-opus-4-8',
    label: 'Opus 4.8 (slower, costlier, more thoughtful)',
    short: 'Opus 4.8',
  },
];

const STORAGE_KEY = 'wfumc-sermons-manuscript-model';

export function loadManuscriptModelKey() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (
      saved &&
      MANUSCRIPT_MODEL_OPTIONS.some((o) => o.key === saved)
    ) {
      return saved;
    }
  } catch {
    // localStorage unavailable (private window, etc.) — fall through
    // to the default. Choice is ephemeral in that session.
  }
  return 'default';
}

export function saveManuscriptModelKey(key) {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Same fallback as above — just don't persist.
  }
}

/**
 * Translate a stored key into the actual model ID to send to Claude.
 * Returns null for "default" (caller should NOT include the model
 * field at all — that lets the proxy pick).
 */
export function modelIdForKey(key) {
  const opt = MANUSCRIPT_MODEL_OPTIONS.find((o) => o.key === key);
  return opt?.id || null;
}

/**
 * Short label for inline display next to the chat input ("Using:
 * Opus 4.8"). Always returns something — falls back to the default
 * label for unknown keys.
 */
export function shortLabelForKey(key) {
  const opt = MANUSCRIPT_MODEL_OPTIONS.find((o) => o.key === key);
  return opt?.short || MANUSCRIPT_MODEL_OPTIONS[0].short;
}
