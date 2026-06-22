// Operations on the sermon_liturgies family of tables — pure data
// helpers used by the new-liturgy create flow and the "Send to new
// liturgy" element action.

import { supabase, withTimeout } from './supabase';
import {
  buildDefaultElements,
  matchingDefaultSlot,
  getElementLabel,
} from './worshipElements';

/**
 * Create a new liturgy and seed it with the 6 default elements.
 * Returns the new liturgy id.
 *
 * Optional opts:
 *   - title       (default: "New liturgy")
 *   - used_at     (date string, optional)
 *   - scripture_refs (free-form text, optional)
 *   - sermonId    (creates an approved manual link to this sermon)
 */
export async function createLiturgyWithDefaults({
  ownerUserId,
  title = 'New liturgy',
  used_at = null,
  scripture_refs = null,
  sermonId = null,
}) {
  if (!ownerUserId) throw new Error('ownerUserId required');

  const { data: created, error: litErr } = await withTimeout(
    supabase
      .from('sermon_liturgies')
      .insert({
        owner_user_id: ownerUserId,
        title,
        used_at: used_at || null,
        scripture_refs: scripture_refs || null,
        raw_body: null,
      })
      .select('id')
      .single()
  );
  if (litErr) throw litErr;
  const liturgyId = created.id;

  const defaults = buildDefaultElements({ liturgyId, ownerUserId });
  const { error: secErr } = await withTimeout(
    supabase.from('sermon_liturgy_sections').insert(defaults)
  );
  if (secErr) throw secErr;

  if (sermonId) {
    const { error: linkErr } = await withTimeout(
      supabase.from('sermon_liturgy_links').insert({
        liturgy_id: liturgyId,
        sermon_id: sermonId,
        owner_user_id: ownerUserId,
        link_kind: 'manual',
        confidence: 'high',
        approved: true,
      })
    );
    if (linkErr) throw linkErr;
  }

  return liturgyId;
}

/**
 * "Send to new liturgy" — copies a single element into a fresh draft
 * liturgy that has the 6 defaults. If the source element's type matches
 * a default slot (e.g. congregational_prayer → slot 4), the matching
 * default's empty body is OVERWRITTEN with the incoming element's body.
 * Otherwise, the element is APPENDED at the end.
 *
 * Returns the new liturgy id (so the caller can navigate to it).
 */
export async function sendElementToNewLiturgy({
  ownerUserId,
  sourceElement,
  newTitle,
}) {
  if (!ownerUserId) throw new Error('ownerUserId required');
  if (!sourceElement) throw new Error('sourceElement required');

  const title =
    (newTitle && newTitle.trim()) ||
    `New liturgy — from ${getElementLabel(sourceElement.section_kind)}`;

  const liturgyId = await createLiturgyWithDefaults({
    ownerUserId,
    title,
  });

  // The defaults insert succeeded inside createLiturgyWithDefaults.
  // Re-read them to get their ids so we can target the matching slot
  // for overwrite (or learn the next sort_order for append).
  const { data: created, error: readErr } = await withTimeout(
    supabase
      .from('sermon_liturgy_sections')
      .select('id, section_kind, sort_order')
      .eq('liturgy_id', liturgyId)
      .order('sort_order', { ascending: true })
  );
  if (readErr) throw readErr;

  const slotIdx = matchingDefaultSlot(sourceElement.section_kind);
  const incomingBody = (sourceElement.body || '').trim();
  const incomingTitle =
    sourceElement.title || getElementLabel(sourceElement.section_kind);

  if (slotIdx !== null && created[slotIdx]) {
    // Overwrite the matching default's body.
    const target = created[slotIdx];
    const { error: updErr } = await withTimeout(
      supabase
        .from('sermon_liturgy_sections')
        .update({
          body: incomingBody,
          title: incomingTitle,
          // Preserve original section_kind — should match anyway.
          section_kind: sourceElement.section_kind,
        })
        .eq('id', target.id)
    );
    if (updErr) throw updErr;
  } else {
    // Append at the end with the next sort_order.
    const nextSort = (created[created.length - 1]?.sort_order ?? -1) + 1;
    const { error: insErr } = await withTimeout(
      supabase.from('sermon_liturgy_sections').insert({
        liturgy_id: liturgyId,
        owner_user_id: ownerUserId,
        section_kind: sourceElement.section_kind || 'other',
        title: incomingTitle,
        body: incomingBody,
        sort_order: nextSort,
        is_announcement: !!sourceElement.is_announcement,
      })
    );
    if (insErr) throw insErr;
  }

  return liturgyId;
}

/**
 * Append a new (empty) element of the given type to an existing
 * liturgy. Used by the "+ Add element" picker in LiturgyDetail.
 * Returns the inserted row.
 */
export async function addElementToLiturgy({
  liturgyId,
  ownerUserId,
  elementKey,
  currentSortMax,
}) {
  const nextSort = (currentSortMax ?? -1) + 1;
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_liturgy_sections')
      .insert({
        liturgy_id: liturgyId,
        owner_user_id: ownerUserId,
        section_kind: elementKey,
        title: getElementLabel(elementKey),
        body: '',
        sort_order: nextSort,
        is_announcement: elementKey === 'announcements',
      })
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

/**
 * Reorder helper — swap sort_order between two element rows. Called by
 * up/down arrow buttons in LiturgyElementRow.
 */
export async function swapElementOrder(elementA, elementB) {
  // Two-step: park A at -1 to avoid the unique-ish ordering
  // constraint conflict, swap, then restore.
  await withTimeout(
    supabase
      .from('sermon_liturgy_sections')
      .update({ sort_order: -1 })
      .eq('id', elementA.id)
  );
  await withTimeout(
    supabase
      .from('sermon_liturgy_sections')
      .update({ sort_order: elementA.sort_order })
      .eq('id', elementB.id)
  );
  await withTimeout(
    supabase
      .from('sermon_liturgy_sections')
      .update({ sort_order: elementB.sort_order })
      .eq('id', elementA.id)
  );
}
