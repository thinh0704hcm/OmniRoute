import assert from "node:assert/strict";
import test from "node:test";

import { normalizePublishedAt } from "../../open-sse/handlers/search/publishedAt.ts";

test("ISO 8601 passes through canonicalized", () => {
  assert.equal(normalizePublishedAt("2026-08-26T20:20:00.000Z"), "2026-08-26T20:20:00.000Z");
});

test("RFC 2822 and date-only strings normalize to ISO", () => {
  assert.equal(normalizePublishedAt("Wed, 26 Aug 2026 20:20:00 GMT"), "2026-08-26T20:20:00.000Z");
  const iso = normalizePublishedAt("2026-08-26");
  assert.ok(iso?.startsWith("2026-08-26"), `expected 2026-08-26 prefix, got ${iso}`);
});

test("bare numeric timezone offsets normalize before parsing", () => {
  assert.equal(normalizePublishedAt("2026-08-26T20:20:00+0200"), "2026-08-26T18:20:00.000Z");
});

test("millisecond epoch numbers normalize to ISO", () => {
  assert.equal(normalizePublishedAt(1787756400000), "2026-08-26T15:00:00.000Z");
});

test("garbage, empty, and non-positive values return null", () => {
  assert.equal(normalizePublishedAt("not a date"), null);
  assert.equal(normalizePublishedAt(""), null);
  assert.equal(normalizePublishedAt("   "), null);
  assert.equal(normalizePublishedAt(null), null);
  assert.equal(normalizePublishedAt(undefined), null);
  assert.equal(normalizePublishedAt(0), null);
  assert.equal(normalizePublishedAt(-5), null);
  assert.equal(normalizePublishedAt({}), null);
});
