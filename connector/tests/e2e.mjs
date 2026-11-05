// End-to-end: register → Allow page in a real browser → tokens → every tool.
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = "http://localhost:3030";
const SERMON = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SERMON = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const log = (...a) => console.log("✓", ...a);

async function post(path, body, headers = {}) {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
}

async function signIn({ write, password = "test-password-123" }) {
  const reg = await post("/api/mcp/oauth/register", { client_name: "Claude", redirect_uris: [REDIRECT] });
  assert.equal(reg.status, 201);
  const bad = await post("/api/mcp/oauth/register", { client_name: "x", redirect_uris: ["https://evil.com/cb"] });
  assert.equal(bad.status, 400);
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: reg.body.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "st8" });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let landed = null;
  await page.route("https://claude.ai/**", (route) => { landed = route.request().url(); route.fulfill({ body: "ok" }); });
  await page.goto(`${BASE}/authorize?${q}`);
  // wrong password first
  await page.fill("input[name=password]", "nope-nope-nope");
  await page.click("button:text-is('Allow')");
  await page.waitForSelector("text=That password isn't right.");
  if (!write) await page.uncheck("input[name=write]");
  await page.fill("input[name=password]", password);
  await page.click("button:text-is('Allow')");
  for (let i = 0; i < 50 && !landed; i++) await page.waitForTimeout(100);
  await browser.close();
  const u = new URL(landed);
  assert.equal(u.searchParams.get("state"), "st8");
  const code = u.searchParams.get("code");
  const tok = await fetch(BASE + "/api/mcp/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.body.client_id, redirect_uri: REDIRECT, code_verifier: verifier }) }).then((r) => r.json());
  assert.ok(tok.access_token?.startsWith("wsat_"), JSON.stringify(tok));
  // replaying the code fails and kills the grant
  return { tok, clientId: reg.body.client_id, code, verifier };
}

let id = 1;
function caller(token) {
  return async (name, args = {}) => {
    const r = await post("/api/mcp", { jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }, { authorization: `Bearer ${token}` });
    assert.equal(r.status, 200);
    const c = r.body.result.content[0].text;
    if (r.body.result.isError) return { error: c };
    return JSON.parse(c);
  };
}

// ── read-only connection ──
const ro = await signIn({ write: false });
log("read-only sign-in through the Allow page", ro.tok.scope);
let list = await post("/api/mcp", { jsonrpc: "2.0", id: 0, method: "tools/list" }, { authorization: `Bearer ${ro.tok.access_token}` });
const roNames = list.body.result.tools.map((t) => t.name);
assert.ok(!roNames.includes("update_manuscript"));
log("read-only tools:", roNames.length, roNames.join(", "));

