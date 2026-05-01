// Helpers for shared resource libraries.
//
// A library is a named collection (e.g., "Pastoral Resources") that
// multiple users can be members of. Resources can live in a library
// (visible to all members) or stay personal (library_id = null).

import { supabase, withTimeout } from './supabase';

/**
 * Fetch every library the current user is a member of, plus any they
 * created. Returns rows in the shape stored in resource_libraries.
 */
export async function listMyLibraries() {
  // We hit the table directly — RLS will filter to only those visible
  // to the current user (owner or member).
  const { data, error } = await withTimeout(
    supabase
      .from('resource_libraries')
      .select('id, name, description, created_by, created_at')
      .order('name', { ascending: true })
  );
  if (error) throw error;
  return data ?? [];
}

/**
 * Fetch members of a library, joined with auth metadata via the
 * find_user_id_by_email RPC's complement (we only show user_id; we
 * don't currently expose other users' emails). Returns the rows from
 * resource_library_members.
 */
export async function listLibraryMembers(libraryId) {
  const { data, error } = await withTimeout(
    supabase
      .from('resource_library_members')
      .select('library_id, user_id, added_at, added_by')
      .eq('library_id', libraryId)
      .order('added_at', { ascending: true })
  );
  if (error) throw error;
  return data ?? [];
}

/**
 * Create a new library. The creator is automatically added as the
 * first member.
 */
export async function createLibrary({ name, description }, userId) {
  if (!userId) throw new Error('Not signed in');
  if (!name?.trim()) throw new Error('Library name is required');

  const { data, error } = await withTimeout(
    supabase
      .from('resource_libraries')
      .insert({
        name: name.trim(),
        description: description?.trim() || null,
        created_by: userId,
      })
      .select()
      .single()
  );
  if (error) throw error;

  // Add creator as first member (RLS allows this because they're the
  // creator).
  const { error: memberErr } = await withTimeout(
    supabase
      .from('resource_library_members')
      .insert({
        library_id: data.id,
        user_id: userId,
        added_by: userId,
      })
  );
  if (memberErr) throw memberErr;

  return data;
}

/**
 * Add a member by email lookup. Returns { added: true, user_id } on
 * success, or throws an Error with a useful message.
 */
export async function addMemberByEmail(libraryId, email, addedByUserId) {
  if (!email?.trim()) throw new Error('Email is required');

  const { data: lookedUpId, error: rpcErr } = await withTimeout(
    supabase.rpc('find_user_id_by_email', { p_email: email.trim() })
  );
  if (rpcErr) throw rpcErr;
  if (!lookedUpId) {
    throw new Error(
      `No user found with that email. They need to sign in to the Sermon Archive at least once before they can be added.`
    );
  }

  const { error: insertErr } = await withTimeout(
    supabase
      .from('resource_library_members')
      .insert({
        library_id: libraryId,
        user_id: lookedUpId,
        added_by: addedByUserId,
      })
  );
  if (insertErr) {
    // Surface a friendlier message for "already a member"
    if (
      String(insertErr.message || insertErr).toLowerCase().includes('duplicate')
    ) {
      throw new Error('That user is already a member of this library.');
    }
    throw insertErr;
  }

  return { added: true, user_id: lookedUpId };
}

/**
 * Remove a member from a library.
 */
export async function removeMember(libraryId, userId) {
  const { error } = await withTimeout(
    supabase
      .from('resource_library_members')
      .delete()
      .eq('library_id', libraryId)
      .eq('user_id', userId)
  );
  if (error) throw error;
}
