import assert from "node:assert/strict";
import test from "node:test";

import { backfillPublishedAt } from "../../open-sse/handlers/search/dateBackfill.ts";
import type { SearchResult } from "../../open-sse/handlers/search.ts";

function hit(url: string, published_at: string | null = null): SearchResult {
  return {
    title: "t",
    url,
    snippet: "s",
    position: 1,
    score: null,
    published_at,
    favicon_url: null,
    content: null,
    metadata: null,
    citation: { provider: "exa-search", retrieved_at: new Date().toISOString(), rank: 1 },
    provider_raw: null,
  };
}

const ARTICLE_HTML = `<html><head>
<meta property="article:published_time" content="2026-08-20T10:00:00Z" />
</head><body>story</body></html>`;

const JSONLD_HTML = `<html><head>
<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-08-21"}</script>
</head><body>story</body></html>`;

test("fills null dates from article:published_time", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } });
  try {
    const out = await backfillPublishedAt([hit("https://example.com/a")], {});
    assert.equal(out[0].published_at, "2026-08-20T10:00:00.000Z");
  } finally {
    globalThis.fetch = original;
  }
});

test("falls back to JSON-LD datePublished", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSONLD_HTML, { status: 200, headers: { "content-type": "text/html" } });
  try {
    const out = await backfillPublishedAt([hit("https://example.com/b")], {});
    assert.ok(out[0].published_at?.startsWith("2026-08-21"));
  } finally {
    globalThis.fetch = original;
  }
});

test("keeps existing dates and skips unparseable pages", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("<html><body>no dates</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };
  try {
    const out = await backfillPublishedAt(
      [
        hit("https://example.com/keep", "2026-01-01T00:00:00.000Z"),
        hit("https://example.com/empty"),
      ],
      {}
    );
    assert.equal(out[0].published_at, "2026-01-01T00:00:00.000Z");
    assert.equal(out[1].published_at, null);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("refuses metadata hosts and caps at five urls", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const hits = [
      hit("http://169.254.169.254/latest/meta-data/"),
      ...Array.from({ length: 6 }, (_, i) => hit(`https://example.com/${i}`)),
    ];
    const out = await backfillPublishedAt(hits, {});
    assert.equal(out[0].published_at, null);
    assert.ok(calls <= 5, `expected <=5 fetches, got ${calls}`);
  } finally {
    globalThis.fetch = original;
  }
});

test("aborted signal stops backfill", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } });
  try {
    const controller = new AbortController();
    controller.abort();
    const out = await backfillPublishedAt([hit("https://example.com/c")], {
      signal: controller.signal,
    });
    assert.equal(out[0].published_at, null);
  } finally {
    globalThis.fetch = original;
  }
});
