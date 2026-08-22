import test from "node:test";
import assert from "node:assert/strict";
import {
  GPT56_TIER_EVIDENCE,
  rankTierEvidence,
  validateTierEvidence,
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

test("tier replay ranks frontier capability deterministically", () => {
  const ranked = rankTierEvidence([
    { provider: "codex", activeConnections: 3, quotaRemainingFraction: 0.8 },
    { provider: "antigravity", activeConnections: 4, quotaRemainingFraction: 0.5 },
  ]);
  assert.deepEqual(
    ranked.map((entry) => entry.tier),
    ["sol", "terra", "luna"]
  );
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
  const terra = combos.get("pool-terra");
  assert.deepEqual(
    terra?.models.map((step) => (step as { label?: string }).label),
    ["antigravity", "credits", "free", "codex"]
  );
});
