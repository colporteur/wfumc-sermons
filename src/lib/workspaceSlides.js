import { supabase, withTimeout } from './supabase';

// CRUD helpers for the workspace_slides table. Slides are owned by
// the parent sermon's owner; RLS scopes everything automatically.

export const SLIDE_TYPES = [
  { value: 'title',     label: 'Title' },
  { value: 'scripture', label: 'Scripture' },
  { value: 'quote',     label: 'Pull quote' },
  { value: 'image',     label: 'Image' },
  { value: 'content',   label: 'Content' },
  { value: 'blank',     label: 'Blank' },
];

export async function fetchSlides(sermonId) {
  if (!sermonId) return [];
  const { data, error } = await withTimeout(
    supabase
      .from('workspace_slides')
      .select('*')
      .eq('sermon_id', sermonId)
      .order('sort_order', { ascending: true })
  );
  if (error) throw error;
  return data ?? [];
}

export async function createSlide({
  sermonId,
  ownerUserId,
  sortOrder,
  slideType = 'content',
  title = '',
  body = '',
  notes = '',
  anchorParagraphText = null,
  anchorParagraphIdx = null,
  imageResourceId = null,
}) {
  if (!sermonId || !ownerUserId) throw new Error('Missing sermon or user');
  const { data, error } = await withTimeout(
    supabase
      .from('workspace_slides')
      .insert({
        sermon_id: sermonId,
        owner_user_id: ownerUserId,
        sort_order: sortOrder ?? 0,
        slide_type: slideType,
        title: title?.trim() || null,
        body: body?.trim() || null,
        notes: notes?.trim() || null,
        anchor_paragraph_text: anchorParagraphText || null,
        anchor_paragraph_idx:
          anchorParagraphIdx === null || anchorParagraphIdx === undefined
            ? null
            : Number(anchorParagraphIdx),
        image_resource_id: imageResourceId || null,
      })
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

export async function updateSlide(slideId, patch) {
  const writable = [
    'slide_type',
    'title',
    'body',
    'notes',
    'anchor_paragraph_text',
    'anchor_paragraph_idx',
    'image_resource_id',
    'sort_order',
  ];
  const payload = {};
  for (const k of writable) {
    if (patch[k] === undefined) continue;
    if (k === 'title' || k === 'body' || k === 'notes') {
      payload[k] = patch[k]?.trim?.() || null;
    } else if (k === 'anchor_paragraph_text') {
      payload[k] = patch[k] || null;
    } else if (k === 'anchor_paragraph_idx' || k === 'sort_order') {
      payload[k] =
        patch[k] === null || patch[k] === undefined ? null : Number(patch[k]);
    } else {
      payload[k] = patch[k];
    }
  }
  const { data, error } = await withTimeout(
    supabase
      .from('workspace_slides')
      .update(payload)
      .eq('id', slideId)
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

export async function deleteSlide(slideId) {
  const { error } = await withTimeout(
    supabase.from('workspace_slides').delete().eq('id', slideId)
  );
  if (error) throw error;
}

// Reorder slides by writing new sort_order values. Pass an array of
// slide IDs in the desired order; sort_orders are renumbered 0..N.
export async function reorderSlides(orderedIds) {
  await Promise.all(
    orderedIds.map((id, idx) =>
      withTimeout(
        supabase
          .from('workspace_slides')
          .update({ sort_order: idx })
          .eq('id', id)
      )
    )
  );
}

// Bulk-update the cached anchor_paragraph_idx for a list of slides
// after re-resolving them against the current manuscript paragraphs.
// Skipped silently for slides whose new idx matches the existing cache.
export async function syncAnchorIndices(updates) {
  // updates: [{ id, idx }]
  const filtered = updates.filter((u) => u && u.id);
  if (filtered.length === 0) return;
  await Promise.all(
    filtered.map((u) =>
      withTimeout(
        supabase
          .from('workspace_slides')
          .update({ anchor_paragraph_idx: u.idx })
          .eq('id', u.id)
      )
    )
  );
}
