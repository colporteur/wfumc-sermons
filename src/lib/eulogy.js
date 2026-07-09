// Eulogy Mode — Phase 1 engine.
//
// A eulogy is a sermon row with is_eulogy = true (column exists since
// migration 0013), plus two working fields from migration 0071:
// deceased_name and eulogy_outline. Source material reuses
// sermon_background_docs (uploads, pasted text, obituary URLs — see
// lib/backgroundDocs.js), so everything collected also feeds the
// Creative Studio and, in Phase 2, the narrative writers.
//
// Phase 1 exports:
//   createEulogy            — insert the row, return it
//   updateEulogyFields      — save name / scripture / outline
//   buildPastoralRecordSource — the Records bridge: pull a person's
//                             directory profile + eulogy_notes into a
//                             'text' background doc
//   assembleLifeOutline     — Claude call: sources (+ pastor's edited
//                             outline as base) → detailed chronological
//                             life outline
//
// Phase 2 exports:
//   suggestEulogyScriptures — passages + rationales when no scripture
//                             has been chosen yet
//   writeLifeNarrative      — eulogy narrative from the pastor's
//                             (edited) life outline
//   writeScriptureNarrative — narrative connecting the life to the
//                             chosen scripture's themes

import { supabase, withTimeout } from './supabase';
import { callClaude } from './claude';
import { buildBackgroundDocsContext, addTextBackgroundDoc } from './backgroundDocs';

// ---------------------------------------------------------------------
// Row management
// ---------------------------------------------------------------------

