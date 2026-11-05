// Local stand-in database for end-to-end tests: PGlite + the test schema +
// the real 0076 migration + seed data, served on 127.0.0.1:5499.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { vector } from "@electric-sql/pglite-pgvector";
import { readdirSync } from "node:fs";

export const OWNER = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";
export const SERMON = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_SERMON = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const T_PAST = "e0000000-0000-4000-8000-000000000001";
export const T_ACTIVE = "e0000000-0000-4000-8000-000000000002";
export const T_NEXT = "e0000000-0000-4000-8000-000000000003";
export const T_Q1 = "e0000000-0000-4000-8000-000000000004";
export const T_Q2 = "e0000000-0000-4000-8000-000000000005";
export const BOOK = "f0000000-0000-4000-8000-000000000001";

const db = await PGlite.create();
await db.exec(readFileSync("tests/schema.sql", "utf8"));
await db.exec(readFileSync("db/0076_claude_connector.sql", "utf8"));
const manuscript = [
  "<SLIDE #1 – Room at the Table>",
  "Jesus noticed how the guests chose the places of honor.",
  "My grandmother kept a card table folded behind the pantry door. It came out every Thanksgiving.",
  "So who is missing from your table this week?",
].join("\n\n");
await db.exec(`
  insert into auth.users values ('${OWNER}'), ('${OTHER}');
  insert into sermons (id, owner_user_id, title, scripture_reference, theme, manuscript_text, preached_at)
    values ('${SERMON}', '${OWNER}', 'Room at the Table', 'Luke 14:7-14', 'hospitality', $m$${manuscript}$m$, '2023-08-27'),
           ('${OTHER_SERMON}', '${OTHER}', 'Wife''s sermon', 'Luke 14:1-6', 'sabbath', 'private', null);
  insert into preachings (sermon_id, owner_user_id, preached_at, location) values ('${SERMON}', '${OWNER}', '2023-08-27', 'Wedowee FUMC');
  insert into worship_plans (service_date, scripture_reference, liturgical_season, selected_sermon_id)
    values ('2099-11-08', 'Luke 14:7-14', 'Season after Pentecost', '${SERMON}'), ('2000-01-02', 'old', null, null);
  insert into workspace_slides (sermon_id, owner_user_id, sort_order, slide_type, title, body, anchor_paragraph_idx, anchor_paragraph_text) values
    ('${SERMON}', '${OWNER}', 0, 'title', 'Room at the Table', 'Luke 14:7-14', 0, '<SLIDE #1 – Room at the Table>'),
    ('${SERMON}', '${OWNER}', 1, 'scripture', 'Luke 14:10', 'But when you are invited, go and sit down at the lowest place.', 1, 'Jesus noticed how the guests chose the places of honor.'),
    ('${SERMON}', '${OWNER}', 2, 'content', 'Who is missing?', 'Who is missing from your table?', null, null);
  insert into resources (owner_user_id, resource_type, title, content, source, themes, scripture_refs) values
    ('${OWNER}', 'story', 'Card table', 'A folding card table for the extra guests.', 'Personal', '{hospitality,family}', 'Luke 14:12-14'),
    ('${OWNER}', 'quote', null, 'Hospitality is making room for the stranger.', 'Nouwen', '{hospitality}', 'Romans 12:13'),
    ('${OTHER}', 'story', 'Not mine', 'other user', null, '{hospitality}', 'Luke 14');
  insert into sermon_liturgies (id, owner_user_id, title, used_at, scripture_refs) values
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${OWNER}', 'Advent 1 2025', '2025-11-30', 'Isaiah 2:1-5');
  insert into sermon_liturgy_sections (liturgy_id, owner_user_id, section_kind, title, body, sort_order, is_announcement) values
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${OWNER}', 'call_to_worship', 'Call to Worship', 'Come, let us walk in the light of the Lord!', 0, false),
    ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '${OWNER}', 'announcements', 'Announcements', 'Bake sale', 1, true);
  insert into liturgy_element_instructions (owner_user_id, element_type, instructions) values ('${OWNER}', 'call_to_worship', 'Responsive, bold lines for the people.');
  insert into pastoral_voice_guides (id, owner_user_id, guide_text, word_count_target) values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '${OWNER}', 'Plain, warm, concrete.', 2200);
  insert into voice_exemplars (voice_guide_id, owner_user_id, sermon_id, note) values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '${OWNER}', '${SERMON}', 'Good story pacing');
`);
await db.exec(`
  insert into ss_members (id, owner_user_id, display_name, sort_key) values ('d1000000-0000-4000-8000-000000000001', '${OWNER}', 'Tyler', 'tyler');
  insert into ss_topics (id, owner_user_id, text, status, discussed_on, queue_sort, picked_by_member_id) values
    ('${T_PAST}', '${OWNER}', 'Is it okay to doubt?', 'past', '2026-10-25', 1, null),
    ('${T_ACTIVE}', '${OWNER}', 'What is heaven like?', 'active', '2026-11-01', 2, 'd1000000-0000-4000-8000-000000000001'),
    ('${T_NEXT}', '${OWNER}', 'Why do bad things happen to good people?', 'picked_for_next', null, 3, null),
    ('${T_Q1}', '${OWNER}', 'What does it mean to be saved?', 'possible_future', null, 10, null),
    ('${T_Q2}', '${OWNER}', 'Did Jesus have siblings?', 'possible_future', null, 20, null),
    ('e0000000-0000-4000-8000-0000000000ff', '${OTHER}', 'Other owner topic', 'picked_for_next', null, 1, null);
  insert into ss_lessons (owner_user_id, topic_id, opening_prompt, pastor_notes, closing_prompt) values
    ('${OWNER}', '${T_PAST}', 'Have you ever doubted?', '- Thomas doubted\n- Doubt is not the opposite of faith', 'What are your thoughts?');
  insert into ss_lessons (owner_user_id, topic_id, sections) values
    ('${OWNER}', '${T_ACTIVE}', '[{"header":"Opening Prompt","body":"Picture heaven."},{"header":"A few thoughts","body":"- Revelation 21\\n- N.T. Wright: life after life after death"}]');
  insert into ss_topic_suggestions (owner_user_id, text, submitter_name) values ('${OWNER}', 'What about the Nephilim?', 'Martha');
`);

