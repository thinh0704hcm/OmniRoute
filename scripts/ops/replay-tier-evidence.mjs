#!/usr/bin/env node

/**
 * Replay a sanitized model/quota snapshot without touching production.
 * Usage: node scripts/ops/replay-tier-evidence.mjs snapshot.json
 *
 * Performance bands are assigned before availability. The legacy providers-only
 * input remains accepted, but it cannot invent model-specific benchmark evidence.
 */
import fs from "node:fs";

const input = process.argv[2];
if (!input) {
  console.error("usage: replay-tier-evidence.mjs snapshot.json");
  process.exit(2);
}
const snapshot = JSON.parse(fs.readFileSync(input, "utf8"));
const PERFORMANCE_BANDS = ["economy", "standard", "high", "frontier"];
const ECONOMIC_POOLS = [
  "free",
  "cheap_subscription",
  "expensive_subscription",
  "raw_credits",
  "unclassified",
];

function clamp(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function assignBands(models) {
  const ranked = [...models].sort(
    (left, right) =>
      clamp(right.benchmarkScore) - clamp(left.benchmarkScore) ||
      String(left.provider || "").localeCompare(String(right.provider || "")) ||
      String(left.model).localeCompare(String(right.model))
  );
  const bands = new Map();
  let previousScore;
  let previousBand = "frontier";
  ranked.forEach((entry, index) => {
    const score = clamp(entry.benchmarkScore);
    const sameScore = previousScore !== undefined && score === previousScore;
    const quartile = Math.min(3, Math.floor((index * 4) / ranked.length));
    bands.set(
      `${entry.provider || ""}/${entry.model}`,
      sameScore ? previousBand : PERFORMANCE_BANDS[3 - quartile]
    );
    previousScore = score;
    previousBand = sameScore ? previousBand : PERFORMANCE_BANDS[3 - quartile];
  });
  return bands;
}

function availabilitySummary(observations = []) {
  const eligible = observations.filter(
    (entry) => entry.healthy !== false && entry.quotaExhausted !== true && entry.terminal !== true
  );
  const headrooms = eligible
    .map((entry) => entry.headroom)
    .filter((value) => Number.isFinite(value))
    .map(clamp);
  const effectiveHeadroom = headrooms.reduce((sum, value) => sum + value, 0);
  return {
    healthyConnectionCount: eligible.length,
    effectiveHeadroom,
    availabilityScore:
      eligible.length === 0
        ? 0
        : headrooms.length === 0
          ? 0.5
          : effectiveHeadroom / headrooms.length,
    nextResetAt: eligible
      .map((entry) => entry.resetAt)
      .filter(Boolean)
      .sort()[0],
  };
}

function legacyModels() {
  return (snapshot.providers || []).map((provider) => ({
    provider: provider.provider,
    model: provider.model || "unknown",
    benchmarkScore: provider.benchmarkScore ?? 0.5,
    qualityScore: provider.qualityScore ?? provider.benchmarkScore ?? 0.5,
    economicPool: provider.economicPool || "unclassified",
    availability: [
      {
        healthy: provider.healthy !== false,
        headroom: provider.quotaRemainingFraction,
        quotaExhausted: provider.quotaRemainingFraction === 0,
      },
    ],
  }));
}

const models = Array.isArray(snapshot.models) ? snapshot.models : legacyModels();
const bands = assignBands(models);
const ranked = models
  .map((entry) => {
    const availability = availabilitySummary(entry.availability);
    return {
      ...entry,
      performanceBand:
        entry.performanceBand || bands.get(`${entry.provider || ""}/${entry.model}`) || "economy",
      economicPool: ECONOMIC_POOLS.includes(entry.economicPool)
        ? entry.economicPool
        : "unclassified",
      availability,
    };
  })
  .sort(
    (left, right) =>
      PERFORMANCE_BANDS.indexOf(right.performanceBand) -
        PERFORMANCE_BANDS.indexOf(left.performanceBand) ||
      clamp(right.benchmarkScore) - clamp(left.benchmarkScore) ||
      clamp(right.qualityScore) - clamp(left.qualityScore) ||
      right.availability.availabilityScore - left.availability.availabilityScore ||
      right.availability.effectiveHeadroom - left.availability.effectiveHeadroom ||
      String(left.provider || "").localeCompare(String(right.provider || "")) ||
      String(left.model).localeCompare(String(right.model))
  );

const pools = Object.fromEntries(
  PERFORMANCE_BANDS.map((band) => [
    band,
    Object.fromEntries(
      ECONOMIC_POOLS.map((pool) => [
        pool,
        ranked.filter((entry) => entry.performanceBand === band && entry.economicPool === pool),
      ])
    ),
  ])
);

console.log(JSON.stringify({ asOf: snapshot.asOf, snapshotVersion: 2, ranked, pools }, null, 2));
