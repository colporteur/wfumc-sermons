import { supabase, withTimeout } from './supabase';

// Helpers for the pastoral_voice_guides + voice_exemplars tables.
//
// Two-tier model:
//   - One pastoral_voice_guides row per user (UNIQUE owner_user_id).
//     Contains the prose voice guide + a soft word-count target.
//   - Zero or more voice_exemplars per guide, each pointing at a past
//     sermon whose manuscript Claude reads as a voice sample.
//
// The settings page edits both. The Sermon Workspace consumes both via
// loadVoiceGuideForPrompt(), which returns everything bundled together
// in the shape Claude wants.

// --- guide CRUD --------------------------------------------------------

// Fetch the single guide row for the current user. If none exists yet,
// we DON'T auto-create one — the settings page handles first-write
// itself via upsert. Returns null when there's no row yet.
export async function fetchVoiceGuide(userId) {
  if (!userId) return null;
  const { data, error } = await withTimeout(
    supabase
      .from('pastoral_voice_guides')
      .select('*')
      .eq('owner_user_id', userId)
      .maybeSingle()
  );
  if (error) throw error;
  return data ?? null;
}

// Upsert the guide (insert if missing, update if present). Returns the
// resulting row.
export async function saveVoiceGuide(userId, { guide_text, word_count_target }) {
  if (!userId) throw new Error('No user');
  const payload = {
    owner_user_id: userId,
    guide_text: guide_text ?? '',
    word_count_target:
      word_count_target == null || word_count_target === ''
        ? null
        : Number(word_count_target),
  };
  const { data, error } = await withTimeout(
    supabase
      .from('pastoral_voice_guides')
      .upsert(payload, { onConflict: 'owner_user_id' })
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

// --- exemplar CRUD ----------------------------------------------------

// Fetch all exemplars for the given guide, ordered, with the joined
// sermon row (id, title, scripture_reference, manuscript_text).
export async function fetchExemplars(guideId) {
  if (!guideId) return [];
  const { data, error } = await withTimeout(
    supabase
      .from('voice_exemplars')
      .select(
        'id, sort_order, note, sermon:sermons(id, title, scripture_reference, manuscript_text)'
      )
      .eq('voice_guide_id', guideId)
      .order('sort_order', { ascending: true })
  );
  if (error) throw error;
  return data ?? [];
}

export async function addExemplar({ guideId, ownerUserId, sermonId, note }) {
  // Append to the end by giving it the next sort_order.
  const existing = await fetchExemplars(guideId);
  const nextOrder = existing.length
    ? Math.max(...existing.map((e) => e.sort_order ?? 0)) + 1
    : 0;
  const { data, error } = await withTimeout(
    supabase
      .from('voice_exemplars')
      .insert({
        voice_guide_id: guideId,
        owner_user_id: ownerUserId,
        sermon_id: sermonId,
        sort_order: nextOrder,
        note: note?.trim() || null,
      })
      .select(
        'id, sort_order, note, sermon:sermons(id, title, scripture_reference, manuscript_text)'
      )
      .single()
  );
  if (error) throw error;
  return data;
}

export async function removeExemplar(exemplarId) {
  const { error } = await withTimeout(
    supabase.from('voice_exemplars').delete().eq('id', exemplarId)
  );
  if (error) throw error;
}

export async function updateExemplarNote(exemplarId, note) {
  const { data, error } = await withTimeout(
    supabase
      .from('voice_exemplars')
      .update({ note: note?.trim() || null })
      .eq('id', exemplarId)
      .select(
        'id, sort_order, note, sermon:sermons(id, title, scripture_reference, manuscript_text)'
      )
      .single()
  );
  if (error) throw error;
  return data;
}

// Reorder exemplars by writing their new sort_order. Pass an array of
// exemplar IDs in the desired order.
export async function reorderExemplars(orderedIds) {
  // Issue updates in parallel; small list (typically 2–4 rows).
  await Promise.all(
    orderedIds.map((id, idx) =>
      withTimeout(
        supabase
          .from('voice_exemplars')
          .update({ sort_order: idx })
          .eq('id', id)
      )
    )
  );
}

// --- prompt assembly --------------------------------------------------

// One-shot loader for the workspace. Returns:
//   { guide: <row>|null, exemplars: [{sermon, note}], systemPrompt: string }
//
// systemPrompt is the rendered text the workspace will splice into
// every Claude call. Empty if the user hasn't set anything up yet.
export async function loadVoiceGuideForPrompt(userId) {
  if (!userId) {
    return { guide: null, exemplars: [], systemPrompt: '' };
  }
  const guide = await fetchVoiceGuide(userId);
  const exemplars = guide ? await fetchExemplars(guide.id) : [];

  const parts = [];
  if (guide?.guide_text?.trim()) {
    parts.push(
      `# Pastoral Voice Guide\n\nThe following describes how this pastor writes. Match this voice — vocabulary, sentence rhythm, theological framing, characteristic moves. Do not editorialize about the voice; just write in it.\n\n${guide.guide_text.trim()}`
    );
  }
  if (guide?.word_count_target) {
    parts.push(
      `\n# Length\n\nAim for approximately ${guide.word_count_target} words. Slight variation is fine; don't pad or truncate to hit the number exactly.`
    );
  }
  const usableExemplars = exemplars.filter(
    (e) => e.sermon?.manuscript_text?.trim()
  );
  if (usableExemplars.length > 0) {
    const samples = usableExemplars
      .map((e, i) => {
        const title = e.sermon?.title || `Exemplar ${i + 1}`;
        const ref = e.sermon?.scripture_reference
          ? ` (${e.sermon.scripture_reference})`
          : '';
        const noteLine = e.note ? `\nNote: ${e.note}` : '';
        return `## Exemplar ${i + 1}: ${title}${ref}${noteLine}\n\n${e.sermon.manuscript_text.trim()}`;
      })
      .join('\n\n---\n\n');
    parts.push(
      `\n# Voice Exemplars\n\nThese are past sermons by this pastor. Use them as the primary source of truth for voice and rhythm. Do not copy phrasings or content from them; learn how the writer sounds and write fresh prose in that same voice.\n\n${samples}`
    );
  }

  return {
    guide,
    exemplars,
    systemPrompt: parts.join('\n\n'),
  };
}
