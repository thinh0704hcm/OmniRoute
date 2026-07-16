/**
 * Unit tests for the `aa-benchmark` combo routing strategy.
 *
 * Covers: strategy registration (constants + Zod), the aaMetric combo config
 * field, and sortTargetsByAaBenchmark ordering against a seeded
 * model_intelligence table (source = artificial_analysis).
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-aa-strategy-test-"));
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

const { ROUTING_STRATEGY_VALUES, ROUTING_STRATEGIES, normalizeRoutingStrategy } =
  await import("../../src/shared/constants/routingStrategies.ts");
const { comboStrategySchema, comboRuntimeConfigSchema } =
  await import("../../src/shared/validation/schemas/combo.ts");
const { sortTargetsByAaBenchmark } = await import("../../open-sse/services/combo/targetSorters.ts");
const { bulkUpsertModelIntelligence } = await import("../../src/lib/db/modelIntelligence.ts");

import type { ResolvedComboTarget } from "../../open-sse/services/combo/types.ts";

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

function makeTarget(modelStr: string, provider = "openai"): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: modelStr,
    executionKey: `${provider}/${modelStr}`,
    modelStr: `${provider}/${modelStr}`,
    provider,
    providerId: null,
    connectionId: null,
    weight: 0,
    label: null,
  };
}

function seedAaScore(model: string, metric: string, score: number): void {
  bulkUpsertModelIntelligence([
    {
      model,
      source: "artificial_analysis",
      category: `aa-${metric}`,
      score,
      eloRaw: score * 100,
      confidence: null,
      expiresAt: null,
    },
  ]);
}

beforeEach(() => {
  core.resetDbInstance();
  testAdapter = createTestAdapter();
  globalThis.__omnirouteDb = testAdapter as never;
});

afterEach(() => {
  delete globalThis.__omnirouteDb;
});

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════
// 1. Strategy registration
// ═══════════════════════════════════════════════════════════

describe("aa-benchmark strategy registration", () => {
  it("is included in ROUTING_STRATEGY_VALUES", () => {
    assert.ok((ROUTING_STRATEGY_VALUES as readonly string[]).includes("aa-benchmark"));
  });

  it("has a ROUTING_STRATEGIES UI entry with label/desc/icon", () => {
    const entry = ROUTING_STRATEGIES.find((s) => s.value === "aa-benchmark");
    assert.ok(entry, "aa-benchmark missing from ROUTING_STRATEGIES");
    assert.ok(entry.labelKey.length > 0);
    assert.ok(entry.combosDescKey.length > 0);
    assert.ok(entry.settingsDescKey.length > 0);
    assert.ok(entry.icon.length > 0);
  });

  it("comboStrategySchema accepts 'aa-benchmark'", () => {
    assert.equal(comboStrategySchema.parse("aa-benchmark"), "aa-benchmark");
  });

  it("normalizeRoutingStrategy preserves 'aa-benchmark'", () => {
    assert.equal(normalizeRoutingStrategy("aa-benchmark"), "aa-benchmark");
    assert.equal(normalizeRoutingStrategy("AA-Benchmark"), "aa-benchmark");
  });
});

// ═══════════════════════════════════════════════════════════
// 2. aaMetric combo config field
// ═══════════════════════════════════════════════════════════

describe("aaMetric combo config field", () => {
  it("accepts the four valid metrics", () => {
    for (const metric of ["intelligence", "coding", "math", "speed"]) {
      const parsed = comboRuntimeConfigSchema.parse({ aaMetric: metric });
      assert.equal(parsed.aaMetric, metric);
    }
  });

  it("rejects invalid metric values", () => {
    assert.throws(() => comboRuntimeConfigSchema.parse({ aaMetric: "vibes" }));
  });

  it("is optional", () => {
    const parsed = comboRuntimeConfigSchema.parse({});
    assert.equal(parsed.aaMetric, undefined);
  });
});

// ═══════════════════════════════════════════════════════════
// 3. sortTargetsByAaBenchmark()
// ═══════════════════════════════════════════════════════════

describe("sortTargetsByAaBenchmark()", () => {
  it("orders targets descending by the requested metric score", async () => {
    seedAaScore("model-low", "intelligence", 0.2);
    seedAaScore("model-mid", "intelligence", 0.5);
    seedAaScore("model-high", "intelligence", 0.9);

    const targets = [makeTarget("model-low"), makeTarget("model-high"), makeTarget("model-mid")];
    const sorted = await sortTargetsByAaBenchmark(targets, "intelligence");
    assert.deepEqual(
      sorted.map((t) => t.modelStr),
      ["openai/model-high", "openai/model-mid", "openai/model-low"]
    );
  });

  it("ranks targets without a synced score last, preserving their relative order", async () => {
    seedAaScore("model-scored", "intelligence", 0.5);

    const targets = [makeTarget("unknown-a"), makeTarget("unknown-b"), makeTarget("model-scored")];
    const sorted = await sortTargetsByAaBenchmark(targets, "intelligence");
    assert.deepEqual(
      sorted.map((t) => t.modelStr),
      ["openai/model-scored", "openai/unknown-a", "openai/unknown-b"]
    );
  });

  it("different metrics produce different orderings", async () => {
    seedAaScore("model-a", "intelligence", 0.9);
    seedAaScore("model-a", "coding", 0.1);
    seedAaScore("model-b", "intelligence", 0.1);
    seedAaScore("model-b", "coding", 0.9);

    const targets = [makeTarget("model-a"), makeTarget("model-b")];
    const byIntelligence = await sortTargetsByAaBenchmark(targets, "intelligence");
    const byCoding = await sortTargetsByAaBenchmark(targets, "coding");
    assert.equal(byIntelligence[0].modelStr, "openai/model-a");
    assert.equal(byCoding[0].modelStr, "openai/model-b");
  });

  it("falls back to original order when score lookups fail entirely", async () => {
    testAdapter.exec("DROP TABLE model_intelligence");
    const targets = [makeTarget("model-x"), makeTarget("model-y")];
    const sorted = await sortTargetsByAaBenchmark(targets, "intelligence");
    assert.deepEqual(
      sorted.map((t) => t.modelStr),
      ["openai/model-x", "openai/model-y"]
    );
  });

  it("keeps duplicate model entries intact (same model on two connections)", async () => {
    seedAaScore("model-high", "intelligence", 0.9);
    seedAaScore("model-low", "intelligence", 0.1);

    const dupA = { ...makeTarget("model-low"), connectionId: "conn-1" };
    const dupB = { ...makeTarget("model-low"), connectionId: "conn-2" };
    const targets = [dupA, dupB, makeTarget("model-high")];
    const sorted = await sortTargetsByAaBenchmark(targets, "intelligence");
    assert.equal(sorted.length, 3);
    assert.equal(sorted[0].modelStr, "openai/model-high");
    assert.deepEqual(
      sorted.slice(1).map((t) => t.connectionId),
      ["conn-1", "conn-2"]
    );
  });
});
