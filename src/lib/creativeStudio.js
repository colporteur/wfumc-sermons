// Creative Studio engine — session persistence + the two Claude calls
// (Brainstorm and Draft), grounded in the pastor's own sermon-craft
// method (see lib/creativeTechniques.js).
//
// Design notes:
// - Sessions persist in sermon_creative_sessions (migration 0068) so
//   Tuesday's sparks survive to Thursday. Messages are a JSONB array;
//   we do read-modify-write on the whole array, which is fine at this
//   scale (see the migration header).
// - Brainstorm turns return PROVOCATIONS (numbered questions, angles,
//   sparks) — never sermon prose. Draft turns return manuscript-ready
//   copy in the pastor's voice, clean enough to insert directly.
// - Every turn is mode-aware (exegesis / illustration / balanced) and
//   may carry technique cards, library resources, and (Phase 2)
//   background documents. Each context source is toggleable per call —
//   the caller passes only what's switched on.

import { supabase, withTimeout } from './supabase';
import { callClaude } from './claude';
import { buildResourcesContext } from './workspaceResources';
import { buildTechniquesContext } from './creativeTechniques';

// ---------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------

export async function listCreativeSessions(sermonId, { includeArchived = false } = {}) {
  let q = supabase
    .from('sermon_creative_sessions')
    .select('*')
    .eq('sermon_id', sermonId)
    .order('updated_at', { ascending: false });
  if (!includeArchived) q = q.is('archived_at', null);
  const { data, error } = await withTimeout(q);
  if (error) throw error;
  return data || [];
}

export async function createCreativeSession({ sermonId, ownerUserId, mode = 'balanced', title = null }) {
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_creative_sessions')
      .insert({
        sermon_id: sermonId,
        owner_user_id: ownerUserId,
        mode,
        title:
          title ||
          `${modeLabel(mode)} — ${new Date().toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          })}`,
      })
      .select()
      .single()
  );
  if (error) throw error;
  return data;
}

export async function updateCreativeSession(id, patch) {
  const { data, error } = await withTimeout(
    supabase
      .from('sermon_creative_sessions')
      .update(patch)
      .eq('id', id)
      .select()
      .single()
  );
  if (error) throw error;
  return data;
}

export async function deleteCreativeSession(id) {
  const { error } = await withTimeout(
    supabase.from('sermon_creative_sessions').delete().eq('id', id)
  );
  if (error) throw error;
}

export function modeLabel(mode) {
  if (mode === 'exegesis') return 'Exegesis';
  if (mode === 'illustration') return 'Illustrations';
  return 'Balanced';
}

// ---------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------

// Keep the manuscript contribution to the prompt bounded. Head + tail
// so Claude sees both where the sermon opens and where it's headed.
const MANUSCRIPT_CAP = 24000;

function buildManuscriptBlock(manuscript) {
  const text = (manuscript || '').trim();
  if (!text) return '';
  if (text.length <= MANUSCRIPT_CAP) return text;
  const half = Math.floor(MANUSCRIPT_CAP / 2);
  return (
    text.slice(0, half) +
    '\n\n[… middle of manuscript truncated for prompt length …]\n\n' +
    text.slice(-half)
  );
}

const MODE_CHARTERS = {
  exegesis: [
    'MODE: EXEGESIS FOCUS. The pastor is working out how to interpret',
    'the selected scripture. Push on meaning: tensions in and behind the',
    'text, candidate claims on the hearers, perspective shifts, the',
    'little words, what the church has done with this text, what this',
    'congregation needs from it. Do NOT hunt for sermon illustrations',
    'in this mode unless one falls out of the interpretive work itself.',
  ].join(' '),
  illustration: [
    'MODE: ILLUSTRATION FOCUS. The pastor knows roughly where the sermon',
    'is going and needs material that will help him COMMUNICATE it:',
    'story seeds, analogies, images, humor angles, wordcraft, cultural',
    'connections, objects, callbacks. Everything you offer must serve',
    'the text\'s claim — illustration for its own sake gets cut.',
  ].join(' '),
  balanced: [
    'MODE: BALANCED. Interweave interpretive work and communicative',
    'material — let exegetical sparks suggest illustrations and let',
    'illustrative instincts drive you back into the text. Move freely',
    'between "what does this text claim?" and "how will that claim',
    'land in a pew?"',
  ].join(' '),
};

