// Upload + reconciliation helpers for the finished slide deck (the
// JPGs the pastor exports from PowerPoint). Distinct from
// workspace_slides, which holds slide CONTENT, this module deals with
// the actual image artifacts and how they reconcile against
// <SLIDE> markers in the manuscript.

import { supabase, withTimeout } from './supabase';

export const SLIDE_DECK_BUCKET = 'sermon-slide-decks';

// --- Upload + storage ------------------------------------------------

export async function uploadSlideImageFile({
  file,
  ownerUserId,
  sermonId,
}) {
  if (!file) throw new Error('No file selected');
  if (!ownerUserId) throw new Error('Missing owner');
  if (!sermonId) throw new Error('Missing sermon id');

  let ext = 'jpg';
  const name = file.name || '';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    ext = name.slice(dot + 1).toLowerCase();
  } else if (file.type) {
    const m = file.type.match(/\/([a-z0-9]+)$/i);
    if (m) ext = m[1] === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  }
  const path = `${ownerUserId}/${sermonId}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.${ext}`;

  const { error } = await withTimeout(
    supabase.storage.from(SLIDE_DECK_BUCKET).upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || `image/${ext}`,
    }),
    60000
  );
  if (error) throw error;
  return path;
}

export function publicSlideImageUrl(path) {
  if (!path) return null;
  return supabase.storage
    .from(SLIDE_DECK_BUCKET)
    .getPublicUrl(path).data.publicUrl;
}

// --- DB CRUD --------------------------------------------------------

export async function fetchSlideImages(sermonId) {
  if (!sermonId) return [];
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_slide_images')
      .select('*')
      .eq('sermon_id', sermonId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
  );
  if (error) throw error;
  return data ?? [];
}

export async function insertSlideImageRow({
  sermonId,
  ownerUserId,
  sortOrder,
  imagePath,
  originalFilename,
  matchedMarkerNumber,
  matchedMarkerDescription,
  notes,
}) {
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_slide_images')
      .insert({
        sermon_id: sermonId,
        owner_user_id: ownerUserId,
        sort_order: sortOrder ?? 0,
        image_path: imagePath,
        original_filename: originalFilename ?? null,
        matched_marker_number: matchedMarkerNumber ?? null,
        matched_marker_description: matchedMarkerDescription ?? null,
        notes: notes ?? null,
      })
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

export async function updateSlideImage(id, patch) {
  const writable = [
    'sort_order',
    'matched_marker_number',
    'matched_marker_description',
    'notes',
    'original_filename',
  ];
  const payload = {};
  for (const k of writable) {
    if (patch[k] === undefined) continue;
    payload[k] = patch[k];
  }
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_slide_images')
      .update(payload)
      .eq('id', id)
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

export async function deleteSlideImage(image) {
  const { error: dbErr } = await withTimeout(
    supabase.from('sermon_slide_images').delete().eq('id', image.id)
  );
  if (dbErr) throw dbErr;
  // Best-effort storage cleanup — orphaning a file is not fatal.
  try {
    await withTimeout(
      supabase.storage.from(SLIDE_DECK_BUCKET).remove([image.image_path]),
      15000
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Failed to delete slide image file', image.image_path, e);
  }
}

// --- Bulk + auto-match ----------------------------------------------

// Convenience: upload N files in parallel and create matching DB rows.
// Auto-numbers sort_order from `startOrder`. Returns the created rows.
export async function uploadAndAttachSlideImages({
  files,
  sermonId,
  ownerUserId,
  startOrder = 0,
}) {
  if (!Array.isArray(files) || files.length === 0) return [];
  // Sort by filename so PowerPoint's "Slide1.JPG, Slide2.JPG, ..."
  // export ends up in slide order.
  const sorted = [...files].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { numeric: true })
  );

  const created = [];
  for (let i = 0; i < sorted.length; i++) {
    const file = sorted[i];
    const path = await uploadSlideImageFile({ file, ownerUserId, sermonId });
    const row = await insertSlideImageRow({
      sermonId,
      ownerUserId,
      sortOrder: startOrder + i,
      imagePath: path,
      originalFilename: file.name || null,
    });
    created.push(row);
  }
  return created;
}

// Auto-match algorithm: for each image (in sort_order), find the marker
// whose number matches. If none does, leave it unmatched. If multiple
// images claim the same marker, the LAST one wins (typical PowerPoint
// re-export scenario).
//
// Inputs:
//   images  — array of sermon_slide_images rows (any order)
//   markers — array of { number, description } from
//             findManuscriptSlideMarkers(), already sorted by number.
//
// Output:
//   { updates: [{ id, matched_marker_number, matched_marker_description }],
//     unmatchedImages: [...image rows that found no marker],
//     unmatchedMarkers: [...marker objects that found no image] }
//
// The caller persists the updates via updateSlideImage().
export function autoMatchByOrder(images, markers) {
  // Sort images by sort_order so we walk in deck-order.
  const sortedImages = [...images].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );
  const sortedMarkers = [...markers].sort(
    (a, b) => a.number - b.number
  );

  const updates = [];
  const unmatchedImages = [];
  const claimedMarkerNumbers = new Set();

  // Pair image i with marker i (1-based slide N matched to position i).
  // We don't strictly require the image's sort_order to equal a marker's
  // number — typical PowerPoint workflow exports N images and the
  // manuscript has N markers, both in the same order.
  for (let i = 0; i < sortedImages.length; i++) {
    const img = sortedImages[i];
    const marker = sortedMarkers[i];
    if (!marker) {
      unmatchedImages.push(img);
      continue;
    }
    updates.push({
      id: img.id,
      matched_marker_number: marker.number,
      matched_marker_description: marker.description,
    });
    claimedMarkerNumbers.add(marker.number);
  }
  const unmatchedMarkers = sortedMarkers.filter(
    (m) => !claimedMarkerNumbers.has(m.number)
  );

  return { updates, unmatchedImages, unmatchedMarkers };
}

// Persist a batch of match updates produced by autoMatchByOrder().
export async function applyAutoMatchUpdates(updates) {
  if (!Array.isArray(updates) || updates.length === 0) return;
  await Promise.all(
    updates.map((u) =>
      updateSlideImage(u.id, {
        matched_marker_number: u.matched_marker_number,
        matched_marker_description: u.matched_marker_description,
      })
    )
  );
}

// Reorder slide images (writes new sort_order values 0..N).
export async function reorderSlideImages(orderedIds) {
  await Promise.all(
    orderedIds.map((id, idx) =>
      updateSlideImage(id, { sort_order: idx })
    )
  );
}

// --- Reconciliation summary (used by the SermonList badge) ----------

// Cheap query: count of slide images per sermon, for the current user.
// Returns a Map<sermonId, count>.
export async function fetchSlideImageCountsByUser(userId) {
  if (!userId) return new Map();
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_slide_images')
      .select('sermon_id')
      .eq('owner_user_id', userId)
  );
  if (error) throw error;
  const out = new Map();
  for (const row of data ?? []) {
    out.set(row.sermon_id, (out.get(row.sermon_id) ?? 0) + 1);
  }
  return out;
}
