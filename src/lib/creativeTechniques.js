// Creative technique library for the Sermon Creative Studio.
//
// This is Todd's twelve "sermon tips" documents (Process Guide, How to
// Exegete a Con-Text, BEING, Preparation, Scripture Reading, Content,
// Craft, Manuscript, Movement, Delivery, Follow Up, Post Writing
// Process) distilled into structured, machine-usable technique cards.
//
// Each card:
//   id        - stable identifier (stored on session messages so a turn
//               can cite which techniques it applied)
//   name      - short human label (shows on the card + in Claude output)
//   source    - which tip document it came from
//   category  - one of TECHNIQUE_CATEGORIES keys
//   modes     - which studio modes surface it: 'exegesis',
//               'illustration' (balanced mode draws from both pools)
//   recipe    - the actual working instruction handed to Claude.
//               Written as a directive, referencing "the text" (the
//               sermon's scripture) and "the sermon" (working
//               manuscript, when present).
//
// Deliberately a JS module, not a DB table: Todd edits his method by
// editing this file, it deploys with the app, and prompt-recipes stay
// version-controlled next to the code that uses them.

export const TECHNIQUE_CATEGORIES = {
  listening: 'Listening to the text',
  perspective: 'Perspective lenses',
  ideation: 'Idea generation',
  connection: 'Text ↔ world connections',
  story: 'Story & illustration craft',
  wordcraft: 'Wordcraft & turns of phrase',
  humor: 'Humor tools',
  structure: 'Sermon structure & form',
  focus: 'Focus & claim',
  critique: 'Checks & critique',
};

// Rotating epigraphs for the Studio header — Todd's own north stars.
export const STUDIO_EPIGRAPHS = [
  'Be free to abandon any and all preparation when an "ah-ha" moment strikes and just write. — Process Guide',
  'Pay attention. Then you\'ll be loaded. You are handed 100 great sermons all day long. — BEING',
  'Be a much more ruthless editor and much more careless artist. — BEING (via Christoph Niemann)',
  'Sin and sin boldly. In the early stages, all things are right. — BEING (via Lisa Thompson)',
  'Give simplicity on the far side of complexity. — CONTENT',
  'Titling is a spiritual art. — CONTENT (via Rob Bell)',
  'Where is the gospel hidden in surprising places? — BEING',
];