export async function createEulogy({ ownerUserId }) {
  const { data, error } = await withTimeout(
    supabase
      .from('sermons')
      .insert({
        owner_user_id: ownerUserId,
        title: 'New eulogy',
        is_eulogy: true,
      })
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

/**
 * Save eulogy working fields. When the deceased's name changes and the
 * title is still the placeholder (or a previous auto-title), keep the
 * title in sync as "Eulogy — {name}".
 */
export async function updateEulogyFields(sermon, patch) {
  const update = { ...patch };
  if (
    typeof patch.deceased_name === 'string' &&
    patch.deceased_name.trim() &&
    (!sermon.title ||
      sermon.title === 'New eulogy' ||
      /^Eulogy — /.test(sermon.title))
  ) {
    update.title = `Eulogy — ${patch.deceased_name.trim()}`;
  }
  const { data, error } = await withTimeout(
    supabase
      .from('sermons')
      .update(update)
      .eq('id', sermon.id)
      .select('*')
      .single()
  );
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------------
// Pastoral Records bridge
// ---------------------------------------------------------------------

/**
 * Pull a person's Pastoral Records profile — directory facts, dates,
 * roles, obituary link, and (crucially) the pastor's running
 * eulogy_notes from the Records app's own eulogy tool — and save it as
 * a 'text' background doc on this eulogy. One toggleable source, no
 * re-uploading what's already on file.
 *
 * Deliberately EXCLUDED, same posture as Specific Pews: interaction
 * bodies, pastoral_notes, transcripts, core issues. If the pastor
 * wants that depth in a eulogy, the Records app's EulogyDraftModal is
 * the tool that consents section-by-section — its output lands in
 * eulogy_notes, which DOES flow through here.
 */
export async function buildPastoralRecordSource({ sermonId, ownerUserId, personId }) {
  const { data: p, error } = await withTimeout(
    supabase
      .from('pastoral_people')
      .select(
        'id, first_name, middle_name, last_name, preferred_name, birthdate, anniversary, city, state, church_roles, is_church_member, date_joined_church, baptism_status, baptism_date, is_deceased, death_date, obituary_url, eulogy_notes'
      )
      .eq('id', personId)
      .single()
  );
  if (error) throw error;

  const name = [p.preferred_name || p.first_name, p.middle_name, p.last_name]
    .filter(Boolean)
    .join(' ');
  const lines = [`Pastoral Records profile for ${name}`, ''];
  if (p.birthdate) lines.push(`Born: ${p.birthdate}`);
  if (p.is_deceased && p.death_date) lines.push(`Died: ${p.death_date}`);
  if (p.anniversary) lines.push(`Wedding anniversary: ${p.anniversary}`);
  if (p.city) lines.push(`Home: ${[p.city, p.state].filter(Boolean).join(', ')}`);
  if (p.is_church_member) {
    lines.push(
      `Church member${p.date_joined_church ? ` since ${p.date_joined_church}` : ''}`
    );
  }
  if (p.baptism_status === 'yes') {
    lines.push(`Baptized${p.baptism_date ? ` ${p.baptism_date}` : ''}`);
  }
  if (Array.isArray(p.church_roles) && p.church_roles.length) {
    lines.push(`Church roles: ${p.church_roles.join(', ')}`);
  }
  if (p.obituary_url) lines.push(`Obituary on file: ${p.obituary_url}`);
  if (p.eulogy_notes && p.eulogy_notes.trim()) {
    lines.push('');
    lines.push("Pastor's eulogy notes (from Pastoral Records):");
    lines.push(p.eulogy_notes.trim());
  }

  return addTextBackgroundDoc({
    sermonId,
    ownerUserId,
    title: `Pastoral Records — ${name}`,
    text: lines.join('\n'),
  });
}

// ---------------------------------------------------------------------
// Life outline assembly (AI action 1)
// ---------------------------------------------------------------------

function extractText(response) {
  const block = response?.content?.find((c) => c.type === 'text');
  return block?.text ?? '';
}

const OUTLINE_SYSTEM = [
  'You help a United Methodist pastor prepare a eulogy. Your job right',
  'now is ONLY the life outline: assemble a detailed, chronological',
  'account of the deceased\'s life from the source material provided —',
  'birth and family of origin, formative years, marriage and family,',
  'work and vocation, faith life and church involvement, passions and',
  'quirks and beloved stories, later years, death. Use headed sections',
  'with dash bullets under each. Note specific names, dates, and',
  'places wherever sources give them; flag conflicts between sources',
  'with "[sources differ: …]" and gaps worth asking the family about',
  'with "[ask family: …]". Include a final section "Threads" listing',
  '2-4 through-lines of the life a eulogy could be built around. Draw',
  'ONLY on the sources — never invent biographical facts. Output the',
  'outline alone: no preamble, no commentary.',
].join(' ');

/**
 * Assemble (or re-assemble) the life outline.
 *
 * If the pastor already has an edited outline, it rides along as the
 * working base and Claude is told to preserve its structure and hand
 * edits, folding in only genuinely new source material — regenerate
 * never clobbers.
 *
 * @returns {Promise<string>} the outline text
 */
export async function assembleLifeOutline({
  sermon,
  docs,
  existingOutline = '',
  model = null,
}) {
  const onDocs = (docs || []).filter((d) => d._on !== false);
  if (onDocs.length === 0 && !existingOutline.trim()) {
    throw new Error(
      'Add at least one source (upload, pasted notes, obituary URL, or the Pastoral Records profile) first.'
    );
  }
  const { textBlock, imageBlocks } = await buildBackgroundDocsContext(onDocs);

  const parts = [];
  parts.push(
    `# Eulogy subject\n${sermon.deceased_name || '(name not yet entered)'}`
  );
  if (sermon.scripture_reference) {
    parts.push(`Chosen scripture: ${sermon.scripture_reference}`);
  }
  if (textBlock) parts.push(textBlock);
  if (existingOutline.trim()) {
    parts.push(
      "# The pastor's current working outline (his edits are authoritative)\n" +
        'Preserve its structure and hand-written content. Fold in new or ' +
        'missing material from the sources; correct only clear factual ' +
        'conflicts, flagging them.\n\n' +
        existingOutline.trim()
    );
  }

  const contextText = parts.join('\n\n---\n\n');
  const instruction = existingOutline.trim()
    ? 'Update the working outline with the source material, preserving my edits.'
    : 'Assemble the detailed life outline from these sources.';

  const content =
    imageBlocks.length > 0
      ? [
          { type: 'text', text: contextText },
          ...imageBlocks,
          { type: 'text', text: instruction },
        ]
      : contextText + '\n\n---\n\n' + instruction;

  const response = await callClaude(
    {
      messages: [{ role: 'user', content }],
      system: OUTLINE_SYSTEM,
      max_tokens: 4000,
      ...(model ? { model } : {}),
    },
    { timeoutMs: 180000 }
  );
  const text = extractText(response).trim();
  if (!text) throw new Error('Claude returned an empty outline. Try again.');
  return text;
}

// ---------------------------------------------------------------------
// Scripture suggestions (AI action 2 — only when none chosen)
// ---------------------------------------------------------------------

const SUGGEST_SYSTEM = [
  'You help a United Methodist pastor choose scripture for a funeral',
  'or memorial service. Given the life outline and source material,',
  'suggest passages whose themes genuinely resonate with THIS life —',
  'not the stock funeral texts unless they truly fit (and if a stock',
  'text like Psalm 23 or John 14 fits, say why for this person',
  'specifically). Range across both testaments. Output STRICTLY as a',
  'numbered list, one passage per line, in the exact format:',
  '1. <Reference> — <one- or two-sentence rationale tied to the life>',
  'No preamble, no closing commentary. 6 to 8 suggestions.',
].join(' ');

/**
 * Suggest scripture passages for the eulogy. Returns
 * [{ reference, rationale }]; also returns the raw text as a fallback
 * for the UI in case parsing misses lines.
 */
export async function suggestEulogyScriptures({ sermon, docs, outline = '', model = null }) {
  const onDocs = (docs || []).filter((d) => d._on !== false);
  const { textBlock } = await buildBackgroundDocsContext(
    // Text sources only — vision pages add latency without moving the
    // needle on theme discernment when an outline exists.
    onDocs.filter((d) => ['pdf_text', 'text', 'url'].includes(d.kind))
  );
  const parts = [
    `# Eulogy subject\n${sermon.deceased_name || '(name not entered)'}`,
  ];
  if (outline.trim()) parts.push('# Life outline\n' + outline.trim());
  if (textBlock) parts.push(textBlock);
  if (!outline.trim() && !textBlock) {
    throw new Error('Add sources or assemble the life outline first — suggestions need something to resonate with.');
  }

  const response = await callClaude(
    {
      messages: [
        {
          role: 'user',
          content:
            parts.join('\n\n---\n\n') +
            '\n\n---\n\nSuggest scripture passages for this eulogy.',
        },
      ],
      system: SUGGEST_SYSTEM,
      max_tokens: 1200,
      ...(model ? { model } : {}),
    },
    { timeoutMs: 90000 }
  );
  const raw = extractText(response).trim();
  if (!raw) throw new Error('Claude returned no suggestions. Try again.');

  const suggestions = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*\d+[.)]\s*(.+?)\s+—\s+(.+)$/);
    if (m) suggestions.push({ reference: m[1].trim(), rationale: m[2].trim() });
  }
  return { suggestions, raw };
}

