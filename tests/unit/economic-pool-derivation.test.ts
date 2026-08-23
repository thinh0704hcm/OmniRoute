import test from "node:test";
import assert from "node:assert/strict";
import {
  assignPerformanceBands,
  classifyEconomicPool,
  comparePerformanceFirst,
  deriveEconomicPools,
} from "../../src/lib/combos/economicPoolDerivation";

test("assigns benchmark quartiles from highest to lowest performance", () => {
  const bands = assignPerformanceBands(
    ["a", "b", "c", "d"].map((model, index) => ({
      model,
      score: 1 - index / 10,
      source: "test",
    }))
  );

  assert.equal(bands.get("a"), "frontier");
  assert.equal(bands.get("b"), "high");
  assert.equal(bands.get("c"), "standard");
  assert.equal(bands.get("d"), "economy");
});

test("does not infer replenishing API access as raw credits", () => {
  assert.equal(
    classifyEconomicPool({
      provider: "openai",
      model: "gpt-5.6-sol",
      nonReplenishingCredits: true,
      autoTopUp: true,
    }),
    "unclassified"
  );
  assert.equal(
    classifyEconomicPool({
      provider: "codex",
      model: "gpt-5.6-sol",
      nonReplenishingCredits: true,
    }),
    "raw_credits"
  );
  assert.equal(
    classifyEconomicPool({
      provider: "anthropic",
      model: "claude-sonnet-5",
      subscription: true,
      monthlyCostUsd: 20,
    }),
    "cheap_subscription"
  );
  assert.equal(
    classifyEconomicPool({
      provider: "anthropic",
      model: "claude-opus-5",
      subscription: true,
      monthlyCostUsd: 100,
    }),
    "expensive_subscription"
  );
});

test("availability cannot promote a lower performance band", () => {
  const frontier = {
    performanceBand: "frontier" as const,
    benchmarkScore: 0.6,
    quality: 0.5,
    score: 0.1,
    provider: "a",
    model: "frontier",
  };
  const economy = {
    performanceBand: "economy" as const,
    benchmarkScore: 1,
    quality: 1,
    score: 1,
    provider: "b",
    model: "economy",
  };

  assert.ok(comparePerformanceFirst(frontier, economy) < 0);
});

test("derives pools with connection breadth and quota headroom", () => {
  const pools = deriveEconomicPools(
    [
      {
        provider: "free-provider",
        model: "strong-free",
        free: true,
        availability: [
          { connectionId: "a", healthy: true, headroom: 0.9 },
          { connectionId: "b", healthy: true, headroom: 0.8 },
        ],
      },
      {
        provider: "credit-provider",
        model: "strong-credit",
        nonReplenishingCredits: true,
        availability: [{ connectionId: "c", healthy: true, headroom: 0.2 }],
      },
    ],
    [
      { model: "strong-free", benchmarkScore: 0.95, qualityScore: 0.9 },
      { model: "strong-credit", benchmarkScore: 0.95, qualityScore: 0.8 },
    ]
  );

  assert.equal(pools.frontier.free[0]?.model, "strong-free");
  assert.equal(pools.frontier.free[0]?.healthyConnectionCount, 2);
  assert.ok(Math.abs((pools.frontier.free[0]?.effectiveHeadroom ?? 0) - 1.7) < 1e-9);
  assert.equal(pools.frontier.raw_credits[0]?.model, "strong-credit");
});