export const CREATIVE_TECHNIQUES = [
  // ================= LISTENING TO THE TEXT (doc 02) =================
  {
    id: 'paraphrase-compare',
    name: 'Paraphrase & compare',
    source: '02 — How to Exegete a Con-Text',
    category: 'listening',
    modes: ['exegesis'],
    recipe:
      'Paraphrase the text in plain contemporary speech, then lay the paraphrase against the original and interrogate the differences: what got omitted, what got emphasized, what resisted paraphrase entirely. The friction points are sermon seeds.',
  },
  {
    id: 'inhabit-characters',
    name: 'Inhabit the characters',
    source: '02 — How to Exegete a Con-Text',
    category: 'listening',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Step inside each character of the passage in turn — including bystanders, unnamed crowds, and off-stage characters. What does each one see, fear, want, and misunderstand? Which character is the congregation actually standing next to, whether they admit it or not?',
  },
  {
    id: 'little-words',
    name: 'The little words',
    source: '02 — How to Exegete a Con-Text',
    category: 'listening',
    modes: ['exegesis'],
    recipe:
      'Zoom in on the nitty-gritty details and the "little" words of the text — conjunctions, tenses, odd repetitions, funny or ironic omissions. Read between the lines. What meaning hides in what the text almost says?',
  },
  {
    id: 'find-the-conflict',
    name: 'Find the conflict',
    source: '02 — How to Exegete a Con-Text',
    category: 'listening',
    modes: ['exegesis'],
    recipe:
      'Name the conflict IN the text (between characters, claims, expectations) and the conflict BEHIND the text (what dispute or crisis made someone write this down?). Then ask which of those conflicts is alive in the congregation today.',
  },
  {
    id: 'before-after',
    name: 'Look next door',
    source: '02 — How to Exegete a Con-Text',
    category: 'listening',
    modes: ['exegesis'],
    recipe:
      'Examine what comes immediately before and after the passage, and reconsider where the reading should really begin and end. What changes if the fence moves a few verses? What is the lectionary hiding?',
  },
  {
    id: 'canon-purpose',
    name: 'Purpose in the canon',
    source: '02 — How to Exegete a Con-Text',
    category: 'listening',
    modes: ['exegesis'],
    recipe:
      'Ask what unique role this text plays where it sits — in its book, in the canon, in God\'s redemption of the world. Consider a fortiori moves ("from the lesser to the greater": it was… now it is…).',
  },
  {
    id: 'transplant-context',
    name: 'Transplant the con-text',
    source: '02 — How to Exegete a Con-Text',
    category: 'listening',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Re-read the text as if its original context were THIS congregation — this town, this sanctuary, this week\'s troubles. Who plays which role? What would the text be forced to mean here?',
  },
  {
    id: 'history-of-text',
    name: 'History in & of the text',
    source: '02 — How to Exegete a Con-Text',
    category: 'listening',
    modes: ['exegesis'],
    recipe:
      'Distinguish the history IN the text (what it narrates) from the history OF the text (how the church has read, used, and misused it across centuries — Wesley, the ancient commentators, reception history). Where does the history of interpretation itself become the sermon\'s tension?',
  },
  {
    id: 'genre-devices',
    name: 'Genre & literary devices',
    source: '02 — How to Exegete a Con-Text',
    category: 'listening',
    modes: ['exegesis'],
    recipe:
      'Name the genre and the literary machinery — structure, parallelism, hyperbole, chiasm, irony. Then ask: what is this FORM doing to the hearer that a summary of its content would lose?',
  },
  {
    id: 'theological-vocabulary',
    name: 'Theological vocabulary',
    source: '02 — How to Exegete a Con-Text',
    category: 'listening',
    modes: ['exegesis'],
    recipe:
      'Isolate the loaded theological terms in the passage. Recap what each one means HERE (not in general), how the text uses it against expectation, and which term the congregation thinks it understands but doesn\'t.',
  },

  // ================= PERSPECTIVE LENSES (doc 02 IV.g) ===============
  {
    id: 'lens-oppressed',
    name: 'Eyes of the oppressed',
    source: '02 — How to Exegete a Con-Text',
    category: 'perspective',
    modes: ['exegesis'],
    recipe:
      'Read the text through the eyes of historically oppressed peoples. Who in the passage has no power, no voice, no name? What does the text sound like from underneath?',
  },
  {
    id: 'lens-constituencies',
    name: 'Specific pews',
    source: '02 + 06 (CONTENT)',
    category: 'perspective',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Ask questions of the text on behalf of specific constituencies in the congregation — the grieving widow, the skeptical teenager, the exhausted caregiver, the businessman having a crisis of meaning, the child. How will each HEAR this sermon\'s claim? Where will each resist it?',
  },
  {
    id: 'lens-interfaith',
    name: 'Ecumenical / interfaith lens',
    source: '02 — How to Exegete a Con-Text',
    category: 'perspective',
    modes: ['exegesis'],
    recipe:
      'Read the text through an ecumenical or interfaith lens. What would a thoughtful Jewish, Catholic, or Muslim reader notice, cherish, or protest? What does that reveal that an in-house reading misses?',
  },
  {
    id: 'lens-self-differentiated',
    name: 'What do I really think?',
    source: '02 — How to Exegete a Con-Text',
    category: 'perspective',
    modes: ['exegesis'],
    recipe:
      'Take the self-differentiated view: set aside what the preacher is SUPPOSED to say about this text and articulate what the preacher actually thinks, doubts, and resists in it. Honest friction, honestly named, is a sermon engine.',
  },
  {
    id: 'lens-girardian',
    name: 'Girardian lens',
    source: '02 — How to Exegete a Con-Text',
    category: 'perspective',
    modes: ['exegesis'],
    recipe:
      'Apply a Girardian reading: where are mimetic desire, rivalry, contagion, and scapegoating at work in this text? Whom does the crowd need to expel, and how does God side with the victim?',
  },
  {
    id: 'lens-gods-perspective',
    name: "God's scavenger hunt",
    source: '06 — CONTENT',
    category: 'perspective',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Look at the situation from God\'s perspective: "I can\'t easily get to the politicians, so I\'m going on a scavenger hunt for people I can speak through." Who is God recruiting in this text — and in this congregation — and how reluctant are they?',
  },

  // ================= IDEATION (docs 04, 06) =========================
  {
    id: 'conclusion-first',
    name: 'Write the conclusion first',
    source: '06 — CONTENT',
    category: 'ideation',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Draft three candidate CONCLUSIONS before anything else — the final 90 seconds of the sermon. State each as what the congregation walks out carrying. Then work backward: what has to happen earlier for that ending to land?',
  },
  {
    id: 'risk-and-blessing',
    name: 'Risk & blessing',
    source: '06 — CONTENT',
    category: 'ideation',
    modes: ['exegesis'],
    recipe:
      'Concisely state both the RISK of the text\'s claim (possibly as a warning) and its BLESSING. If the claim costs nothing, it isn\'t the claim yet. Sharpen both edges.',
  },
  {
    id: 'topic-too-small',
    name: 'Is the topic too small?',
    source: '06 — CONTENT',
    category: 'ideation',
    modes: ['exegesis'],
    recipe:
      'Test whether the sermon topic is too small. What is the bigger thing this text is a case of? Zoom out until the stakes involve the nature of God, then zoom back in with those stakes attached. Also test the reverse (per Post Writing): would focusing on one smaller part of the scripture be stronger?',
  },
  {
    id: 'learn-feel-do',
    name: 'Learn / Feel / Do',
    source: '06 — CONTENT (Adam Hamilton)',
    category: 'ideation',
    modes: ['exegesis', 'illustration'],
    recipe:
      'A sermon should help people learn something, feel something, and do something. Propose concrete candidates for all three — the fact they didn\'t know, the emotion that must be touched, the one specific response they could make this week.',
  },
  {
    id: 'two-forms',
    name: "Hamilton's two doors",
    source: '04 — PREPARATION (Adam Hamilton)',
    category: 'ideation',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Sketch the sermon both ways: (1) Bible → exegete → apply → illustrate, and (2) Human Condition → exegete the felt need → Bible → sermon. The non-religious don\'t care about starting with the Bible. Which door serves THIS text and THIS week?',
  },
  {
    id: 'alternative-ending',
    name: 'Alternative ending',
    source: '06 — CONTENT (Lisa Thompson)',
    category: 'ideation',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Write an alternative ending for the passage — especially if it is a troublesome text. What if the story had gone otherwise? The gap between the ending we\'d write and the ending Scripture gives is usually where the gospel is.',
  },
  {
    id: 'so-what',
    name: 'So what?',
    source: '06 — CONTENT',
    category: 'ideation',
    modes: ['exegesis'],
    recipe:
      'Interrogate every promising idea with "So what?" — three times in a row. Keep answering until the answer touches an actual Tuesday in an actual life in this congregation, or discard the idea.',
  },
  {
    id: 'contrast-wants',
    name: 'What we want vs. what God wants',
    source: '06 — CONTENT (Craig Barnes)',
    category: 'ideation',
    modes: ['exegesis'],
    recipe:
      'Contrast what we want with what God wants in this text — the Craig Barnes move: "…Jesus doesn\'t like tombs." Find the place where the congregation\'s desire and God\'s desire pull in different directions, and name it in one arresting sentence.',
  },
  {
    id: 'oblique-strategies',
    name: 'Oblique strategy',
    source: '06 — CONTENT (via Eno/Schmidt)',
    category: 'ideation',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Apply an Oblique Strategies-style lateral move to the sermon problem: invert it ("what would the OPPOSITE sermon claim?"), remove the most important element, honor the error as hidden intention, ask "what would my closest friend do?", or use an old idea. State the move used, then follow it seriously.',
  },
  {
    id: 'shocking-restatement',
    name: 'Say it more shockingly',
    source: '06 — CONTENT',
    category: 'ideation',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Take the sermon\'s central claim and restate it five ways, each more shocking, concrete, or scandalous than the last — without becoming untrue. Stop one step before untrue; that\'s the keeper.',
  },
  {
    id: 'culture-word',
    name: 'A word from the Lord for this culture',
    source: '06 — CONTENT',
    category: 'ideation',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Ask: what in our culture RIGHT NOW needs a word from the Lord that this text supplies? Compare and contrast current events, local happenings, and cultural moods with the nature of God revealed in the passage.',
  },
  {
    id: 'embody-theology',
    name: 'Particular embodiments',
    source: '06 — CONTENT',
    category: 'ideation',
    modes: ['illustration'],
    recipe:
      'Envision particular embodiments of the larger theological truth: not "grace" but a specific person, at a specific kitchen table, at a specific hour, being surprised by it. Generate several candidate embodiments with ultra-specific detail.',
  },
  {
    id: 'story-in-gods-story',
    name: 'Their story in God\'s story',
    source: '06 — CONTENT',
    category: 'ideation',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Help people find THEIR story within God\'s story. Map the arc of the passage onto arcs the congregation is actually living (diagnosis, estrangement, waiting, homecoming). Where do their plot and the text\'s plot intersect?',
  },
  {
    id: 'title-art',
    name: 'Titling as spiritual art',
    source: '06 — CONTENT (Rob Bell) + 04',
    category: 'ideation',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Generate 8–12 candidate sermon titles that stimulate interest and attract attention: some plain-spoken, some sideways, some slightly dangerous. A great title is a promise about the sermon\'s tension, not its summary.',
  },

  // ================= TEXT ↔ WORLD CONNECTIONS =======================
  {
    id: 'gospel-surprising-places',
    name: 'Gospel in surprising places',
    source: '03 — BEING',
    category: 'connection',
    modes: ['illustration'],
    recipe:
      'Hunt for where the gospel of this text is hiding in surprising places: news items, pop culture, science, small-town life, kids\' logic, work worlds (farming, nursing, retail). You are handed 100 great sermons a day — surface the ones that carry THIS text\'s freight.',
  },
  {
    id: 'channel-a-preacher',
    name: 'Channel a preacher',
    source: '03 — BEING (preachers list)',
    category: 'connection',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Sketch how two or three very different preachers from the cloud of witnesses — e.g., Will Willimon, Nadia Bolz-Weber, Michael Curry, Anna Carter Florence, Otis Moss III, James Forbes, Rob Bell — would each angle this text. Not imitation: triangulation. What does each angle expose that the others miss?',
  },
  {
    id: 'ancient-via-modern',
    name: 'Explain the ancient with the modern',
    source: '07 — CRAFT',
    category: 'connection',
    modes: ['illustration'],
    recipe:
      'Explain the ancient world of the text using the furniture of the modern one (denarii via paychecks, city gates via the co-op bulletin board, patronage via small-town credit). Generate mappings that make the original hearers\' shock available to modern ears.',
  },
  {
    id: 'change-languages',
    name: 'Change languages',
    source: '07 — CRAFT',
    category: 'connection',
    modes: ['illustration'],
    recipe:
      'Translate the text\'s claim out of religious vocabulary entirely — into the language of business, sports, medicine, farming, or parenting — then translate it back. What survived the round trip is the actual claim; what got lost is what only worship can say.',
  },
  {
    id: 'vision-alignment',
    name: 'Advance the church\'s vision',
    source: '03 — BEING',
    category: 'connection',
    modes: ['illustration'],
    recipe:
      'Favor illustrations that advance, enhance, or support the church\'s vision, core values, and goals — or shade candidate stories in that direction. How does this text fund who THIS church is trying to become?',
  },

  // ================= STORY & ILLUSTRATION CRAFT =====================
  {
    id: 'ultra-detail',
    name: 'Ultra-detail',
    source: '06 — CONTENT',
    category: 'story',
    modes: ['illustration'],
    recipe:
      'Bring a story alive with ultra-detail: not "a man had a farm" but the brand of the tractor, the smell of the barn at 5 a.m., the exact phrase his father used. Be as specific as possible — specificity is believability.',
  },
  {
    id: 'violate-expectations',
    name: 'Violate expectations',
    source: '06 — CONTENT + 07 (Tell to Win)',
    category: 'story',
    modes: ['illustration'],
    recipe:
      'Build or select illustrations that violate expectations — the story turns where the listener didn\'t brace. Set up the pattern honestly, then break it in the direction of the text\'s claim.',
  },
  {
    id: 'desire-and-dread',
    name: 'Desire vs. dread',
    source: '07 — CRAFT (Tell to Win)',
    category: 'story',
    modes: ['illustration'],
    recipe:
      'Construct the story on the axis of desire and dread: a character the congregation can identify with (need not be a person — a tribe, a town, a building), what they long for, what they fear, the roadblocks, and the transformation. Show what\'s in it for the hearer; turn "me" into "we"; end with a call to action.',
  },
  {
    id: 'story-return',
    name: 'Come back to the story',
    source: '07 — CRAFT',
    category: 'story',
    modes: ['illustration'],
    recipe:
      'Design a story that can be RETURNED to: told early at surface level, then reopened later in the sermon at a deeper layer (and maybe once more at the end). What detail plants quietly in telling #1 and detonates in telling #2?',
  },
  {
    id: 'new-character',
    name: 'Insert a new character',
    source: '07 — CRAFT',
    category: 'story',
    modes: ['illustration'],
    recipe:
      'Insert an entirely new character into the Bible story — the innkeeper\'s teenage daughter, the guy who owned the colt, a stagehand watching from the wings — and retell the scene through their eyes. Invented framing, honest text.',
  },
  {
    id: 'significant-objects',
    name: 'Significant objects',
    source: '07 — CRAFT',
    category: 'story',
    modes: ['illustration'],
    recipe:
      'Import a significant object and let it carry meaning ("He retired his guitar into a black casket case."). What object could sit — literally or verbally — at the center of this sermon and accumulate weight each time it\'s touched?',
  },
  {
    id: 'underside-logic',
    name: 'The underside of the logic',
    source: '07 — CRAFT (Otis Moss III)',
    category: 'story',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Chase the necessary corollaries of the text\'s claims — the underside of the logic problem: "Jesus hung between two thugs… I know there is a thug in paradise." What startling conclusion follows necessarily from taking the text at its word?',
  },
  {
    id: 'scripture-reading-frame',
    name: 'Shade the reading itself',
    source: '05 — SCRIPTURE READING',
    category: 'story',
    modes: ['illustration'],
    recipe:
      'Treat the public reading as interpretation: propose inflections that shade the text, and consider a McLaren-style word replacement ("Representatives of Organized Religion" for "Pharisees"). Also consider a "little intro" before the reading that tunes the congregation\'s ears.',
  },

  // ================= WORDCRAFT ======================================
  {
    id: 'golden-phrases',
    name: 'Golden phrase hunt',
    source: '02 (running lists) + 03',
    category: 'wordcraft',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Mint candidate golden phrases: compressed, repeatable, slightly off-kilter sentences that could anchor the sermon ("a shepherd-shaped wolf"). Generate a dozen; most will die; two might be worth building a paragraph around.',
  },
  {
    id: 'colorful-ordinary',
    name: 'Colorful phrases for ordinary things',
    source: '07 — CRAFT',
    category: 'wordcraft',
    modes: ['illustration'],
    recipe:
      'Rename ordinary things in colorful ways ("sets up a refugee camp in my lumbar"; "my heart used to do CrossFit, now it does yoga"). Take the mundane items in this sermon\'s orbit and give each three unexpected renamings.',
  },
  {
    id: 'remix-aphorisms',
    name: 'Remix aphorisms',
    source: '07 — CRAFT',
    category: 'wordcraft',
    modes: ['illustration'],
    recipe:
      'Remix common aphorisms and stock religious phrases so they surprise again ("God-shaped hole" → "shepherd-shaped wolf"). List the clichés circling this sermon\'s theme and bend each one.',
  },
  {
    id: 'repetitive-litany',
    name: 'Litany & catch-phrase',
    source: '07 — CRAFT',
    category: 'wordcraft',
    modes: ['illustration'],
    recipe:
      'Draft a repetitive litany that tapers toward the specific, or a self-created catch-phrase the sermon can return to like a chorus. Where in the sermon\'s argument does repetition become revelation?',
  },
  {
    id: 'double-entendre',
    name: 'Double meanings',
    source: '07 — CRAFT (Minton Sparks)',
    category: 'wordcraft',
    modes: ['illustration'],
    recipe:
      'Hunt for phrases that carry two true meanings at once ("let herself go"). Which phrases in this sermon\'s neighborhood can be made to mean both the surface thing and the gospel thing?',
  },
  {
    id: 'sermon-wide-analogy',
    name: 'Sermon-wide analogy',
    source: '07 — CRAFT',
    category: 'wordcraft',
    modes: ['illustration'],
    recipe:
      'Propose a single governing analogy the whole sermon could live inside ("the shelf is bowing"), including how it opens, how it complicates in the middle, and how it resolves or shatters at the end. Also consider using imagery of what the congregation literally does each week as theological language.',
  },

  // ================= HUMOR ==========================================
  {
    id: 'backstory-invention',
    name: 'Backstory invention',
    source: '07 — CRAFT',
    category: 'humor',
    modes: ['illustration'],
    recipe:
      'Ask: what inserted HERE would be really funny if it had a backstory? Then build the most text-relevant backstory possible. Humor that carries doctrine earns its place; humor that doesn\'t gets cut later.',
  },
  {
    id: 'botch-stock-phrases',
    name: 'Botch a stock phrase',
    source: '07 — CRAFT',
    category: 'humor',
    modes: ['illustration'],
    recipe:
      'Intentionally botch stock phrases ("When Anne is away, the mice will get perms…"), take figurative jokes literally, or give an answer to the wrong question. Generate a handful tied to the sermon\'s subject matter.',
  },
  {
    id: 'begs-explanation',
    name: 'Explain the wrong detail',
    source: '07 — CRAFT',
    category: 'humor',
    modes: ['illustration'],
    recipe:
      'Say something that begs for explanation, then explain a minor unrelated detail instead ("…blank CDs, condoms, Jack Daniel\'s, and Coke." "Nice choice — the Coke was on sale."). Where can misdirected explanation puncture pomposity in this sermon?',
  },
  {
    id: 'humor-callback',
    name: 'Humor callback',
    source: '07 — CRAFT',
    category: 'humor',
    modes: ['illustration'],
    recipe:
      'Plant humor early that can be brought back later — the callback lands twice as hard and stitches the sermon together. Alternate profundity and humor; identify where the sermon needs the pressure release.',
  },

  // ================= STRUCTURE ======================================
  {
    id: 'golden-circle',
    name: 'WHY → HOW → WHAT',
    source: '06 + 07 (Simon Sinek)',
    category: 'structure',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Structure from WHY to HOW to WHAT. People are moved by what they believe, not by instructions. Draft the sermon\'s WHY in one sentence, and make sure nothing precedes it that belongs after it.',
  },
  {
    id: 'duarte-shape',
    name: 'What is / what could be',
    source: '07 — CRAFT (Nancy Duarte)',
    category: 'structure',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Shape the sermon as Duarte\'s alternation: "what is" vs. "what could be," back and forth, increasing in frequency toward the end, closing on the "new bliss" (poetic and dramatic). Map the text\'s own is/could-be poles first.',
  },
  {
    id: 'stock-forms',
    name: 'Try a stock form',
    source: '07 — CRAFT (Preaching, 2123)',
    category: 'structure',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Test the sermon against classic forms: What is it / what is it worth / how does one get it? · Explore, explain, apply · The problem, the solution · What it is not / what it is · Either–or · Both–and · Promise, fulfillment · Ambiguity, clarity · Not this, nor this, nor this — but THIS · The flashback · From the lesser to the greater. Propose the two best-fitting forms and outline the sermon in each.',
  },
  {
    id: 'scripture-form',
    name: 'Let the text shape the sermon',
    source: '07 — CRAFT',
    category: 'structure',
    modes: ['exegesis'],
    recipe:
      'Consider using the FORM of the scripture as the form of the sermon — a lament that laments, a parable that withholds its turn, a psalm of ascent that climbs. What would it mean for the congregation to undergo this text\'s shape, not just hear its content?',
  },
  {
    id: 'hero-journey',
    name: 'Hero\'s journey blocks',
    source: '07 — CRAFT (Duarte)',
    category: 'structure',
    modes: ['illustration'],
    recipe:
      'Frame the sermon (or its spine story) with journey blocks: ordinary world → call to adventure → refusal → meeting the mentor → crossing the threshold. Likeable hero, roadblocks, transformation. Who is the hero here — and it had better not be the preacher.',
  },
  {
    id: 'text-placement',
    name: 'Move the text',
    source: '07 — CRAFT',
    category: 'structure',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Experiment with WHERE the text enters the sermon — the opening, the middle (after the human situation is fully built), or circled back to twice. Sketch the sermon with the text arriving late: what tension does the delay create?',
  },
  {
    id: 'stock-structures-culture',
    name: 'Borrow a cultural structure',
    source: '07 — CRAFT',
    category: 'structure',
    modes: ['illustration'],
    recipe:
      'Borrow a "stock" structure from the culture — the blind taste test, the courtroom cross-examination, the before/after reveal, the product recall notice — and let the sermon inhabit it. Which cultural container would make this text\'s argument feel inevitable?',
  },

  // ================= FOCUS & CLAIM ==================================
  {
    id: 'claim-succinct',
    name: 'State the claim',
    source: '02 — How to Exegete a Con-Text',
    category: 'focus',
    modes: ['exegesis'],
    recipe:
      'State the claim of the text ON THE HEARERS as succinctly as possible — one sentence, second person, present tense. Produce five candidate claim-statements ranging from safe to unnervingly direct.',
  },
  {
    id: 'simple-focus',
    name: 'One simple focus',
    source: '06 — CONTENT',
    category: 'focus',
    modes: ['exegesis'],
    recipe:
      'Ensure there is ONE simple focus, oriented around the direction you want to lead the congregation. Name the focus, then list what currently competes with it — every competing idea is either fuel for another Sunday or a cut.',
  },
  {
    id: 'state-problem',
    name: 'Name the problem out loud',
    source: '06 — CONTENT',
    category: 'focus',
    modes: ['exegesis'],
    recipe:
      'Explicitly state the problems of the text or the culture — "Now, I have a problem here…" — rather than smoothing them over. Congregations trust preachers who name the difficulty before resolving it. What must be admitted about this text from the pulpit?',
  },

  // ================= CHECKS & CRITIQUE ==============================
  {
    id: 'succes-check',
    name: 'SUCCES analysis',
    source: '07 + 12 (Made to Stick)',
    category: 'critique',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Run a SUCCES analysis: Simple, Unexpected, Concrete, Credible, Emotional, Story. Score the current idea/draft on each axis, and prescribe the single highest-leverage fix per weak axis.',
  },
  {
    id: 'subtraction-process',
    name: 'Subtraction process',
    source: '12 — Post Writing Process',
    category: 'critique',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Apply the Subtraction Process: (1) cut the dull, dumb, or irrelevant; (2) isolate and immunize the high points; (3) cut what doesn\'t quickly support the claim; (4) flag what is disproportionately interesting to the preacher alone; (5) flag the ideas that seemed better than they turned out; (6) reconsider loaded words, especially as they affect marginalized people; (7) replace six-dollar academic words.',
  },
  {
    id: 'be-sure-to',
    name: '"Be sure to…" checklist',
    source: '12 — Post Writing Process',
    category: 'critique',
    modes: ['exegesis', 'illustration'],
    recipe:
      'Check the three ingredients that draw hearers: Does it teach one thing they didn\'t know? Does it inspire, encourage, or touch the heart at least once? Does it offer an invitation to respond in ONE concrete way? Identify which ingredient is missing and propose it.',
  },
  {
    id: 'dont-milk',
    name: 'Story warnings',
    source: '07 — CRAFT (warnings)',
    category: 'critique',
    modes: ['illustration'],
    recipe:
      'Audit the working illustrations against the warnings: don\'t alter perspective too frequently; don\'t milk all the emotion out of a story — let some remain; universalize personal experiences so the focus leaves the self quickly. Which current story breaks which rule?',
  },
];

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/**
 * Techniques appropriate to a studio mode. Balanced pulls everything;
 * the focused modes pull their own pool (cards can belong to both).
 */
