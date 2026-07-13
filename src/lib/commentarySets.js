// Commentary sets — named groups of background-doc pages (migration
// 0074). Library-level and reusable: add "NIB — Romans" once, tag
// every page photo with it from the dropdown, and the pages travel as
// one ordered source.

import { supabase, withTimeout } from './supabase';

export async function listCommentarySets() {
  const { data, error } = await withTimeout(
    supabase
      .from('commentary_sets')
      .select('id, title, notes')
      .order('title', { ascending: true })
  );
  if (error) throw error;
  return data || [];
}

export async function createCommentarySet({ ownerUserId, title, notes = null }) {
  const t = (title || '').trim();
  if (!t) throw new Error('Set title is required.');
  const { data, error } = await withTimeout(
    supabase
      .from('commentary_sets')
      .insert({ owner_user_id: ownerUserId, title: t, notes })
      .select('id, title, notes')
      .single()
  );
  if (error) throw error;
  return data;
}

/**
 * Group a sermon's background docs for display: returns
 *   { singles: [doc], sets: [{ set_id, title, docs: [ordered] }] }
 * Docs must carry commentary_set info (see listBackgroundDocs' select).
 */
export function groupDocsBySets(docs) {
  const singles = [];
  const byId = new Map();
  for (const d of docs || []) {
    if (d.commentary_set_id) {
      if (!byId.has(d.commentary_set_id)) {
        byId.set(d.commentary_set_id, {
          set_id: d.commentary_set_id,
          title: d.commentary_sets?.title || 'Commentary set',
          docs: [],
        });
      }
      byId.get(d.commentary_set_id).docs.push(d);
    } else {
      singles.push(d);
    }
  }
  // Page order = upload order.
  for (const g of byId.values()) {
    g.docs.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }
  return { singles, sets: Array.from(byId.values()) };
}
