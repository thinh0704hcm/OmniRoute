/**
 * Unit tests for scripts/ops/pool-optimizer-core.mjs
 *
 * The core holds the ranking + budget rules that decide which upstream model
 * serves a request, so these tests pin the two behaviours that were wrong in
 * production:
 *
 *   1. a member measured as broken (2% success over 3,069 calls) outranked a
 *      member that had never been tried, purely because it had "enough samples"
 *   2. free and paid variants of the same model shared one latency bucket
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  BUDGET_CEIL_MS,
  BUDGET_FLOOR_MS,
  DEFAULT_BUDGET_MS,
  USABLE_RELIABILITY_FLOOR,
  compare,
  deriveBudgetMs,
  enforcementFor,
  evaluate,
  lookupVariant,
  rawModelFor,
  reliabilityOf,
  sortKey,
} from "../../scripts/ops/pool-optimizer-core.mjs";

/** A latency bucket as loadLatency() produces it. */
function lat({ n = 50, ok = 45, p50 = 1000, p90 = 2000, hardRate = 0, limitedRate = 0 } = {}) {
  return { n, ok, successRate: n ? ok / n : 0, hardRate, limitedRate, p50, p90 };
}

/** Lookup deps with every evidence source empty unless a test overrides it. */
function deps(over = {}) {
  return {
    lookupLatency: () => null,
    lookupExternal: () => null,
    lookupElo: () => null,
    lookupCapability: () => null,
    lookupQuota: () => null,
    ...over,
  };
}

const member = (model, providerId = "p") => ({ providerId, model: `${providerId}/${model}` });

// ── gating ───────────────────────────────────────────────────────────────────

test("gate tiers ascend: proven-good, unproven, unusable, dead", () => {
  const d = deps({
    lookupLatency: (_p, m) => {
      if (m.endsWith("/good")) return lat({ n: 100, ok: 95, p50: 900 });
      if (m.endsWith("/slow")) return lat({ n: 100, ok: 95, p50: 30_000 });
      if (m.endsWith("/dead")) return lat({ n: 100, ok: 0, hardRate: 1, p50: 500 });
      return null;
    },
  });
  const budget = 15_000;
  const gate = (m) => sortKey(evaluate(member(m), budget, d))[0];

  assert.equal(gate("good"), 0, "proven and inside budget");
  assert.equal(gate("unproven"), 1, "no samples stays unproven");
  assert.equal(gate("slow"), 2, "proven too slow");
  assert.equal(gate("dead"), 3, "dead sorts last");
});

test("a proven member below the reliability floor never outranks an unproven one", () => {
  // The live case: opencode-zen/muse-spark-1.3-contributor-free, 2% over 3,069 calls.
  const broken = evaluate(
    member("muse-spark-1.3-contributor-free", "opencode-zen"),
    15_000,
    deps({ lookupLatency: () => lat({ n: 3069, ok: 60, p50: 2446, p90: 4000 }) })
  );
  const unproven = evaluate(member("qwen-3.8-max-free", "nara"), 15_000, deps());

  assert.ok(broken.reliability < USABLE_RELIABILITY_FLOOR);
  assert.ok(broken.unreliable, "flagged as proven-unreliable");
  assert.equal(sortKey(unproven)[0], 1);
  assert.equal(
    sortKey(broken)[0],
    2,
    "proven-broken is demoted to the unusable tier, below the unproven"
  );
  assert.ok(compare(broken, unproven) > 0, "the broken member sorts after the unproven one");
});

test("a member above the reliability floor keeps its proven-good slot", () => {
  const solid = evaluate(
    member("solid"),
    15_000,
    deps({ lookupLatency: () => lat({ n: 200, ok: 190, p50: 1200, p90: 2500 }) })
  );
  assert.ok(solid.reliability >= USABLE_RELIABILITY_FLOOR);
  assert.equal(solid.unreliable, false);
  assert.equal(sortKey(solid)[0], 0);
});

test("dead needs zero successes dominated by hard failures, not rate limits", () => {
  const d = (bucket) => deps({ lookupLatency: () => bucket });

  assert.equal(evaluate(member("hard"), 15_000, d(lat({ n: 20, ok: 0, hardRate: 1 }))).dead, true);
  assert.equal(
    evaluate(member("limited"), 15_000, d(lat({ n: 20, ok: 0, hardRate: 0, limitedRate: 1 }))).dead,
    false,
    "a purely rate-limited member is throttled, not dead"
  );
  assert.equal(
    evaluate(member("mixed"), 15_000, d(lat({ n: 20, ok: 0, hardRate: 0.4 }))).dead,
    false,
    "hard failures below the threshold are not enough"
  );
});

test("reliability falls back to the cold prior without samples", () => {
  assert.equal(reliabilityOf(null), 0.6);
  assert.equal(reliabilityOf({ n: 0, ok: 0 }), 0.6);
});

// ── budget derivation ────────────────────────────────────────────────────────

