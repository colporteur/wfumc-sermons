import { supabase, withTimeout } from './supabase';

// Helpers for the print_preferences table (one row per user).
// Consumed by the upcoming Word + PowerPoint exporters and by the
// settings page. Per-sermon overrides are layered on top at export
// time, not stored here.

// What we hand back when there's no row yet — same shape as the table
// defaults, so callers can render a preview without first saving.
export const DEFAULT_PRINT_PREFS = {
  font_family: 'Cambria',
  font_size_pt: 14,
  line_spacing: 1.5,
  margin_top_in: 1.0,
  margin_bottom_in: 1.0,
  margin_left_in: 1.25,
  margin_right_in: 1.25,
  page_number_position: 'bottom_right',
  header_content: '',
  show_scripture_reference: true,
  scripture_format: 'block_indent',
  page_break_between_sections: false,
};

// Common font choices the picker offers. The pastor can also type in
// any other font name — this is just a convenience list of fonts
// that ship with Microsoft Office and render well in printed manuscripts.
export const COMMON_PRINT_FONTS = [
  'Cambria',
  'Georgia',
  'Garamond',
  'Palatino Linotype',
  'Constantia',
  'Times New Roman',
  'Calibri',
  'Verdana',
  'Albertus Medium',
];

export const PAGE_NUMBER_POSITIONS = [
  { value: 'none',           label: 'No page numbers' },
  { value: 'top_left',       label: 'Top — left' },
  { value: 'top_center',     label: 'Top — center' },
  { value: 'top_right',      label: 'Top — right' },
  { value: 'bottom_left',    label: 'Bottom — left' },
  { value: 'bottom_center',  label: 'Bottom — center' },
  { value: 'bottom_right',   label: 'Bottom — right' },
];

export const SCRIPTURE_FORMATS = [
  { value: 'inline',       label: 'Inline (no special formatting)' },
  { value: 'block_indent', label: 'Block-indent (offset paragraph)' },
  { value: 'italic',       label: 'Italic' },
];

// Fetch the current user's prefs row, or null if they haven't saved yet.
export async function fetchPrintPrefs(userId) {
  if (!userId) return null;
  const { data, error } = await withTimeout(
    supabase
      .from('print_preferences')
      .select('*')
      .eq('owner_user_id', userId)
      .maybeSingle()
  );
  if (error) throw error;
  return data ?? null;
}

// Same as fetchPrintPrefs, but layers the row over DEFAULT_PRINT_PREFS
// so callers always get a fully-populated object even when no row exists.
// Used by exporters and by the live preview pane on the settings page.
export async function loadPrintPrefs(userId) {
  const row = await fetchPrintPrefs(userId);
  return { ...DEFAULT_PRINT_PREFS, ...(row ?? {}) };
}

// Upsert prefs for the current user. Returns the saved row.
export async function savePrintPrefs(userId, values) {
  if (!userId) throw new Error('No user');
  const payload = { owner_user_id: userId };
  // Coerce + clamp the writable fields. We don't trust the form to do
  // this perfectly (typed input + numeric coercion).
  const writable = [
    'font_family',
    'font_size_pt',
    'line_spacing',
    'margin_top_in',
    'margin_bottom_in',
    'margin_left_in',
    'margin_right_in',
    'page_number_position',
    'header_content',
    'show_scripture_reference',
    'scripture_format',
    'page_break_between_sections',
  ];
  for (const k of writable) {
    if (values[k] === undefined) continue;
    payload[k] = values[k];
  }
  // Number coercion
  for (const k of ['font_size_pt']) {
    if (payload[k] != null) payload[k] = Math.round(Number(payload[k]));
  }
  for (const k of [
    'line_spacing',
    'margin_top_in',
    'margin_bottom_in',
    'margin_left_in',
    'margin_right_in',
  ]) {
    if (payload[k] != null) payload[k] = Number(payload[k]);
  }
  const { data, error } = await withTimeout(
    supabase
      .from('print_preferences')
      .upsert(payload, { onConflict: 'owner_user_id' })
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

// Substitute header tokens. Used at export time AND by the preview
// pane. Tokens supported: {title}, {scripture}, {date}, {page}.
// {page} is left as a literal in the preview (Word fills it itself).
export function renderHeaderTokens(template, ctx = {}) {
  if (!template) return '';
  return template
    .replace(/\{title\}/g, ctx.title || '')
    .replace(/\{scripture\}/g, ctx.scripture || '')
    .replace(/\{date\}/g, ctx.date || '')
    .replace(/\{page\}/g, ctx.page || '#');
}
