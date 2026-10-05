/**
 * muse-code/search envelope shaping — the binary accepts ONLY
 * { query, results: [{ url, title, snippet, page_last_modified: <number> }] }.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  toEpochSecs,
  toMuseSearchEnvelope,
} from "../../src/app/api/v1/muse-code/search/envelope.ts";

const NOW = 1791200000;

test("toEpochSecs: ISO string becomes epoch seconds", () => {
  assert.equal(toEpochSecs("2026-10-05T12:00:00Z", NOW), 1791201600);
});

test("toEpochSecs: raw epochs (seconds or millis) pass through", () => {
  assert.equal(toEpochSecs(1791158400, NOW), 1791158400);
  assert.equal(toEpochSecs(1791158400000, NOW), 1791158400);
});

test("toEpochSecs: null/undefined/garbage fall back", () => {
  assert.equal(toEpochSecs(null, NOW), NOW);
  assert.equal(toEpochSecs(undefined, NOW), NOW);
  assert.equal(toEpochSecs("not-a-date", NOW), NOW);
  assert.equal(toEpochSecs("", NOW), NOW);
});

test("envelope: prefers published_at, falls back to retrieved_at, then now", () => {
  const env = toMuseSearchEnvelope(
    "q",
    [
      { url: "https://a.example/", published_at: "2026-10-05T12:00:00Z" },
      { url: "https://b.example/", citation: { retrieved_at: "2026-10-04T12:00:00Z" } },
      { url: "https://c.example/", published_at: null },
    ],
    5,
    NOW
  );
  assert.equal(env.query, "q");
  assert.equal(env.results.length, 3);
  assert.equal(env.results[0].page_last_modified, 1791201600);
  assert.equal(env.results[1].page_last_modified, 1791115200);
  assert.equal(env.results[2].page_last_modified, NOW);
  for (const r of env.results) {
    assert.equal(typeof r.page_last_modified, "number");
  }
});

test("envelope: url falls back to link, never missing", () => {
  const env = toMuseSearchEnvelope("q", [{ link: "https://d.example/" }, {}], 5, NOW);
  assert.equal(env.results[0].url, "https://d.example/");
  assert.equal(env.results[1].url, "");
});

test("envelope: clamps count to 1..10 and slices", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ url: `https://e.example/${i}` }));
  assert.equal(toMuseSearchEnvelope("q", items, 5, NOW).results.length, 5);
  assert.equal(toMuseSearchEnvelope("q", items, 99, NOW).results.length, 10);
  assert.equal(toMuseSearchEnvelope("q", items, 0, NOW).results.length, 5);
});
