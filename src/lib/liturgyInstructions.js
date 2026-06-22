// CRUD wrapper for the liturgy_element_instructions table — per-user,
// per-element-type persistent guidance the pastor wants prepended to
// every Claude drafting/brainstorming call for that element.
//
// One row per (owner_user_id, element_type). UPSERT on save.

import { supabase, withTimeout } from './supabase';
import { generateLiturgyTheme } from './claude';

/**
 * Load all of a user's saved instructions, keyed by element_type.
 * Returns { [element_type]: instructions_string }.
 */
export async function loadAllInstructions(ownerUserId) {
  if (!ownerUserId) return {};
  const { data, error } = await withTimeout(
    supabase
      .from('liturgy_element_instructions')
      .select('element_type, instructions')
      .eq('owner_user_id', ownerUserId)
  );
  if (error) throw error;
  const out = {};
  for (const row of data || []) {
    out[row.element_type] = row.instructions || '';
  }
  return out;
}

/**
 * Load a single (element_type) row. Returns the instructions string
 * (empty if no row exists — first time use).
 */
export async function loadInstructionsForElement(ownerUserId, elementType) {
  if (!ownerUserId || !elementType) return '';
  const { data, error } = await withTimeout(
    supabase
      .from('liturgy_element_instructions')
      .select('instructions')
      .eq('owner_user_id', ownerUserId)
      .eq('element_type', elementType)
      .maybeSingle()
  );
  if (error) throw error;
  return data?.instructions || '';
}

/**
 * UPSERT a single (element_type) row. Empty string clears the
 * guidance for that element (we keep the row so an explicit empty
 * "no special guidance" decision survives).
 */
export async function saveInstructionsForElement(
  ownerUserId,
  elementType,
  instructions
) {
  if (!ownerUserId) throw new Error('ownerUserId required');
  if (!elementType) throw new Error('elementType required');
  const { error } = await withTimeout(
    supabase
      .from('liturgy_element_instructions')
      .upsert(
        {
          owner_user_id: ownerUserId,
          element_type: elementType,
          instructions: instructions || '',
        },
        { onConflict: 'owner_user_id,element_type' }
      )
  );
  if (error) throw error;
}

/**
 * Lazy spoiler-safe theme getter. Returns the cached sermons.liturgy_theme
 * if present; otherwise calls Claude to generate one, persists it, and
 * returns it. Pass a falsy sermon to skip (returns '').
 *
 * The caller is responsible for surfacing errors — this throws on any
 * Claude or DB failure.
 */
export async function ensureLiturgyTheme(sermon) {
  if (!sermon?.id) return '';
  if (sermon.liturgy_theme && sermon.liturgy_theme.trim()) {
    return sermon.liturgy_theme.trim();
  }
  if (!sermon.manuscript_text || !sermon.manuscript_text.trim()) {
    // No manuscript yet — can't summarize. Caller's UI should explain
    // this if relevant. Return empty so drafting still works with
    // scripture + element-instructions only.
    return '';
  }
  const theme = await generateLiturgyTheme({
    sermonTitle: sermon.title,
    scriptureReference: sermon.scripture_reference,
    manuscriptText: sermon.manuscript_text,
  });
  await withTimeout(
    supabase
      .from('sermons')
      .update({ liturgy_theme: theme })
      .eq('id', sermon.id)
  );
  return theme;
}

/**
 * Force-regenerate the theme (used by the "Refresh theme" button on
 * the draft modal — useful if the pastor revised the manuscript after
 * the cached theme was generated).
 */
export async function regenerateLiturgyTheme(sermon) {
  if (!sermon?.id) throw new Error('sermon required');
  if (!sermon.manuscript_text || !sermon.manuscript_text.trim()) {
    throw new Error(
      "Sermon manuscript is empty — write some manuscript first, then refresh the theme."
    );
  }
  const theme = await generateLiturgyTheme({
    sermonTitle: sermon.title,
    scriptureReference: sermon.scripture_reference,
    manuscriptText: sermon.manuscript_text,
  });
  await withTimeout(
    supabase
      .from('sermons')
      .update({ liturgy_theme: theme })
      .eq('id', sermon.id)
  );
  return theme;
}

/**
 * Resolve the "preferred linked sermon" for a given liturgy. Used by
 * the draft/brainstorm flow: pick the first approved sermon_liturgy_link
 * (highest confidence) and fetch its row including manuscript_text +
 * cached liturgy_theme. Returns null if no approved link exists.
 */
export async function loadLinkedSermonForLiturgy(liturgyId) {
  if (!liturgyId) return null;
  const { data: link, error: linkErr } = await withTimeout(
    supabase
      .from('sermon_liturgy_links')
      .select('sermon_id')
      .eq('liturgy_id', liturgyId)
      .eq('approved', true)
      .order('confidence', { ascending: true })
      .limit(1)
      .maybeSingle()
  );
  if (linkErr) throw linkErr;
  if (!link?.sermon_id) return null;
  const { data: sermon, error: sermonErr } = await withTimeout(
    supabase
      .from('sermons')
      .select(
        'id, title, scripture_reference, manuscript_text, liturgy_theme'
      )
      .eq('id', link.sermon_id)
      .maybeSingle()
  );
  if (sermonErr) throw sermonErr;
  return sermon || null;
}
