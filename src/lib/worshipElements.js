// Canonical worship-element vocabulary used by the liturgy drafting
// surfaces. The internal `key` matches sermon_liturgy_sections.section_kind
// (the existing free-form column gets a stable set of values from here on).
//
// Grouped by liturgical movement so the on-demand picker can show
// elements in their natural worship-order rather than alphabetically.
//
// "Pastoral Prayer" is intentionally NOT its own key — Todd treats it
// as identical to a Congregational Prayer. The aliases map provides
// display flexibility ("Pastoral Prayer" is an acceptable label for
// the same element).

export const ELEMENT_GROUPS = [
  {
    label: 'Gathering',
    elements: [
      { key: 'prelude',          label: 'Prelude' },
      { key: 'announcements',    label: 'Announcements' },
      { key: 'welcome',          label: 'Welcome' },
      { key: 'call_to_worship',  label: 'Call to Worship' },
      { key: 'opening_hymn',     label: 'Opening Hymn' },
      { key: 'opening_prayer',   label: 'Invocation / Opening Prayer' },
    ],
  },
  {
    label: 'Word',
    elements: [
      { key: 'childrens_moment',     label: "Children's Moment" },
      { key: 'anthem',               label: 'Anthem / Special Music' },
      { key: 'scripture_reading',    label: 'Scripture Reading' },
      { key: 'sermon',               label: 'Sermon' },
      { key: 'hymn_of_response',     label: 'Hymn of Response' },
      { key: 'affirmation_of_faith', label: 'Affirmation of Faith / Creed' },
    ],
  },
  {
    label: 'Response',
    elements: [
      { key: 'congregational_prayer', label: 'Congregational Prayer' },
      { key: 'lords_prayer',          label: "The Lord's Prayer" },
      { key: 'confession',            label: 'Confession' },
      { key: 'words_of_assurance',    label: 'Words of Assurance' },
      { key: 'passing_of_peace',      label: 'Passing of the Peace' },
    ],
  },
  {
    label: 'Thanksgiving',
    elements: [
      { key: 'offering_statement', label: 'Offering Statement' },
      { key: 'offering_music',     label: 'Offering Music' },
      { key: 'doxology',           label: 'Doxology' },
      { key: 'communion',          label: 'Communion / Eucharist' },
    ],
  },
  {
    label: 'Sending',
    elements: [
      { key: 'closing_hymn',  label: 'Closing Hymn' },
      { key: 'benediction',   label: 'Benediction' },
      { key: 'postlude',      label: 'Postlude' },
    ],
  },
];

// Flat list — useful for label lookup and for the on-demand picker
// when grouping isn't needed.
export const ELEMENTS_FLAT = ELEMENT_GROUPS.flatMap((g) => g.elements);

// Display aliases — alternate user-facing labels that should resolve to
// the same canonical key. "Pastoral Prayer" is the big one (Todd uses
// "Pastoral Prayer" and "Congregational Prayer" interchangeably).
export const ELEMENT_LABEL_ALIASES = {
  congregational_prayer: ['Pastoral Prayer'],
};

// Default 6 elements for every new liturgy, in Todd's stated order
// (NOT liturgical-standard order — he prefers Call to Worship first).
export const DEFAULT_ELEMENT_KEYS = [
  'call_to_worship',
  'prelude',
  'announcements',
  'childrens_moment',
  'congregational_prayer',
  'offering_statement',
];

/**
 * Get the display label for an element key. Falls back to a
 * humanized version of the key if it's a legacy / unknown value
 * (the schema's section_kind is free-form, so older liturgies may
 * have values like 'opening_prayer' or 'confession_and_pardon' that
 * predate this canonical list).
 */
export function getElementLabel(key) {
  const found = ELEMENTS_FLAT.find((e) => e.key === key);
  if (found) return found.label;
  return (key || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || 'Element';
}

/**
 * Build the 6 default elements ready to insert into
 * sermon_liturgy_sections for a brand-new liturgy. Body is empty;
 * sort_order is 0..5 matching DEFAULT_ELEMENT_KEYS order.
 */
export function buildDefaultElements({ liturgyId, ownerUserId }) {
  return DEFAULT_ELEMENT_KEYS.map((key, idx) => ({
    liturgy_id: liturgyId,
    owner_user_id: ownerUserId,
    section_kind: key,
    title: getElementLabel(key),
    body: '',
    sort_order: idx,
    is_announcement: key === 'announcements',
  }));
}

/**
 * For the "Send to new liturgy" action — given the source element's
 * key, find the matching default slot in a freshly-created liturgy.
 * Returns the slot's sort_order if there's a match (so we can OVERWRITE
 * the empty default with the incoming element's content), or null if
 * the source element type isn't one of the defaults (caller should
 * append at the end instead).
 *
 * Example: copying a 'congregational_prayer' element → returns 4
 * (slot index in DEFAULT_ELEMENT_KEYS), so the destination's empty
 * Congregational Prayer slot gets replaced with the incoming body.
 */
export function matchingDefaultSlot(elementKey) {
  const idx = DEFAULT_ELEMENT_KEYS.indexOf(elementKey);
  return idx === -1 ? null : idx;
}

/**
 * Is this element type one of the worship elements where pulling
 * scripture sentences in via Insert Sentence makes obvious sense?
 * Currently returns true for every canonical element — Todd asked
 * for it everywhere. Kept as a function so we can scope it down
 * later without touching call sites.
 */
// eslint-disable-next-line no-unused-vars
export function supportsInsertSentence(_elementKey) {
  return true;
}
