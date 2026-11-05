// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import { applyEdits, centralToday, paragraphs, slideMarkers } from "../lib/tools/util";
import { seasonOf } from "../lib/tools/liturgies";

test("edits must match exactly once, all or nothing", () => {
  const t = "Grace is free. Grace is costly.";
  assert.equal(applyEdits(t, [{ find: "free.", replace: "a gift." }]), "Grace is a gift. Grace is costly.");
  assert.throws(() => applyEdits(t, [{ find: "Grace is", replace: "x" }]), /more than once/);
  assert.throws(() => applyEdits(t, [{ find: "free.", replace: "x" }, { find: "nope", replace: "y" }]), /isn't in the manuscript/);
});

test("paragraphs and slide markers match the app", () => {
  const m = "<SLIDE #1 – Title>\n\nOne.\n  \nTwo <SLIDE 2 - Cross>";
  assert.deepEqual(paragraphs(m), ["<SLIDE #1 – Title>", "One.", "Two <SLIDE 2 - Cross>"]);
  assert.deepEqual(slideMarkers(m).map((x) => [x.number, x.description, x.paragraph]), [[1, "Title", 0], [2, "Cross", 2]]);
});

test("liturgical seasons", () => {
  assert.equal(seasonOf("2025-11-30"), "advent"); // Advent 1, 2025
  assert.equal(seasonOf("2025-11-23"), "pentecost_ordinary"); // Christ the King
  assert.equal(seasonOf("2025-12-25"), "christmas");
  assert.equal(seasonOf("2026-01-04"), "christmas");
  assert.equal(seasonOf("2026-01-11"), "epiphany");
  assert.equal(seasonOf("2026-02-18"), "lent"); // Ash Wednesday 2026
  assert.equal(seasonOf("2026-03-29"), "holy_week"); // Palm Sunday
  assert.equal(seasonOf("2026-04-05"), "easter");
  assert.equal(seasonOf("2026-05-24"), "easter"); // Pentecost
  assert.equal(seasonOf("2026-05-31"), "pentecost_ordinary");
  assert.equal(seasonOf("2026-11-29"), "advent"); // Advent 1, 2026
});

test("today is computed in Central time", () => {
  assert.equal(centralToday(new Date("2026-11-08T04:30:00Z")), "2026-11-07");
  assert.equal(centralToday(new Date("2026-11-08T07:00:00Z")), "2026-11-08");
});
