// Image upload + display helpers for the resource library.
//
// Photo-type resources have an image stored in Supabase Storage and
// referenced by `image_path` on the resources row. We store under
// `<owner_user_id>/<resource_id>/<filename>` for organization, but the
// bucket is public-read so we just hand back the public URL for
// display.

import { supabase, withTimeout } from './supabase';

export const RESOURCE_BUCKET = 'resource-images';

/**
 * Upload an image to the resource-images bucket. Returns the storage
 * path (which we save on the resources row).
 */
export async function uploadResourceImage({ file, ownerUserId, resourceId }) {
  if (!file) throw new Error('No file selected');
  if (!ownerUserId) throw new Error('Missing owner');
  if (!resourceId) throw new Error('Missing resource id');

  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
  // Timestamp prevents collisions when re-uploading after edit.
  const path = `${ownerUserId}/${resourceId}/${Date.now()}.${ext}`;

  const { error } = await withTimeout(
    supabase.storage.from(RESOURCE_BUCKET).upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type || `image/${ext}`,
    }),
    60000
  );
  if (error) throw error;
  return path;
}

/**
 * Public URL for a stored image path. Returns null if no path.
 */
export function publicResourceImageUrl(path) {
  if (!path) return null;
  return supabase.storage
    .from(RESOURCE_BUCKET)
    .getPublicUrl(path).data.publicUrl;
}

/**
 * Best-effort delete of a stored image. Errors are logged but don't
 * throw — orphaning a storage object isn't fatal.
 */
export async function deleteResourceImage(path) {
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