// Colporteur library: its real migrations + seed data, on a second port.
const libdb = await PGlite.create({ extensions: { vector } });
const mdir = "/home/claude/colporteur-lib/db/migrations";
for (const f of readdirSync(mdir).sort()) await libdb.exec(readFileSync(`${mdir}/${f}`, "utf8").replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", ""));
await libdb.exec(`
  insert into books (id, title, author, year, format, file_key, file_hash, status, scripture_range, section_count, topics)
    values ('${BOOK}', 'Matthew for Everyone, Part 2', 'N. T. Wright', 2004, 'pdf', 'k', 'h', 'ready', 'Matthew 16-28', 220, '{commentary}'),
           ('f0000000-0000-4000-8000-000000000002', 'Half Uploaded', null, null, 'pdf', 'k2', 'h2', 'processing', null, null, '{}');
  insert into book_sections (id, book_id, kind, idx, text) values
    ('f1000000-0000-4000-8000-000000000001', '${BOOK}', 'page', 137, 'The parable of the bridesmaids is about readiness. Oil cannot be borrowed at the last minute.'),
    ('f1000000-0000-4000-8000-000000000002', '${BOOK}', 'page', 138, 'Keep awake, Jesus says, because the bridegroom comes at an hour you do not expect.');
  insert into chunks (book_id, section_id, idx, text) values
    ('${BOOK}', 'f1000000-0000-4000-8000-000000000001', 0, 'The parable of the bridesmaids is about readiness. Oil cannot be borrowed at the last minute.'),
    ('${BOOK}', 'f1000000-0000-4000-8000-000000000002', 1, 'Keep awake, Jesus says, because the bridegroom comes at an hour you do not expect.');
  insert into highlights (id, book_id, color, selected_text, anchor) values
    ('f2000000-0000-4000-8000-000000000001', '${BOOK}', 2, 'Oil cannot be borrowed at the last minute.', '{"page": 137}');
  insert into notes (book_id, highlight_id, body) values ('${BOOK}', 'f2000000-0000-4000-8000-000000000001', 'Use for Your Attention, Please!');
  insert into ai_extracts (book_id, kind, title, content, themes, scripture_refs, section_ref)
    values ('${BOOK}', 'quote', 'Readiness', 'Readiness is not anxiety; it is faithfulness in the ordinary.', '{readiness,waiting}', 'Matthew 25:1-13', 'p. 137'),
           ('${BOOK}', 'exegesis', 'Doubt', 'Thomas and honest doubt.', '{doubt}', 'John 20:24-29', 'p. 20');
`);
const libServer = new PGLiteSocketServer({ db: libdb, port: 5498, host: "127.0.0.1", maxConnections: 5 } as never);
await libServer.start();

const server = new PGLiteSocketServer({ db, port: 5499, host: "127.0.0.1", maxConnections: 5 } as never);
await server.start();
console.log("db ready on 5499");
