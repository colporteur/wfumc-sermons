// Registry-driven model options — Phase A of the global AI model
// registry (ai_models table, migration 0072, managed in Bulletin App
// → Settings → AI Models).
//
// Pickers call useModelOptions(surface) and render whatever the
// registry says. The old hardcoded lists (manuscriptModel.js,
// creativeModel.js) survive as OFFLINE FALLBACKS: they render
// instantly on first paint and take over entirely if the registry
// can't be reached, so a Supabase hiccup never breaks a picker.
//
// Option shape (same as the legacy lists):
//   { key, id, label, short, hint }
//   id === null → send no model field; the proxy default decides.

import { useEffect, useState } from 'react';
import { supabase, withTimeout } from './supabase';
import { MANUSCRIPT_MODEL_OPTIONS } from './manuscriptModel';
import { CREATIVE_MODEL_OPTIONS } from './creativeModel';

const FALLBACKS = {
  manuscript: MANUSCRIPT_MODEL_OPTIONS,
  creative: CREATIVE_MODEL_OPTIONS,
};

// Per-surface memory cache — one registry fetch per surface per page
// load is plenty.
const cache = new Map();

export async function fetchModelsForSurface(surface) {
  if (cache.has(surface)) return cache.get(surface);
  const { data, error } = await withTimeout(
    supabase
      .from('ai_models')
      .select('key, model_id, label, short_label, hint')
      .eq('enabled', true)
      .contains('surfaces', [surface])
      .order('sort_order', { ascending: true })
  );
  if (error) throw error;
  const options = (data || []).map((r) => ({
    key: r.key,
    id: r.model_id, // null = proxy default, by registry convention
    label: r.label,
    short: r.short_label,
    hint: r.hint || '',
  }));
  if (options.length > 0) cache.set(surface, options);
  return options;
}

/**
 * React hook: registry options for a surface, starting from the
 * hardcoded fallback and swapping in the registry list when it lands.
 */
export function useModelOptions(surface) {
  const [options, setOptions] = useState(
    () => cache.get(surface) || FALLBACKS[surface] || []
  );
  useEffect(() => {
    let cancelled = false;
    fetchModelsForSurface(surface)
      .then((rows) => {
        if (!cancelled && rows.length > 0) setOptions(rows);
      })
      .catch(() => {
        /* registry unreachable — the fallback list stands */
      });
    return () => {
      cancelled = true;
    };
  }, [surface]);
  return options;
}

/**
 * Resolve a saved picker key against the loaded options. Unknown keys
 * (e.g., a registry row that was deleted after being selected) resolve
 * to null — the proxy default — which is always safe.
 */
export function modelIdForOption(options, key) {
  return options.find((o) => o.key === key)?.id ?? null;
}

export function shortLabelForOption(options, key) {
  return (
    options.find((o) => o.key === key)?.short ||
    options[0]?.short ||
    'Default'
  );
}

/**
 * A saved key that no longer exists in the options should render as
 * 'default' in <select> elements (otherwise the select shows blank).
 */
export function displayKeyForOption(options, key) {
  return options.some((o) => o.key === key) ? key : 'default';
}
