#!/usr/bin/env node

/**
 * Replay a sanitized provider/quota snapshot without touching production.
 * Usage: node scripts/ops/replay-tier-evidence.mjs snapshot.json
 */
import fs from "node:fs";

const input = process.argv[2];
if (!input) {
  console.error("usage: replay-tier-evidence.mjs snapshot.json");
  process.exit(2);
}
const snapshot = JSON.parse(fs.readFileSync(input, "utf8"));
const tiers = [
  { tier: "luna", performance: 0.78, availability: 1 },
  { tier: "terra", performance: 0.9, availability: 1.2 },
  { tier: "sol", performance: 1, availability: 1.5 },
];
const capacity = (snapshot.providers || []).reduce(
  (sum, provider) =>
    sum +
    Math.max(0, provider.activeConnections || 0) *
      Math.max(0, provider.quotaRemainingFraction ?? 1),
  0
);
const ranked = tiers
  .map((entry) => ({
    ...entry,
    score: entry.performance * entry.availability * Math.max(1, capacity),
  }))
  .sort((a, b) => b.score - a.score);
console.log(JSON.stringify({ asOf: snapshot.asOf, capacity, ranked }, null, 2));
