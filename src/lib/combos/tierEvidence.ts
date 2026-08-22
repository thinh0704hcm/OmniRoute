/** Source-backed performance, price, and availability policy for managed pools. */

export type TierEvidence = {
  tier: "luna" | "terra" | "sol";
  description: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  performanceScore: number;
  availabilityWeight: number;
  source: string;
};

export const GPT56_TIER_EVIDENCE: readonly TierEvidence[] = Object.freeze([
  {
    tier: "luna",
    description: "Fastest and most affordable GPT-5.6 tier",
    inputUsdPer1M: 0.2,
    outputUsdPer1M: 1.2,
    performanceScore: 0.78,
    availabilityWeight: 1,
    source: "https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/",
  },
  {
    tier: "terra",
    description: "Balanced intelligence and cost for everyday work",
    inputUsdPer1M: 2,
    outputUsdPer1M: 12,
    performanceScore: 0.9,
    availabilityWeight: 1.2,
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
  },
  {
    tier: "sol",
    description: "Flagship frontier capability",
    inputUsdPer1M: 5,
    outputUsdPer1M: 30,
    performanceScore: 1,
    availabilityWeight: 1.5,
    source: "https://openai.com/index/gpt-5-6/",
  },
]);

export type ProviderAvailability = {
  provider: string;
  activeConnections: number;
  quotaRemainingFraction?: number;
};

/** Deterministic score used by the replay tool; it never reads the live DB. */
export function scoreTierAvailability(
  evidence: TierEvidence,
  availability: ProviderAvailability[]
): number {
  const capacity = availability.reduce(
    (sum, item) =>
      sum + Math.max(0, item.activeConnections) * Math.max(0, item.quotaRemainingFraction ?? 1),
    0
  );
  return evidence.performanceScore * evidence.availabilityWeight * Math.max(1, capacity);
}

export function rankTierEvidence(availability: ProviderAvailability[] = []): TierEvidence[] {
  return [...GPT56_TIER_EVIDENCE].sort(
    (left, right) =>
      scoreTierAvailability(right, availability) - scoreTierAvailability(left, availability)
  );
}

export function validateTierEvidence(entries: readonly TierEvidence[] = GPT56_TIER_EVIDENCE): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const tiers = new Set<string>();
  for (const entry of entries) {
    if (tiers.has(entry.tier)) errors.push(`duplicate tier: ${entry.tier}`);
    tiers.add(entry.tier);
    if (!entry.source.startsWith("https://")) errors.push(`${entry.tier} source is not HTTPS`);
    if (entry.inputUsdPer1M < 0 || entry.outputUsdPer1M < 0) {
      errors.push(`${entry.tier} has negative pricing`);
    }
    if (entry.performanceScore <= 0 || entry.availabilityWeight <= 0) {
      errors.push(`${entry.tier} has non-positive score or availability weight`);
    }
  }
  return { ok: errors.length === 0, errors };
}