export function techniquesForMode(mode) {
  if (mode === 'balanced') return CREATIVE_TECHNIQUES;
  return CREATIVE_TECHNIQUES.filter((t) => t.modes.includes(mode));
}

/**
 * Draw `n` random technique cards for a mode — the "Oblique Strategies"
 * move Todd's Content doc prescribes. No repeats within a draw.
 */
export function drawTechniqueCards(mode, n = 1) {
  const pool = [...techniquesForMode(mode)];
  const drawn = [];
  while (pool.length && drawn.length < n) {
    const i = Math.floor(Math.random() * pool.length);
    drawn.push(pool.splice(i, 1)[0]);
  }
  return drawn;
}

export function getTechniqueById(id) {
  return CREATIVE_TECHNIQUES.find((t) => t.id === id) || null;
}

/**
 * Format selected technique cards as a prompt block Claude can apply.
 */
export function buildTechniquesContext(techniques) {
  if (!Array.isArray(techniques) || techniques.length === 0) return '';
  const lines = [
    'Apply the following techniques from the pastor\'s own sermon-craft',
    'method. Cite each technique by name when your output uses it.',
    '',
  ];
  for (const t of techniques) {
    lines.push(`### ${t.name}  (${t.source})`);
    lines.push(t.recipe);
    lines.push('');
  }
  return lines.join('\n');
}

export function randomEpigraph() {
  return STUDIO_EPIGRAPHS[Math.floor(Math.random() * STUDIO_EPIGRAPHS.length)];
}