// ── read + write ──
const rw = await signIn({ write: true });
assert.equal(rw.tok.scope, "read write");
const init = await post("/api/mcp", { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18" } }, { authorization: `Bearer ${rw.tok.access_token}` });
assert.ok(init.body.result.instructions.includes("Feedback first"));
list = await post("/api/mcp", { jsonrpc: "2.0", id: 0, method: "tools/list" }, { authorization: `Bearer ${rw.tok.access_token}` });
log("read+write tools:", list.body.result.tools.length);
const call = caller(rw.tok.access_token);

// refresh rotation
const ref = await fetch(BASE + "/api/mcp/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rw.tok.refresh_token, client_id: rw.clientId }) }).then((r) => r.json());
assert.ok(ref.access_token && ref.access_token !== rw.tok.access_token);
const old = await post("/api/mcp", { jsonrpc: "2.0", id: 0, method: "tools/list" }, { authorization: `Bearer ${rw.tok.access_token}` });
assert.equal(old.status, 401);
const c2 = caller(ref.access_token);
log("refresh rotates tokens; old access token rejected");

const up = await c2("get_upcoming_sundays", { weeks: 3 });
assert.equal(up.weeks[0].sermon.id, SERMON);
assert.equal(up.weeks.length, 1);
log("upcoming:", up.weeks[0].service_date, up.weeks[0].sermon.title, "slides", up.weeks[0].sermon.slide_count);

let ss = await c2("search_sermons", { scripture: "Luke 14" });
assert.deepEqual(ss.sermons.map((s) => s.id), [SERMON]);
ss = await c2("search_sermons", { q: "card table" });
assert.equal(ss.matched, 1);
ss = await c2("search_sermons", { location: "wedowee", preached_from: "2023-01-01" });
assert.equal(ss.matched, 1);
log("search_sermons scripture/q/location; other user's sermon never appears");

const other = await c2("get_sermon", { sermon_id: OTHER_SERMON });
assert.ok(other.error?.includes("No sermon"));
let s = await c2("get_sermon", { sermon_id: SERMON, numbered_paragraphs: true });
assert.ok(s.manuscript.startsWith("[¶0]"));
assert.equal(s.preachings[0].location, "Wedowee FUMC");
log("get_sermon:", s.word_count, "words, hash", s.manuscript_hash, "; other owner blocked");

// manuscript edit
const bad1 = await c2("update_manuscript", { sermon_id: SERMON, change_summary: "x", expected_manuscript_hash: s.manuscript_hash, edits: [{ find: "not in there", replace: "y" }] });
assert.ok(bad1.error.includes("isn't in the manuscript"));
const stale = await c2("update_manuscript", { sermon_id: SERMON, change_summary: "x", expected_manuscript_hash: "0000", edits: [{ find: "card table", replace: "y" }] });
assert.ok(stale.error.includes("changed since"));
const full = await c2("update_manuscript", { sermon_id: SERMON, change_summary: "x", new_manuscript: "abc" });
assert.ok(full.error.includes("expected_manuscript_hash"));
const ed = await c2("update_manuscript", { sermon_id: SERMON, change_summary: "Sharper closing question", expected_manuscript_hash: s.manuscript_hash,
  edits: [{ find: "So who is missing from your table this week?", replace: "So who is still missing from your table this week? Set one more place." }] });
assert.equal(ed.changed, true);
log("update_manuscript: bad find, stale hash and unhashed replace refused; edit saved, revision", ed.saved_previous_version_as);

const revs = await c2("list_revisions", { sermon_id: SERMON });
assert.ok(revs[0].label.startsWith("Before Claude: Sharper"));
const rev = await c2("get_revision", { revision_id: revs[0].id });
assert.ok(rev.manuscript.includes("So who is missing from your table this week?"));
log("Past Versions entry has the old text");

// details
const det = await c2("update_sermon_details", { sermon_id: SERMON, title: "A Place at the Table", theme: "hospitality; humility" });
s = await c2("get_sermon", { sermon_id: SERMON, include_manuscript: false });
assert.equal(s.title, "A Place at the Table");
assert.deepEqual(s.previous_titles, ["Room at the Table"]);
log("update_sermon_details keeps old title in previous_titles");

// slides
let sl = await c2("get_slides", {});
assert.equal(sl.slide_count, 3);
assert.equal(sl.slides[0].anchor.status, "exact");
assert.equal(sl.manuscript_slide_markers[0].number, 1);
const rm = await c2("set_slides", { sermon_id: SERMON, expected_slides_hash: sl.slides_hash, change_summary: "drop last", slides: [{ id: sl.slides[0].id }, { id: sl.slides[1].id }] });
assert.ok(rm.error.includes("confirm_removals"));
const set = await c2("set_slides", {
  sermon_id: SERMON, expected_slides_hash: sl.slides_hash, change_summary: "Reordered; new quote slide; tightened scripture",
  slides: [
    { id: sl.slides[0].id },
    { type: "quote", title: "Henri Nouwen", body: "Hospitality is making room for the stranger.", anchor_paragraph: 2 },
    { id: sl.slides[2].id, body: "Who is still missing?" },
    { id: sl.slides[1].id, body: "Go and sit down at the lowest place." },
  ],
});
assert.equal(set.added, 1);
assert.equal(set.slide_count, 4);
const staleSet = await c2("set_slides", { sermon_id: SERMON, expected_slides_hash: sl.slides_hash, change_summary: "x", slides: [] });
assert.ok(staleSet.error.includes("changed since"));
sl = await c2("get_slides", { sermon_id: SERMON });
assert.deepEqual(sl.slides.map((x) => x.type), ["title", "quote", "content", "scripture"]);
assert.equal(sl.slides[1].anchor.paragraph, 2);
const one = await c2("edit_slide", { slide_id: sl.slides[2].id, change_summary: "notes", notes: "pause here" });
assert.equal(one.slide_number, 3);
log("set_slides (reorder/add/edit, removal needs confirm, stale refused), edit_slide");

// resources
const rs = await c2("search_resources", {});
assert.equal(rs.total_in_library, 2);
assert.ok(rs.facets.themes.hospitality === 2);
const rl = await c2("search_resources", { scripture: "Luke 14:13", unused: true });
assert.equal(rl.matched, 1);
const cr = await c2("create_resource", { resource_type: "illustration", title: "Empty chair", content: "An empty chair at the reunion.", themes: ["Hospitality", "grief"], link_to_sermon_id: SERMON });
assert.ok(cr.resource_id && cr.linked_to_sermon);
const ur = await c2("update_resource", { resource_id: cr.resource_id, add_themes: ["memory"] });
const gr = await c2("get_resources", { ids: [cr.resource_id] });
assert.deepEqual(gr.resources[0].themes, ["hospitality", "grief", "memory"]);
assert.equal(gr.resources[0].used_in.length, 1);
const lk = await c2("link_resource_to_sermon", { resource_id: rl.resources[0].id, sermon_id: SERMON, used_notes: "intro" });
assert.equal(lk.linked, true);
log("resources: search/facets/scripture/unused, create+link, update themes, link");

// liturgies
const sl1 = await c2("search_liturgies", { season: "advent" });
assert.equal(sl1.matched, 1);
assert.deepEqual(sl1.liturgies[0].elements, ["call_to_worship"]);
const fe = await c2("find_liturgy_elements", { element: ["call_to_worship"], season: "advent" });
assert.ok(fe.sections[0].text.includes("light of the Lord"));
const ins = await c2("get_liturgy_instructions");
assert.ok(ins.todds_instructions.call_to_worship);
const cl = await c2("create_liturgy", { title: "Proper 17 draft", sermon_id: SERMON, sections: [
  { element: "call_to_worship", text: "One: There is room at the table.\nAll: We come as guests and friends." },
  { element: "benediction", text: "Go and set another place." } ] });
assert.equal(cl.sections, 2);
let lit = await c2("get_liturgy", { liturgy_id: cl.liturgy_id });
const ss2 = await c2("set_liturgy_sections", { liturgy_id: cl.liturgy_id, change_summary: "Added confession", sections: [
  { id: lit.sections[0].id }, { element: "confession", text: "We have saved the best seats for ourselves." }, { id: lit.sections[1].id } ] });
lit = await c2("get_liturgy", { liturgy_id: cl.liturgy_id });
assert.deepEqual(lit.sections.map((x) => x.element), ["call_to_worship", "confession", "benediction"]);
const ll = await c2("link_liturgy_to_sermon", { liturgy_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sermon_id: SERMON });
assert.equal(ll.linked, true);
log("liturgies: season search, element lookup, instructions, create, revise, link");

const vg = await c2("get_voice_guide");
assert.equal(vg.word_count_target, 2200);
log("voice guide");

// undo
let ch = await c2("list_recent_changes", {});
log("change log entries:", ch.length);
const undoSections = await c2("undo_change", { change_id: ss2.change_id });
lit = await c2("get_liturgy", { liturgy_id: cl.liturgy_id });
assert.deepEqual(lit.sections.map((x) => x.element), ["call_to_worship", "benediction"]);
// slides undo: editing after set_slides means undoing set_slides needs force
const blocked = await c2("undo_change", { change_id: set.change_id });
assert.ok(blocked.error.includes("force"));
await c2("undo_change", { change_id: one.change_id });
await c2("undo_change", { change_id: set.change_id });
sl = await c2("get_slides", { sermon_id: SERMON });
assert.deepEqual(sl.slides.map((x) => x.type), ["title", "scripture", "content"]);
assert.equal(sl.slides[1].body, "But when you are invited, go and sit down at the lowest place.");
// manuscript undo
const undoM = await c2("undo_change", { change_id: ed.change_id });
s = await c2("get_sermon", { sermon_id: SERMON });
assert.ok(s.manuscript.includes("So who is missing from your table this week?"));
const again = await c2("undo_change", { change_id: ed.change_id });
assert.ok(again.error.includes("Already undone"));
await c2("undo_change", { change_id: det.change_id });
await c2("undo_change", { change_id: cr.change_id });
await c2("undo_change", { change_id: cl.change_id });
const gone = await c2("get_resources", { ids: [cr.resource_id] });
assert.equal(gone.resources.length, 0);
log("undo: liturgy sections, slides (blocked until later edit undone), manuscript, details, created resource, created liturgy");

// lock
// (lock the sermon directly, as the app's Lock button does)
const pg = (await import("postgres")).default("postgresql://postgres:postgres@127.0.0.1:5499/postgres", { max: 1 });
await pg`update sermons set manuscript_locked = true where id = ${SERMON}`;
s = await c2("get_sermon", { sermon_id: SERMON });
const locked = await c2("update_manuscript", { sermon_id: SERMON, change_summary: "x", expected_manuscript_hash: s.manuscript_hash, edits: [{ find: "card table", replace: "folding table" }] });
assert.ok(locked.error.includes("locked"));
await pg`update sermons set manuscript_locked = false where id = ${SERMON}`;
log("locked manuscript refused");

// read-only token can't write even by name
const roCall = caller(ro.tok.access_token);
const roWrite = await post("/api/mcp", { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "update_manuscript", arguments: {} } }, { authorization: `Bearer ${ro.tok.access_token}` });
assert.ok(roWrite.body.error?.message.includes("Unknown tool"));
log("read-only connection cannot call write tools");

// code replay
const replay = await fetch(BASE + "/api/mcp/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: ro.code, client_id: ro.clientId, redirect_uri: REDIRECT, code_verifier: ro.verifier }) });
assert.equal(replay.status, 400);
const roAfter = await post("/api/mcp", { jsonrpc: "2.0", id: 0, method: "tools/list" }, { authorization: `Bearer ${ro.tok.access_token}` });
assert.equal(roAfter.status, 401);
log("replayed code refused and that connection revoked");
const changes = await pg`select kind, summary, undone_at is not null as undone from connector_changes order by created_at`;
console.log(changes.map((c) => `${c.undone ? "↺" : "•"} ${c.kind}: ${c.summary}`).join("\n"));
await pg.end();
console.log("\nALL PASSED");
