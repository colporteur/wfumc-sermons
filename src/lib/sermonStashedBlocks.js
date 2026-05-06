import { supabase, withTimeout } from './supabase';

// CRUD helpers for the sermon_stashed_blocks table.
//
// "Live" blocks have used_at = null. Marking a block as used soft-
// archives it (kept for history; hidden by default in the card).

// Fetch all blocks for a sermon. Pass { liveOnly: true } to filter
// out used blocks.
export async function fetchStashedBlocks(sermonId, { liveOnly = false } = {}) {
  if (!sermonId) return [];
  let q = supabase
    .from('sermon_stashed_blocks')
    .select('*')
    .eq('sermon_id', sermonId);
  if (liveOnly) q = q.is('used_at', null);
  q = q.order('created_at', { ascending: false });
  const { data, error } = await withTimeout(q);
  if (error) throw error;
  return data ?? [];
}

// Cheap query: { sermon_id → live count } for a single user. Powers
// any future "X stashed blocks waiting" badge on the sermon list.
export async function fetchStashedBlockLiveCountsByUser(userId) {
  if (!userId) return new Map();
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_stashed_blocks')
      .select('sermon_id')
      .eq('owner_user_id', userId)
      .is('used_at', null)
  );
  if (error) throw error;
  const out = new Map();
  for (const row of data ?? []) {
    out.set(row.sermon_id, (out.get(row.sermon_id) ?? 0) + 1);
  }
  return out;
}

export async function createStashedBlock({
  sermonId,
  ownerUserId,
  title,
  body,
  source,
  sourceResourceId,
  sourceScripture,
}) {
  if (!sermonId || !ownerUserId) throw new Error('Missing sermon or user');
  if (!body || !body.trim()) throw new Error('Block body is empty');
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_stashed_blocks')
      .insert({
        sermon_id: sermonId,
        owner_user_id: ownerUserId,
        title: title?.trim() || null,
        body: body.trim(),
        source: source?.trim() || null,
        source_resource_id: sourceResourceId || null,
        source_scripture: sourceScripture?.trim() || null,
      })
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

export async function updateStashedBlock(id, patch) {
  const writable = ['title', 'body', 'source', 'used_at'];
  const payload = {};
  for (const k of writable) {
    if (patch[k] === undefined) continue;
    if (k === 'title' || k === 'body' || k === 'source') {
      payload[k] = patch[k]?.trim?.() || (k === 'body' ? patch[k] : null);
    } else {
      payload[k] = patch[k];
    }
  }
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_stashed_blocks')
      .update(payload)
      .eq('id', id)
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

export async function deleteStashedBlock(id) {
  const { error } = await withTimeout(
    supabase.from('sermon_stashed_blocks').delete().eq('id', id)
  );
  if (error) throw error;
}

export async function markStashedBlockUsed(id) {
  return updateStashedBlock(id, { used_at: new Date().toISOString() });
}

export async function markStashedBlockUnused(id) {
  return updateStashedBlock(id, { used_at: null });
}

// --- Workspace handoff via sessionStorage ---------------------------
//
// When the Pair-with-Scripture flow lands on "Open in Workspace with
// block in chat", we need to pass the generated block from the modal
// to the workspace page. URL params would be ugly for a 500-word
// block; sessionStorage is cleaner. The workspace reads + clears the
// pending block on mount.

const PENDING_BLOCK_KEY = 'wfumc-workspace-pending-block:';

export function setPendingBlockForSermon(sermonId, payload) {
  if (!sermonId || !payload) return;
  try {
    sessionStorage.setItem(PENDING_BLOCK_KEY + sermonId, JSON.stringify(payload));
  } catch {
    /* full / disabled — non-fatal; user just won't see the pre-fill */
  }
}

export function consumePendingBlockForSermon(sermonId) {
  if (!sermonId) return null;
  try {
    const raw = sessionStorage.getItem(PENDING_BLOCK_KEY + sermonId);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_BLOCK_KEY + sermonId);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Render the chat composer instruction text we pre-fill when the user
// chose "Open in Workspace with block in chat." Pastor can edit before
// hitting Send.
export function buildPendingBlockInstruction(payload) {
  if (!payload || !payload.body) return '';
  const sourceLine = payload.source ? `\n\n(Source: ${payload.source})` : '';
  return (
    'I have a fresh block I\'d like to weave into the manuscript. ' +
    'Find a natural spot for it — be specific about where you put it ' +
    'and what came before/after to make it land. Trim or rephrase as ' +
    'needed to fit the existing voice.' +
    sourceLine +
    '\n\n--- BLOCK ---\n\n' +
    payload.body.trim()
  );
}
