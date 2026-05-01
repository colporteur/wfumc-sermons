// Image upload + gallery helpers for the resource library.
//
// Images live in the resource-images storage bucket and are tracked in
// the resource_images table (one row per image, with sort_order). Any
// resource type can have N images.

import { supabase, withTimeout } from './supabase';

export const RESOURCE_BUCKET = 'resource-images';

/**
 * SHA-256 hex digest of a file's bytes — used as content_hash for
 * idempotent re-imports.
 */
export async function fileHash(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * SHA-256 hex digest of a Uint8Array (for image bytes already decoded
 * from base64 during ENEX import).
 */
export async function bytesHash(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Upload a File or Blob to the resource-images bucket. Returns the
 * storage path.
 */
export async function uploadResourceImage({
  file,
  ownerUserId,
  resourceId,
  contentType,
}) {
  if (!file) throw new Error('No file selected');
  if (!ownerUserId) throw new Error('Missing owner');
  if (!resourceId) throw new Error('Missing resource id');

  // Pull an extension from the filename if present, otherwise from MIME.
  let ext = 'bin';
  const name = file.name || '';
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) {
    ext = name.slice(dot + 1).toLowerCase();
  } else if (file.type || contentType) {
    const m = (file.type || contentType).match(/\/([a-z0-9]+)$/i);
    if (m) ext = m[1] === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  }
  // Timestamp + random suffix to avoid collisions.
  const path = `${ownerUserId}/${resourceId}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.${ext}`;

  const { error } = await withTimeout(
    supabase.storage.from(RESOURCE_BUCKET).upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || contentType || `image/${ext}`,
    }),
    60000
  );
  if (error) throw error;
  return path;
}

/**
 * Public URL for a stored image path.
 */
export function publicResourceImageUrl(path) {
  if (!path) return null;
  return supabase.storage
    .from(RESOURCE_BUCKET)
    .getPublicUrl(path).data.publicUrl;
}

/**
 * List images for one resource, ordered by sort_order then created_at.
 */
export async function listResourceImages(resourceId) {
  const { data, error } = await withTimeout(
    supabase
      .from('resource_images')
      .select('*')
      .eq('resource_id', resourceId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true })
  );
  if (error) throw error;
  return data ?? [];
}

/**
 * Insert a resource_images row referencing an already-uploaded path.
 */
export async function attachImageRow({
  resourceId,
  ownerUserId,
  imagePath,
  sortOrder,
  caption,
  contentHash,
}) {
  const { data, error } = await withTimeout(
    supabase
      .from('resource_images')
      .insert({
        resource_id: resourceId,
        owner_user_id: ownerUserId,
        image_path: imagePath,
        sort_order: sortOrder ?? 0,
        caption: caption ?? null,
        content_hash: contentHash ?? null,
      })
      .select()
      .single()
  );
  if (error) throw error;
  return data;
}

/**
 * Convenience: upload a file AND insert the resource_images row.
 */
export async function addImageToResource({
  file,
  ownerUserId,
  resourceId,
  sortOrder,
  caption,
}) {
  const hash = await fileHash(file);
  const path = await uploadResourceImage({ file, ownerUserId, resourceId });
  return attachImageRow({
    resourceId,
    ownerUserId,
    imagePath: path,
    sortOrder,
    caption,
    contentHash: hash,
  });
}

/**
 * Delete a resource_images row AND its underlying storage object.
 */
export async function removeResourceImage(image) {
  const { error: dbErr } = await withTimeout(
    supabase.from('resource_images').delete().eq('id', image.id)
  );
  if (dbErr) throw dbErr;
  await deleteStorageObject(image.image_path);
}

/**
 * Best-effort delete of a stored image file. Errors are logged but
 * don't throw — orphaning a storage object isn't fatal.
 */
export async function deleteStorageObject(path) {
  if (!path) return;
  try {
    await withTimeout(
      supabase.storage.from(RESOURCE_BUCKET).remove([path]),
      15000
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('Failed to delete resource image', path, e);
  }
}

/**
 * Idempotent: insert a resource_images row only if the same content
 * hash isn't already present for this resource. Used by the import
 * flow when re-running a .enex file.
 *
 * Returns { skipped: true } if the image already existed, or the new
 * row otherwise.
 */
export async function attachImageIfNew({
  resourceId,
  ownerUserId,
  imagePath,
  sortOrder,
  caption,
  contentHash,
}) {
  if (contentHash) {
    const { data: existing } = await withTimeout(
      supabase
        .from('resource_images')
        .select('id')
        .eq('resource_id', resourceId)
        .eq('content_hash', contentHash)
        .maybeSingle()
    );
    if (existing) return { skipped: true, id: existing.id };
  }
  const row = await attachImageRow({
    resourceId,
    ownerUserId,
    imagePath,
    sortOrder,
    caption,
    contentHash,
  });
  return row;
}
