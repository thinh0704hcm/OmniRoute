/**
 * Unit tests for src/lib/artificialAnalysisSync.ts
 *
 * Uses Node.js native test runner. All external fetch calls are mocked.
 * DB functions use a real in-memory SQLite instance via the core module's
 * globalThis.__omnirouteDb singleton (same harness as arena-elo-sync.test.ts).
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-aa-sync-test-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const MIGRATION_SQL = fs.readFileSync(
  path.resolve(
    import.meta.dirname ?? __dirname,
    "../../src/lib/db/migrations/097_model_intelligence.sql"
  ),
  "utf8"
);

import { tryOpenSync } from "../../src/lib/db/adapters/driverFactory";
import type { SqliteAdapter } from "../../src/lib/db/adapters/types";

const core = await import("../../src/lib/db/core.ts");

const {
  normalizeAaModelKeys,
  transformToModelIntelligence,
  fetchAaModels,
  syncArtificialAnalysis,
  initArtificialAnalysisSync,
  stopArtificialAnalysisSync,
  getArtificialAnalysisSyncStatus,
} = await import("../../src/lib/artificialAnalysisSync.ts");

const { getAaBenchmarkScore } = await import("../../src/lib/db/modelIntelligence.ts");

import type { AaModelEntry } from "../../src/lib/artificialAnalysisSync.ts";

const originalFetch = globalThis.fetch;

function mockFetch(impl: (url: string, opts?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = impl as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAaModel(overrides: Partial<AaModelEntry> = {}): AaModelEntry {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "GPT-5.5",
    slug: "gpt-5-5",
    evaluations: {
      artificial_analysis_intelligence_index: 50,
      artificial_analysis_coding_index: 40,
      artificial_analysis_math_index: 30,
    },
    median_output_tokens_per_second: 100,
    ...overrides,
  };
}

let testAdapter: SqliteAdapter;

function createTestAdapter(): SqliteAdapter {
  const patchedSql = MIGRATION_SQL.replace(
    /\n\s*synced_at TEXT NOT NULL DEFAULT \(datetime\('now'\)\)/,
    "\n  synced_at TEXT NOT NULL"
  );
  const adapter = tryOpenSync(":memory:")!;
  adapter.exec(`
    CREATE TABLE IF NOT EXISTS key_value (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    );
  `);
  adapter.exec(patchedSql);
  return adapter;
}

function countAaEntries(): number {
  const row = testAdapter
    .prepare("SELECT COUNT(*) as cnt FROM model_intelligence WHERE source = 'artificial_analysis'")
    .get() as Record<string, unknown> | undefined;
  return Number(row?.cnt ?? 0);
}

beforeEach(() => {
  core.resetDbInstance();
  testAdapter = createTestAdapter();
  globalThis.__omnirouteDb = testAdapter as never;
  stopArtificialAnalysisSync();
  process.env.ARTIFICIAL_ANALYSIS_API_KEY = "aa_test_key";
  delete process.env.AA_BENCHMARK_SYNC_ENABLED;
});

afterEach(() => {
  restoreFetch();
  stopArtificialAnalysisSync();
  delete globalThis.__omnirouteDb;
  delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  delete process.env.AA_BENCHMARK_SYNC_ENABLED;
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════
// 1. normalizeAaModelKeys()
// ═══════════════════════════════════════════════════════════

describe("normalizeAaModelKeys()", () => {
  it("includes the lowercased slug", () => {
    const keys = normalizeAaModelKeys(makeAaModel({ slug: "GPT-5-5" }));
    assert.ok(keys.includes("gpt-5-5"));
  });

  it("includes the lowercased display name", () => {
    const keys = normalizeAaModelKeys(makeAaModel({ name: "GPT-5.5" }));
    assert.ok(keys.includes("gpt-5.5"));
  });

  it("includes a cleaned name variant with parentheticals stripped and spaces dashed", () => {
    const keys = normalizeAaModelKeys(
      makeAaModel({ name: "Claude Sonnet 4.5 (Extended Thinking)", slug: "claude-sonnet-4-5-et" })
    );
    assert.ok(keys.includes("claude-sonnet-4.5"));
  });

  it("deduplicates keys", () => {
    const keys = normalizeAaModelKeys(makeAaModel({ name: "gpt-5-5", slug: "gpt-5-5" }));
    assert.equal(new Set(keys).size, keys.length);
  });
});

// ═══════════════════════════════════════════════════════════
// 2. transformToModelIntelligence()
// ═══════════════════════════════════════════════════════════

describe("transformToModelIntelligence()", () => {
  it("min-max normalizes each metric to [0,1] (max → 1, min → 0)", () => {
    const models = [
      makeAaModel({
        name: "Best",
        slug: "best",
        evaluations: { artificial_analysis_intelligence_index: 60 },
      }),
      makeAaModel({
        id: "2",
        name: "Worst",
        slug: "worst",
        evaluations: { artificial_analysis_intelligence_index: 20 },
      }),
    ];
    const entries = transformToModelIntelligence(models);
    const best = entries.find((e) => e.model === "best" && e.category === "aa-intelligence");
    const worst = entries.find((e) => e.model === "worst" && e.category === "aa-intelligence");
    assert.equal(best?.score, 1);
    assert.equal(worst?.score, 0);
  });

  it("uses namespaced aa-* categories for all four metrics", () => {
    const entries = transformToModelIntelligence([makeAaModel()]);
    const categories = new Set(entries.map((e) => e.category));
    assert.ok(categories.has("aa-intelligence"));
    assert.ok(categories.has("aa-coding"));
    assert.ok(categories.has("aa-math"));
    assert.ok(categories.has("aa-speed"));
  });

  it("skips null / missing metric values without emitting entries", () => {
    const entries = transformToModelIntelligence([
      makeAaModel({
        evaluations: {
          artificial_analysis_intelligence_index: 50,
          artificial_analysis_coding_index: null,
          artificial_analysis_math_index: null,
        },
        median_output_tokens_per_second: null,
      }),
    ]);
    const categories = new Set(entries.map((e) => e.category));
    assert.ok(categories.has("aa-intelligence"));
    assert.ok(!categories.has("aa-coding"));
    assert.ok(!categories.has("aa-math"));
    assert.ok(!categories.has("aa-speed"));
  });

  it("source is 'artificial_analysis' and raw value is preserved in eloRaw", () => {
    const entries = transformToModelIntelligence([makeAaModel()]);
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.equal(entry.source, "artificial_analysis");
    }
    const intel = entries.find((e) => e.model === "gpt-5-5" && e.category === "aa-intelligence");
    assert.equal(intel?.eloRaw, 50);
  });

  it("keeps the highest score when several AA variants normalize to the same key", () => {
    const models = [
      makeAaModel({
        name: "GPT-5.5 (Non-reasoning)",
        slug: "gpt-5-5-non-reasoning",
        evaluations: { artificial_analysis_intelligence_index: 30 },
      }),
      makeAaModel({
        id: "2",
        name: "GPT-5.5 (Reasoning)",
        slug: "gpt-5-5-reasoning",
        evaluations: { artificial_analysis_intelligence_index: 70 },
      }),
      makeAaModel({
        id: "3",
        name: "Baseline",
        slug: "baseline",
        evaluations: { artificial_analysis_intelligence_index: 10 },
      }),
    ];
    const entries = transformToModelIntelligence(models);
    // Both variants clean to "gpt-5.5" — only one entry may remain, with the max raw value.
    const collisions = entries.filter(
      (e) => e.model === "gpt-5.5" && e.category === "aa-intelligence"
    );
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].eloRaw, 70);
  });

  it("expires_at is ~7 days in the future", () => {
    const entries = transformToModelIntelligence([makeAaModel()]);
    const expiresAt = new Date(entries[0].expiresAt as string).getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(expiresAt - Date.now() - sevenDays) < 60_000);
  });

  it("single model per metric → score 1 (no division by zero)", () => {
    const entries = transformToModelIntelligence([makeAaModel()]);
    const intel = entries.find((e) => e.model === "gpt-5-5" && e.category === "aa-intelligence");
    assert.equal(intel?.score, 1);
  });

  it("empty input → no entries", () => {
    assert.deepEqual(transformToModelIntelligence([]), []);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. fetchAaModels()
// ═══════════════════════════════════════════════════════════

describe("fetchAaModels()", () => {
  it("sends the API key in the x-api-key header and parses the data envelope", async () => {
    let seenHeaders: Record<string, string> = {};
    mockFetch(async (_url, opts) => {
      seenHeaders = Object.fromEntries(new Headers(opts?.headers).entries());
      return jsonResponse({ status: 200, data: [makeAaModel()] });
    });
    const models = await fetchAaModels("aa_test_key");
    assert.equal(models.length, 1);
    assert.equal(models[0].slug, "gpt-5-5");
    assert.equal(seenHeaders["x-api-key"], "aa_test_key");
  });

  it("throws on non-200 status", async () => {
    mockFetch(async () => jsonResponse({ error: "unauthorized" }, 401));
    await assert.rejects(() => fetchAaModels("bad_key"), /401/);
  });

  it("throws on invalid JSON", async () => {
    mockFetch(async () => new Response("not-json", { status: 200 }));
    await assert.rejects(() => fetchAaModels("aa_test_key"), /JSON/i);
  });

  it("throws when the envelope has no data array", async () => {
    mockFetch(async () => jsonResponse({ status: 200 }));
    await assert.rejects(() => fetchAaModels("aa_test_key"));
  });
});

// ═══════════════════════════════════════════════════════════
// 4. syncArtificialAnalysis()
// ═══════════════════════════════════════════════════════════

describe("syncArtificialAnalysis()", () => {
  it("happy path: fetch → transform → upsert into model_intelligence", async () => {
    mockFetch(async () =>
      jsonResponse({
        status: 200,
        data: [
          makeAaModel(),
          makeAaModel({
            id: "2",
            name: "Claude Opus",
            slug: "claude-opus",
            evaluations: { artificial_analysis_intelligence_index: 60 },
          }),
        ],
      })
    );
    const result = await syncArtificialAnalysis();
    assert.equal(result.success, true);
    assert.equal(result.source, "artificial_analysis");
    assert.ok(result.modelCount > 0);
    assert.ok(countAaEntries() > 0);
  });

  it("no API key configured → fails fast without calling fetch", async () => {
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    let fetchCalled = false;
    mockFetch(async () => {
      fetchCalled = true;
      return jsonResponse({ status: 200, data: [] });
    });
    const result = await syncArtificialAnalysis();
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /ARTIFICIAL_ANALYSIS_API_KEY/);
    assert.equal(fetchCalled, false);
  });

  it("dryRun does not write to the DB", async () => {
    mockFetch(async () => jsonResponse({ status: 200, data: [makeAaModel()] }));
    const result = await syncArtificialAnalysis(true);
    assert.equal(result.success, true);
    assert.equal(countAaEntries(), 0);
  });

  it("fetch failure → success=false, never throws", async () => {
    mockFetch(async () => jsonResponse({ error: "boom" }, 503));
    const result = await syncArtificialAnalysis();
    assert.equal(result.success, false);
    assert.ok(result.error);
  });
});

// ═══════════════════════════════════════════════════════════
// 5. initArtificialAnalysisSync() / status
// ═══════════════════════════════════════════════════════════

describe("initArtificialAnalysisSync()", () => {
  it("returns false when the feature flag is disabled", async () => {
    process.env.AA_BENCHMARK_SYNC_ENABLED = "false";
    const started = await initArtificialAnalysisSync();
    assert.equal(started, false);
  });

  it("returns false when no API key is configured", async () => {
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    const started = await initArtificialAnalysisSync();
    assert.equal(started, false);
  });

  it("status reports the artificial_analysis source", () => {
    const status = getArtificialAnalysisSyncStatus();
    assert.deepEqual(status.sources, ["artificial_analysis"]);
    assert.equal(typeof status.enabled, "boolean");
  });
});

// ═══════════════════════════════════════════════════════════
// 6. getAaBenchmarkScore()
// ═══════════════════════════════════════════════════════════

describe("getAaBenchmarkScore()", () => {
  it("returns the synced score for a model + metric", async () => {
    mockFetch(async () =>
      jsonResponse({
        status: 200,
        data: [
          makeAaModel(),
          makeAaModel({
            id: "2",
            name: "Weak Model",
            slug: "weak-model",
            evaluations: { artificial_analysis_intelligence_index: 10 },
          }),
        ],
      })
    );
    await syncArtificialAnalysis();
    assert.equal(getAaBenchmarkScore("gpt-5-5", "intelligence"), 1);
    assert.equal(getAaBenchmarkScore("weak-model", "intelligence"), 0);
  });

  it("falls back to slug-style key (dots → dashes) for lookup", async () => {
    mockFetch(async () => jsonResponse({ status: 200, data: [makeAaModel({ name: "Other" })] }));
    await syncArtificialAnalysis();
    // Only slug "gpt-5-5" and name "other" are stored; "gpt-5.5" resolves via dot→dash.
    assert.equal(getAaBenchmarkScore("GPT-5.5", "intelligence"), 1);
  });

  it("returns null for unknown models", () => {
    assert.equal(getAaBenchmarkScore("no-such-model", "intelligence"), null);
  });
});