// ---------------------------------------------------------------------
// Narratives (AI actions 3 & 4)
// ---------------------------------------------------------------------

const NARRATIVE_COMMON = [
  'Register: a eulogy delivered by the pastor at the funeral or',
  'memorial service — warm, truthful, specific, unhurried; grief is',
  'honored, laughter is allowed, the person is neither canonized nor',
  'diminished. Oral style built for the ear: contractions, rhythm,',
  'short sentences where weight is needed. Use the deceased\'s name',
  'the way a pastor who knew them would. Draw ONLY on the outline and',
  'sources — never invent biographical facts; where the outline flags',
  '[ask family: …] or [sources differ: …], simply avoid that detail.',
  'Output ONLY the narrative itself — no title, no headings, no',
  'commentary before or after.',
].join(' ');

function buildNarrativeContext({ sermon, outline, docs }) {
  const parts = [
    `# Eulogy subject\n${sermon.deceased_name || '(name not entered)'}`,
  ];
  if (sermon.scripture_reference) {
    parts.push(`# Chosen scripture\n${sermon.scripture_reference}`);
  }
  parts.push(
    "# The pastor's life outline (authoritative — structure and facts)\n" +
      outline.trim()
  );
  return { parts };
}

async function runNarrative({ system, parts, docs, instruction, model }) {
  const onDocs = (docs || []).filter((d) => d._on !== false);
  const { textBlock, imageBlocks } = await buildBackgroundDocsContext(onDocs);
  if (textBlock) {
    parts.push(
      '# Supporting sources (color, quotes, texture — the outline rules on facts)\n' +
        textBlock
    );
  }
  const contextText = parts.join('\n\n---\n\n');
  const content =
    imageBlocks.length > 0
      ? [
          { type: 'text', text: contextText },
          ...imageBlocks,
          { type: 'text', text: instruction },
        ]
      : contextText + '\n\n---\n\n' + instruction;

  const response = await callClaude(
    {
      messages: [{ role: 'user', content }],
      system,
      max_tokens: 4000,
      ...(model ? { model } : {}),
    },
    { timeoutMs: 180000 }
  );
  const text = extractText(response).trim();
  if (!text) throw new Error('Claude returned an empty narrative. Try again.');
  return text;
}

/**
 * AI action 3: narrative telling of the life, from the pastor's
 * (edited) outline.
 */
export async function writeLifeNarrative({ sermon, outline, docs, voicePrompt = '', model = null }) {
  if (!outline || !outline.trim()) {
    throw new Error('Assemble (or write) the life outline first — the narrative is built from it.');
  }
  const system = [
    'You write a eulogy narrative for a United Methodist pastor,',
    'turning his detailed life outline into flowing prose that tells',
    'the story of the life — its chapters, its threads, its texture.',
    NARRATIVE_COMMON,
    voicePrompt ? "PASTOR'S VOICE GUIDE:\n" + voicePrompt : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const { parts } = buildNarrativeContext({ sermon, outline, docs });
  return runNarrative({
    system,
    parts,
    docs,
    instruction: 'Write the life narrative from the outline.',
    model,
  });
}

/**
 * AI action 4: narrative connecting the life to the chosen scripture's
 * themes, in a manner appropriate for a eulogy.
 */
export async function writeScriptureNarrative({ sermon, outline, docs, voicePrompt = '', model = null }) {
  if (!sermon.scripture_reference || !sermon.scripture_reference.trim()) {
    throw new Error('Choose a scripture first (enter one or use a suggestion).');
  }
  if (!outline || !outline.trim()) {
    throw new Error('Assemble (or write) the life outline first.');
  }
  const system = [
    'You write the scripture movement of a eulogy for a United',
    'Methodist pastor: prose that connects THIS life to the themes and',
    'content of the chosen scripture. Let the text and the life',
    'illuminate each other — the passage should sound like it was',
    'written with this person in mind, without forcing it. Gospel',
    'comfort is spoken honestly: resurrection hope, not platitudes.',
    NARRATIVE_COMMON,
    voicePrompt ? "PASTOR'S VOICE GUIDE:\n" + voicePrompt : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const { parts } = buildNarrativeContext({ sermon, outline, docs });
  return runNarrative({
    system,
    parts,
    docs,
    instruction:
      'Write the narrative that connects this life to the chosen scripture.',
    model,
  });
}
