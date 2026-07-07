// "Specific Pews" — Creative Studio Phase 4.
//
// Turns the Specific Pews technique (Exegete-a-Con-Text §IV.g.ii /
// CONTENT: "consider how the sermon will be heard by specific people")
// from a generic lens into the pastor's ACTUAL congregation: he picks
// real people from the Pastoral Records directory and their context
// rides along on Studio turns.
//
// Reads pastoral_people / pastoral_interactions directly — same shared
// Supabase project, both owner-scoped to the pastor, so nothing new is
// stored and no migration is needed.
//
// Detail tier (per the pastor's choice): PROFILE + RECENT SUMMARIES.
//   - profile: name, age, membership/visitor status, roles, town,
//     joined date, deceased flag
//   - the ~8 most recent pastoral interactions: type + date + summary
//     line ONLY. Interaction bodies, pastoral_notes, and the person's
//     free-form directory notes are deliberately EXCLUDED — raw
//     pastoral material stays in the Records app.
//
// Privacy posture (per the pastor's choice): prompts identify people
// fully so context is unambiguous, but Claude is hard-instructed (see
// creativeStudio.js) to use FIRST NAMES ONLY in replies — replies are
// what persist in sermon_creative_sessions — and to treat people as
// lenses, never as identifiable sermon material.

import { supabase, withTimeout } from './supabase';

const MAX_INTERACTIONS = 8;

export async function searchPeople(q, { limit = 10 } = {}) {
  const term = (q || '').trim().replace(/[%,()]/g, '');
  if (!term) return [];
  const needle = `%${term}%`;
  const { data, error } = await withTimeout(
    supabase
      .from('pastoral_people')
      .select(
        'id, first_name, middle_name, last_name, preferred_name, birthdate, anniversary, city, church_roles, is_church_member, date_joined_church, is_active_visitor, is_non_active_visitor, is_extended_family, is_deceased'
      )
      .or(
        `first_name.ilike.${needle},last_name.ilike.${needle},preferred_name.ilike.${needle}`
      )
      .order('last_name', { ascending: true, nullsFirst: false })
      .limit(limit)
  );
  if (error) throw error;
  return data || [];
}

export function personDisplayName(p) {
  const first = p.preferred_name || p.first_name;
  return [first, p.last_name].filter(Boolean).join(' ');
}

function ageFrom(birthdate) {
  if (!birthdate) return null;
  const b = new Date(birthdate);
  if (Number.isNaN(b.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const beforeBirthday =
    now.getMonth() < b.getMonth() ||
    (now.getMonth() === b.getMonth() && now.getDate() < b.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

function statusLine(p) {
  const bits = [];
  if (p.is_deceased) bits.push('deceased');
  if (p.is_church_member) {
    bits.push(
      p.date_joined_church
        ? `church member since ${p.date_joined_church}`
        : 'church member'
    );
  }
  if (p.is_active_visitor) bits.push('active visitor');
  if (p.is_non_active_visitor) bits.push('non-active visitor');
  if (p.is_extended_family) bits.push('extended family of the congregation');
  return bits.join(', ');
}

/**
 * Build the context block for one person: profile + recent interaction
 * summaries. Cached on the person object (`_ctxCache`) so repeated
 * turns in a Studio session don't re-query.
 */
export async function buildPersonContext(person) {
  if (person._ctxCache) return person._ctxCache;

  const { data: interactions, error } = await withTimeout(
    supabase
      .from('pastoral_interactions')
      .select('interaction_type, happened_at, summary')
      .eq('person_id', person.id)
      .order('happened_at', { ascending: false })
      .limit(MAX_INTERACTIONS)
  );
  if (error) throw error;

  const lines = [`## ${personDisplayName(person)}`];
  const facts = [];
  const age = ageFrom(person.birthdate);
  if (age !== null) facts.push(`age ${age}`);
  if (person.city) facts.push(person.city);
  const status = statusLine(person);
  if (status) facts.push(status);
  if (Array.isArray(person.church_roles) && person.church_roles.length) {
    facts.push(`roles: ${person.church_roles.join(', ')}`);
  }
  if (facts.length) lines.push(facts.join(' · '));

  const rows = interactions || [];
  if (rows.length) {
    lines.push('');
    lines.push('Recent pastoral contact (summaries only):');
    for (const it of rows) {
      const when = it.happened_at ? String(it.happened_at).slice(0, 10) : '?';
      const type = (it.interaction_type || 'contact').replace(/_/g, ' ');
      lines.push(`- ${when} — ${type}${it.summary ? `: ${it.summary}` : ''}`);
    }
  } else {
    lines.push('');
    lines.push('No pastoral interactions on file.');
  }

  person._ctxCache = lines.join('\n');
  return person._ctxCache;
}

/**
 * Build the combined Specific Pews block for all toggled-ON people.
 * Fetches are sequential-with-cache; a handful of people at solo-pastor
 * scale is a non-issue.
 */
export async function buildCongregationContext(people) {
  const on = (people || []).filter(Boolean);
  if (on.length === 0) return '';
  const blocks = [];
  for (const p of on) {
    try {
      blocks.push(await buildPersonContext(p));
    } catch (e) {
      blocks.push(
        `## ${personDisplayName(p)}\n[Couldn't load this person's context this turn: ${e.message}]`
      );
    }
  }
  return (
    '# Specific pews — real parishioners the pastor has switched ON\n' +
    'Hear every idea through their ears. (See the SPECIFIC PEWS rules in your instructions.)\n\n' +
    blocks.join('\n\n---\n\n')
  );
}
