// Local stand-in database for end-to-end tests: PGlite + the test schema +
// the real 0076 migration + seed data, served on 127.0.0.1:5499.
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export const OWNER = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";
export const SERMON = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const OTHER_SERMON = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
const server = new PGLiteSocketServer({ db, port: 5499, host: "127.0.0.1", maxConnections: 5 } as never);
await server.start();
console.log("db ready on 5499");