function buildStudioSystem({ mode, kind, voicePrompt }) {
  const parts = [];
  parts.push(
    [
      'You are the creative sparring partner in the Sermon Creative',
      'Studio — a brainstorming space used by a United Methodist pastor',
      'with twenty years of preaching behind him. You work INSIDE his',
      'own documented sermon-craft method; technique cards from that',
      'method may be included below, and everything you produce should',
      'feel like his method firing on all cylinders, not generic',
      'homiletics advice.',
    ].join(' ')
  );
  parts.push(MODE_CHARTERS[mode] || MODE_CHARTERS.balanced);
  parts.push(
    [
      'House rules, from the pastor\'s own documents: early-stage work',
      'should "sin boldly" — surprising, risky, specific ideas beat',
      'safe, vague ones; he is a "ruthless editor and careless artist,"',
      'so err toward abundance and let him cut. Be ultra-specific',
      '(detail is believability). Ground everything in the scripture at',
      'hand. Never pad, never flatter, never explain what a technique',
      'is — USE it.',
    ].join(' ')
  );

  if (kind === 'brainstorm') {
    parts.push(
      [
        'OUTPUT CONTRACT — BRAINSTORM: return a numbered list of',
        'provocations: pointed questions, angles, seeds, moves, and',
        'sparks the pastor can pick up and run with. Each item is 1–3',
        'sentences, concrete enough to act on. NO sermon prose, no',
        'drafted paragraphs, no summaries of the text. When an item',
        'applies a technique card, name it in brackets at the end,',
        'e.g. [Ultra-detail]. Aim for 8–14 items with real variety;',
        'if the pastor asked a narrower question, answer THAT.',
      ].join(' ')
    );
  } else {
    parts.push(
      [
        'OUTPUT CONTRACT — DRAFT: write manuscript-ready sermon copy',
        'that could be inserted into the working manuscript as-is:',
        'oral style, contractions, rhythm built for the ear. Return',
        'ONLY the draft copy — no preamble, no headings, no technique',
        'citations, no commentary before or after. Match the pastor\'s',
        'voice guide if one is provided. Default to a self-contained',
        'passage of 2–6 paragraphs unless the pastor asked for a',
        'different length or shape.',
      ].join(' ')
    );
    if (voicePrompt) {
      parts.push('PASTOR\'S VOICE GUIDE:\n' + voicePrompt);
    }
  }
  return parts.join('\n\n');
}

function buildContextMessage({ sermon, manuscript, resources, techniques, extraContext }) {
  const blocks = [];

  const meta = [];
  if (sermon?.title) meta.push(`Title: ${sermon.title}`);
  if (sermon?.scripture_reference) meta.push(`Scripture: ${sermon.scripture_reference}`);
  if (sermon?.theme) meta.push(`Theme: ${sermon.theme}`);
  blocks.push('# Sermon\n' + (meta.length ? meta.join('\n') : '(no metadata yet)'));

  const manuscriptBlock = buildManuscriptBlock(manuscript);
  if (manuscriptBlock) {
    blocks.push('# Working manuscript (context — do not rewrite it here)\n' + manuscriptBlock);
  }

  if (Array.isArray(resources) && resources.length > 0) {
    blocks.push(
      '# Library resources the pastor has switched ON for this turn\n' +
        buildResourcesContext(resources)
    );
  }

  const techniquesBlock = buildTechniquesContext(techniques || []);
  if (techniquesBlock) {
    blocks.push('# Technique cards in play\n' + techniquesBlock);
  }

  // Phase 2 slot: background documents (articles, commentary
  // snapshots) will be appended here by the caller as pre-built text
  // and/or image blocks.
  if (extraContext) {
    blocks.push(extraContext);
  }

  return blocks.join('\n\n---\n\n');
}

