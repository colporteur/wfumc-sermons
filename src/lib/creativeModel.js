// Model choice for the Creative Studio — separate from the manuscript
// picker (lib/manuscriptModel.js) because brainstorming and manuscript
// revision have different cost/quality trade-offs and Todd asked for a
// wider palette here.
//
// Persisted in localStorage under its own key so the Studio remembers
// the choice across reloads without touching the manuscript picker's
// saved selection.
//
// Model ids follow Anthropic's published identifiers. If Anthropic
// ships a different string for any of these, it's a one-line fix in
// this array — labels and the storage key stay stable so the saved
// selection survives.

export const CREATIVE_MODEL_OPTIONS = [
  {
    key: 'default',
    id: null, // null = send no model field; proxy default (Sonnet 4.6)
    label: 'Sonnet 4.6 (proxy default)',
    short: 'Sonnet 4.6',
    hint: 'The suite-wide default. Fast, cheap, solid.',
  },
  {
    key: 'haiku-4-5',
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5 (fastest, cheapest)',
    short: 'Haiku 4.5',
    hint: 'Rapid-fire idea volleys. Great for card draws and long list generation.',
  },
  {
    key: 'sonnet-5',
    id: 'claude-sonnet-5',
    label: 'Sonnet 5 (newer, sharper)',
    short: 'Sonnet 5',
    hint: 'Stronger than 4.6 at the same tier. Good everyday Studio choice.',
  },
  {
    key: 'opus-4-8',
    id: 'claude-opus-4-8',
    label: 'Opus 4.8 (deep, deliberate)',
    short: 'Opus 4.8',
    hint: 'Heavier exegetical lifting and careful draft copy.',
  },
  {
    key: 'fable-5',
    id: 'claude-fable-5',
    label: 'Fable 5 (most capable)',
    short: 'Fable 5',
    hint: 'Anthropic\'s top model. Best for the hardest texts and boldest drafts.',
  },
];

const STORAGE_KEY = 'wfumc-sermons-creative-model';

export function loadCreativeModelKey() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && CREATIVE_MODEL_OPTIONS.some((o) => o.key === saved)) {
      return saved;
    }
  } catch {
    /* localStorage unavailable — fall through to default */
  }
  return 'default';
}

export function saveCreativeModelKey(key) {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* non-fatal */
  }
}

export function creativeModelIdForKey(key) {
  return CREATIVE_MODEL_OPTIONS.find((o) => o.key === key)?.id ?? null;
}

export function creativeModelShortLabel(key) {
  return CREATIVE_MODEL_OPTIONS.find((o) => o.key === key)?.short ?? 'Default';
}
