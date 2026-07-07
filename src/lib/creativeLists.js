// Running Lists for the Creative Studio (Phase 3).
//
// The list vocabulary comes from the pastor's "How to Exegete a
// Con-Text" document, §I.a ("Running lists"). Items live in
// sermon_creative_list_items (migration 0070); the vocabulary lives
// here so adding a list is a code edit, not a migration.

import { supabase, withTimeout } from './supabase';

export const RUNNING_LISTS = [
  {
    key: 'golden_phrases',
    label: 'Golden Phrases',
    hint: 'Compressed, repeatable, slightly off-kilter sentences worth building a paragraph around.',
  },
  {
    key: 'sticky_stories',
    label: 'Sticky Points & Stories',
    hint: 'Story seeds, images, and moments that refuse to be forgotten.',
  },
  {
    key: 'humor_log',
    label: 'Humor Log',
    hint: 'Jokes, botched aphorisms, backstory bits — humor that might carry doctrine.',
  },
  {
    key: 'titles',
    label: 'Title Candidates',
    hint: 'Titling is a spiritual art. Collect promises about the sermon\'s tension.',
  },
  {
    key: 'weaving_strands',
    label: 'Weaving Strands',
    hint: 'Threads that could run the length of the sermon and stitch it together.',
  },
  {
    key: 'distinctions',
    label: 'Distinctions',
    hint: 'This-not-that clarifications the sermon needs to draw.',
  },
  {
    key: 'reflection_questions',
    label: 'Reflection Questions',
    hint: 'Questions worth handing the congregation (or the liturgy).',
  },
  {
    key: 'movement',
    label: 'Movement & Transitions',
    hint: 'Connecting ideas — anything that could help the sermon travel.',
  },
];

export function listLabel(key) {
  return (
    RUNNING_LISTS.find((l) => l.key === key)?.label ||
    key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

// ---------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------

export async function fetchListItems(sermonId) {
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_creative_list_items')
      .select('*')
      .eq('sermon_id', sermonId)
      .order('created_at', { ascending: true })
  );
  if (error) throw error;
  return data || [];
}

export async function addListItem({ sermonId, ownerUserId, listKey, content, source = 'manual' }) {
  const body = (content || '').trim();
  if (!body) throw new Error('List item is empty.');
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_creative_list_items')
      .insert({
        sermon_id: sermonId,
        owner_user_id: ownerUserId,
        list_key: listKey,
        content: body,
        source,
      })
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

export async function toggleListItemUsed(item) {
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_creative_list_items')
      .update({ used_at: item.used_at ? null : new Date().toISOString() })
      .eq('id', item.id)
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

export async function deleteListItem(id) {
  const { error } = await withTimeout(
    supabase.from('sermon_creative_list_items').delete().eq('id', id)
  );
  if (error) throw error;
}

// ---------------------------------------------------------------------
// Prompt + weave helpers
// ---------------------------------------------------------------------

/**
 * Context block for Studio turns: the sermon's running lists, so
 * Claude builds on (rather than re-invents) what's already collected.
 */
export function buildListsContext(items) {
  const live = (items || []).filter((i) => !i.used_at);
  if (live.length === 0) return '';
  const byList = new Map();
  for (const item of live) {
    if (!byList.has(item.list_key)) byList.set(item.list_key, []);
    byList.get(item.list_key).push(item.content);
  }
  const lines = [
    "# The pastor's running lists for this sermon",
    'Already-collected working material. Build on these — extend them,',
    'combine them, push them further. Do not repeat them back as if new.',
    '',
  ];
  for (const [key, contents] of byList) {
    lines.push(`## ${listLabel(key)}`);
    for (const c of contents) lines.push(`- ${c}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Instruction handed to the Workspace revision chat when the pastor
 * clicks "Weave into manuscript" on a list.
 */
export function buildWeaveInstruction(listKey, items) {
  const live = items.filter((i) => i.list_key === listKey && !i.used_at);
  if (live.length === 0) return '';
  const lines = [
    `Weave the following ${listLabel(listKey).toLowerCase()} into the manuscript where they genuinely fit — don't force ones that don't:`,
    '',
  ];
  for (const item of live) lines.push(`- ${item.content}`);
  return lines.join('\n');
}

/**
 * Split an assistant brainstorm message into fileable items.
 * Brainstorms are numbered lists by contract; fall back to non-empty
 * lines when numbering isn't detected (e.g., critique output).
 */
export function splitBrainstormItems(content) {
  const text = (content || '').trim();
  if (!text) return [];
  const numbered = text
    .split(/\n(?=\s*\d+[.)]\s)/)
    .map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
  if (numbered.length > 1) return numbered;
  return text
    .split('\n')
    .map((s) => s.replace(/^[-•]\s*/, '').trim())
    .filter((s) => s.length > 0);
}