function extractText(response) {
  const block = response?.content?.find((c) => c.type === 'text');
  return block?.text ?? '';
}

// ---------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------

// How much prior conversation rides along on each call. Sessions can
// grow long; the tail is what matters for continuity.
const HISTORY_TURNS = 12;

/**
 * Run one Studio turn against Claude.
 *
 * @param {Object} input
 * @param {'brainstorm'|'draft'} input.kind
 * @param {'exegesis'|'illustration'|'balanced'} input.mode
 * @param {Object} input.sermon           sermon row (title, scripture_reference, theme)
 * @param {string} [input.manuscript]     working manuscript ('' to exclude)
 * @param {Array}  [input.resources]      toggled-ON resource rows
 * @param {Array}  [input.techniques]     toggled-ON technique cards
 * @param {string} [input.voicePrompt]    voice guide (draft turns)
 * @param {string} [input.extraContext]   pre-built extra context block
 *   (Phase 2: background docs text — see lib/backgroundDocs.js)
 * @param {Array}  [input.imageBlocks]    Anthropic image content blocks
 *   (Phase 2: background docs vision — commentary scans, images).
 *   Attached to the anchor context message so every turn in the thread
 *   can see them.
 * @param {Array}  [input.history]        prior session messages ({role, kind, content})
 * @param {string} input.instruction      what the pastor asked for this turn
 * @param {string|null} [input.model]     model id override (null = proxy default)
 * @returns {Promise<string>} Claude's text
 */
export async function runCreativeTurn({
  kind,
  mode,
  sermon,
  manuscript = '',
  resources = [],
  techniques = [],
  voicePrompt = '',
  extraContext = '',
  imageBlocks = [],
  history = [],
  instruction,
  model = null,
}) {
  const system = buildStudioSystem({ mode, kind, voicePrompt });
  const context = buildContextMessage({
    sermon,
    manuscript,
    resources,
    techniques,
    extraContext,
  });

  const messages = [];
  // Anchor turn: context + a synthetic acknowledgement, mirroring the
  // proposeResourceUsage pattern, so history stays clean user/assistant
  // alternation regardless of how many context blocks we carry. When
  // background-doc images ride along, the anchor becomes a multimodal
  // content array (text intro → images → closing text) — same shape
  // analyzeResourceWithImages uses through the claude-proxy.
  const closing =
    '\n\n---\n\nThat is the full working context. Wait for my instruction.';
  if (Array.isArray(imageBlocks) && imageBlocks.length > 0) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: context },
        ...imageBlocks,
        { type: 'text', text: closing.trim() },
      ],
    });
  } else {
    messages.push({
      role: 'user',
      content: context + closing,
    });
  }
  messages.push({ role: 'assistant', content: 'Ready.' });

  for (const m of history.slice(-HISTORY_TURNS)) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    }
  }

  messages.push({ role: 'user', content: instruction });

  const response = await callClaude(
    {
      messages,
      system,
      max_tokens: kind === 'draft' ? 3000 : 2000,
      ...(model ? { model } : {}),
    },
    // Brainstorms are quick; drafts on the big models can take a while.
    { timeoutMs: kind === 'draft' ? 150000 : 90000 }
  );
  const text = extractText(response).trim();
  if (!text) {
    throw new Error('Claude returned an empty response. Try again or adjust the instruction.');
  }
  return text;
}

/**
 * Append messages to a session (read current row first for freshness,
 * then write the merged array). Returns the updated session row.
 */
export async function appendSessionMessages(sessionId, newMessages) {
  const { data: current, error: readErr } = await withTimeout(
    supabase
      .from('sermon_creative_sessions')
      .select('messages')
      .eq('id', sessionId)
      .single()
  );
  if (readErr) throw readErr;
  const merged = [...(current?.messages || []), ...newMessages];
  return updateCreativeSession(sessionId, { messages: merged });
}