test("budget is the median of proven members' p90", () => {
  const at = (p90, bucket = {}) =>
    evaluate(
      member(`m${p90}`),
      Number.POSITIVE_INFINITY,
      deps({ lookupLatency: () => lat({ p90, ...bucket }) })
    );

  assert.equal(deriveBudgetMs([at(2000), at(4000), at(30_000), at(60_000), at(120_000)]), 30_000);
  assert.equal(
    deriveBudgetMs([at(6000), at(10_000)]),
    6000,
    "an even count resolves to the lower median, deterministically"
  );
});

test("budget is clamped into the band and falls back without evidence", () => {
  const at = (p90, bucket = {}) =>
    evaluate(
      member(`m${p90}`),
      Number.POSITIVE_INFINITY,
      deps({ lookupLatency: () => lat({ p90, ...bucket }) })
    );

  assert.equal(deriveBudgetMs([at(500)]), BUDGET_FLOOR_MS);
  assert.equal(deriveBudgetMs([at(600_000)]), BUDGET_CEIL_MS);
  assert.equal(deriveBudgetMs([]), DEFAULT_BUDGET_MS, "no members at all");
  assert.equal(
    deriveBudgetMs([evaluate(member("cold"), Number.POSITIVE_INFINITY, deps())]),
    DEFAULT_BUDGET_MS,
    "members with no measured samples cannot set a budget"
  );
});

test("budget ignores dead members so a broken model cannot widen the deadline", () => {
  const dead = evaluate(
    member("dead"),
    Number.POSITIVE_INFINITY,
    deps({ lookupLatency: () => lat({ n: 100, ok: 0, hardRate: 1, p90: 600_000 }) })
  );
  const good = evaluate(
    member("good"),
    Number.POSITIVE_INFINITY,
    deps({ lookupLatency: () => lat({ n: 100, ok: 98, p90: 9000 }) })
  );

  assert.equal(
    deriveBudgetMs([dead, good]),
    9000,
    "the dead member's 600s never reaches the budget"
  );
});

// ── lookups ──────────────────────────────────────────────────────────────────

test("rawModelFor strips the provider prefix the combo member carries", () => {
  assert.equal(rawModelFor("longcat", "longcat/LongCat-2.0"), "LongCat-2.0");
  assert.equal(
    rawModelFor("openrouter", "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"),
    "nvidia/nemotron-3-ultra-550b-a55b:free"
  );
  assert.equal(rawModelFor("groq", "compound"), "compound", "already bare");
});

test("lookupVariant distinguishes free from paid variants of one provider", () => {
  const buckets = new Map([
    ["opencode-zen\u0000nemotron-3-ultra-free", "FREE"],
    ["opencode-zen\u0000nemotron-3-ultra", "PAID"],
  ]);

  assert.equal(
    lookupVariant(buckets, "opencode-zen", "opencode-zen/nemotron-3-ultra-free"),
    "FREE"
  );
  assert.equal(lookupVariant(buckets, "opencode-zen", "opencode-zen/nemotron-3-ultra"), "PAID");
});

test("lookupVariant falls back to the leaf only when it is unambiguous", () => {
  const single = new Map([["opencode-zen\u0000nemotron-3-ultra-free", "FREE"]]);
  assert.equal(
    lookupVariant(single, "opencode-zen", "opencode-zen/nemotron-3-ultra"),
    "FREE",
    "one candidate: the leaf match is safe"
  );

  const other = new Map([["openrouter\u0000nemotron-3-ultra-free", "OTHER_PROVIDER"]]);
  assert.equal(
    lookupVariant(other, "opencode-zen", "opencode-zen/nemotron-3-ultra"),
    null,
    "another provider's bucket is never borrowed"
  );
});

// ── enforcement ──────────────────────────────────────────────────────────────

test("enforcement fills only what the operator has not set", () => {
  assert.deepEqual(enforcementFor(8000, {}), {
    firstContentTimeoutMs: 8000,
    comboTimeoutMs: 32_000,
  });
  assert.deepEqual(
    enforcementFor(8000, { firstContentTimeoutMs: 15_000 }),
    { comboTimeoutMs: 32_000 },
    "an explicit firstContentTimeoutMs is never retuned"
  );
  assert.deepEqual(enforcementFor(8000, { comboTimeoutMs: 1000 }), {
    firstContentTimeoutMs: 8000,
  });
  assert.deepEqual(
    enforcementFor(8000, { firstContentTimeoutMs: 15_000, comboTimeoutMs: 1000 }),
    {},
    "a fully configured pool is left alone"
  );
});

test("enforcement treats a disabled 0 as unset and honours the attempts knob", () => {
  assert.deepEqual(enforcementFor(6000, { firstContentTimeoutMs: 0, comboTimeoutMs: 0 }), {
    firstContentTimeoutMs: 6000,
    comboTimeoutMs: 24_000,
  });
  assert.equal(enforcementFor(10_000, {}, { attempts: 2 }).comboTimeoutMs, 20_000);
});
