import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_PERFORMANCE_EVIDENCE,
  GPT56_TIER_EVIDENCE,
  rankTierEvidence,
  validateTierEvidence,
  validateClaudeTierEvidence,
  NIM_BENCHMARK_EVIDENCE,
  validateProviderBenchmarkEvidence,
} from "../../src/lib/combos/tierEvidence";
import {
  getCanonicalComboManifest,
  validateCanonicalComboManifest,
} from "../../src/lib/combos/canonicalEconomicPools";

test("GPT-5.6 evidence is source-backed and internally valid", () => {
  assert.deepEqual(validateTierEvidence(), { ok: true, errors: [] });
  assert.deepEqual(
    GPT56_TIER_EVIDENCE.map((entry) => entry.tier),
    ["luna", "terra", "sol"]
  );
});

test("Claude uses four performance tiers with pricing pools as a separate axis", () => {
  assert.deepEqual(validateClaudeTierEvidence(), { ok: true, errors: [] });
  assert.deepEqual(
    CLAUDE_PERFORMANCE_EVIDENCE.map((entry) => entry.tier),
    ["haiku", "sonnet", "opus", "fable"]
  );
  assert.deepEqual(
    CLAUDE_PERFORMANCE_EVIDENCE.map((entry) => [entry.inputUsdPer1M, entry.outputUsdPer1M]),
    [
      [1, 5],
      [2, 10],
      [5, 25],
      [10, 50],
    ]
  );
  assert.equal(CLAUDE_PERFORMANCE_EVIDENCE[3].performanceScore, 1);
  assert.equal(GPT56_TIER_EVIDENCE.find((entry) => entry.tier === "terra")?.performanceScore, 1);
  assert.equal(GPT56_TIER_EVIDENCE.find((entry) => entry.tier === "sol")?.performanceScore, 1.1);
});

test("NIM benchmark evidence remains provider-scoped", () => {
  assert.deepEqual(validateProviderBenchmarkEvidence(), { ok: true, errors: [] });
  assert.equal(NIM_BENCHMARK_EVIDENCE[0].provider, "nvidia");
  assert.equal(NIM_BENCHMARK_EVIDENCE[0].model, "nemotron-3.5-lightning-30b-a3b");
  assert.equal(NIM_BENCHMARK_EVIDENCE[2].compositeScore, 73);
  assert.ok(NIM_BENCHMARK_EVIDENCE.every((entry) => entry.provider === "nvidia"));
});

test("tier replay keeps performance ahead of availability", () => {
  const ranked = rankTierEvidence([
    { provider: "codex", activeConnections: 1, quotaRemainingFraction: 0.01 },
    { provider: "antigravity", activeConnections: 100, quotaRemainingFraction: 1 },
  ]);
  assert.deepEqual(
    ranked.map((entry) => entry.tier),
    ["sol", "terra", "luna"]
  );
});

test("canonical performance pools carry an explicit economic classification", () => {
  const combos = new Map(getCanonicalComboManifest().combos.map((combo) => [combo.name, combo]));
  assert.equal(combos.get("pool-haiku-free")?.config.economicPool, "free");
  assert.equal(combos.get("pool-luna-antigravity")?.config.economicPool, "cheap_subscription");
  assert.equal(combos.get("pool-sol-codex")?.config.economicPool, "raw_credits");
});

test("canonical pools map GPT-5.6 aliases to performance-specific pools", () => {
  const validation = validateCanonicalComboManifest();
  assert.equal(validation.ok, true, validation.errors.join("; "));
  const combos = new Map(getCanonicalComboManifest().combos.map((combo) => [combo.name, combo]));
  for (const [alias, target] of [
    ["gpt-5.6-luna", "pool-luna"],
    ["gpt-5.6-terra", "pool-terra"],
    ["gpt-5.6-sol", "pool-sol-codex"],
  ] as const) {
    assert.equal(combos.get(alias)?.models[0]?.kind, "combo-ref");
    assert.equal((combos.get(alias)?.models[0] as { comboName: string }).comboName, target);
  }
  for (const [alias, tier] of [
    ["claude-haiku-4-5-20251001", "haiku"],
    ["claude-sonnet-5", "sonnet"],
    ["claude-opus-5", "opus"],
    ["claude-fable-5", "fable"],
  ] as const) {
    const target = (combos.get(alias)?.models[0] as { comboName: string }).comboName;
    assert.equal(combos.get(target)?.config.performanceTier, tier);
  }
  assert.equal(combos.get("gpt-5.6-sol")?.config.accessPolicy, "explicit");
  assert.equal(combos.get("pool-sol-codex")?.config.accessPolicy, "explicit");
  assert.equal(combos.get("pool-terra")?.config.relativePerformanceBand, "fable");
  assert.equal(combos.get("pool-fable-premium")?.config.relativePerformanceBand, "special");
  const terra = combos.get("pool-terra");
  assert.deepEqual(
    terra?.models.map((step) => (step as { label?: string }).label),
    ["antigravity", "credits", "free", "codex"]
  );
  const sonnetFree = combos.get("pool-sonnet-free");
  assert.equal(
    sonnetFree?.models.some(
      (step) => step.kind === "model" && step.model === "nous-research/meituan/longcat-2.0:free"
    ),
    true
  );
  assert.equal(
    sonnetFree?.models.some(
      (step) => step.kind === "model" && step.model === "nvidia/nvidia/nemotron-3-super-120b-a12b"
    ),
    true
  );
  const haikuFree = combos.get("pool-haiku-free");
  assert.equal(
    haikuFree?.models.some(
      (step) => step.kind === "model" && step.model === "nous-research/meituan/longcat-2.0:free"
    ),
    false
  );
});
