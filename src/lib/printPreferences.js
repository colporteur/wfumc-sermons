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
  header_alignment: 'center',
  header_italic: false,
  header_size_pt: 12,
  footer_content: '',
  footer_alignment: 'center',
  footer_italic: false,
  footer_size_pt: 12,
  title_in_body: true,
  default_church_name: '',
  show_scripture_reference: true,
  scripture_format: 'block_indent',
  page_break_between_sections: false,
};

// One-click preset matching Todd's standard sermon manuscript format:
// Bookman Old Style 18pt double-spaced on US Letter with 1in margins
// all around. Title goes in the centered italic Word header (12pt),
// and the footer carries date / church / scripture in italic 12pt
// centered, with the page number rendered separately. The body starts
// directly with the first instruction line — no title block.
//
// Applied via the "Use sermon manuscript preset" button on the
// settings page. The user can save as-is or tweak before saving.
export const SERMON_MANUSCRIPT_PRESET = {
  font_family: 'Bookman Old Style',
  font_size_pt: 18,
  line_spacing: 2.0,
  margin_top_in: 1.0,
  margin_bottom_in: 1.0,
  margin_left_in: 1.0,
  margin_right_in: 1.0,
  page_number_position: 'bottom_center',
  header_content: '{title}',
  header_alignment: 'center',
  header_italic: true,
  header_size_pt: 12,
  footer_content: '{date} – {church} – {scripture}',
  footer_alignment: 'center',
  footer_italic: true,
  footer_size_pt: 12,
  title_in_body: false,
  show_scripture_reference: false, // already in footer; don't duplicate
  scripture_format: 'inline',      // body scripture stays in the flow
  page_break_between_sections: false,
};

// Reference: special inline markers Todd uses in his manuscripts.
// The docx exporter (task #194) reads each manuscript paragraph,
// detects these patterns, and applies the documented formatting.
// Surfaced on the settings page so it's discoverable, and fed into
// Claude's system prompt by the Sermon Workspace so Claude knows the
// conventions when drafting.
export const MANUSCRIPT_MARKERS = [
  {
    id: 'dont_read_first',
    label: '"Don\'t Read Scripture First" instruction',
    pattern: 'A line that reads exactly: Don\'t Read Scripture First',
    formatting:
      'Own paragraph, centered, bold red text (#EE0000) on bright green highlight.',
  },
  {
    id: 'read_scripture',
    label: '"Read [Scripture Reference]" instruction',
    pattern:
      'A line that begins with "Read " followed by a scripture reference (e.g. Read Acts 2:42-47).',
    formatting:
      'Own paragraph, left-aligned, bold red text (#EE0000) on bright green highlight.',
  },
  {
    id: 'slide_marker',
    label: 'Slide markers',
    pattern:
      'Anywhere in the text: <SLIDE #1 – Description> (any number, em or en dash, any description). May be on its own line or inline within a body paragraph.',
    formatting:
      'Bold red text (#FF0000) on yellow highlight. When inline, surrounding body text stays in regular formatting.',
  },
  {
    id: 'body_text',
    label: 'Body text',
    pattern: 'Everything that isn\'t one of the above.',
    formatting:
      'Regular weight, no color, no highlight. Smart quotes (" ") for scripture quotations — no italics. Italics only for foreign / Latin terms (e.g. risus paschalis) and book or work titles.',
  },
];

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
    'header_alignment',
    'header_italic',
    'header_size_pt',
    'footer_content',
    'footer_alignment',
    'footer_italic',
    'footer_size_pt',
    'title_in_body',
    'default_church_name',
    'show_scripture_reference',
    'scripture_format',
    'page_break_between_sections',
  ];
  for (const k of writable) {
    if (values[k] === undefined) continue;
    payload[k] = values[k];
  }
  // Number coercion
  for (const k of ['font_size_pt', 'header_size_pt', 'footer_size_pt']) {
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

// Substitute header/footer tokens. Used at export time AND by the
// preview pane. Tokens supported:
//   {title}     — sermon title
//   {scripture} — scripture reference (e.g. "Acts 2:42-47")
//   {date}      — preached date or export-time date
//   {church}    — church name (from prefs.default_church_name or override)
//   {page}      — page number (Word fills it itself; preview shows "#")
//
// Older callers may still import renderHeaderTokens — kept as an alias
// so nothing breaks.
export function renderTokens(template, ctx = {}) {
  if (!template) return '';
  return template
    .replace(/\{title\}/g, ctx.title || '')
    .replace(/\{scripture\}/g, ctx.scripture || '')
    .replace(/\{date\}/g, ctx.date || '')
    .replace(/\{church\}/g, ctx.church || '')
    .replace(/\{page\}/g, ctx.page || '#');
}
export const renderHeaderTokens = renderTokens;
