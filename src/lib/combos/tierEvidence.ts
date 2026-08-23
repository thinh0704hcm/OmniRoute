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

export type ClaudePerformanceTier = "haiku" | "sonnet" | "opus" | "fable";
export type PricingStructure = "free" | "subscription" | "credits" | "api";

export type ClaudeTierEvidence = {
  tier: ClaudePerformanceTier;
  model: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  performanceScore: number;
  pricingStructures: readonly PricingStructure[];
  source: string;
};

/** Provider-scoped benchmark evidence; scores must not be generalized to other hosts. */
export type ProviderBenchmarkEvidence = {
  provider: string;
  model: string;
  compositeScore: number;
  successRate: number;
  runs: number;
  source: string;
};

/** NIMStats measurements supplied for NVIDIA NIM only (720 runs, 16 models). */
export const NIM_BENCHMARK_EVIDENCE: readonly ProviderBenchmarkEvidence[] = Object.freeze([
  {
    provider: "nvidia",
    model: "nemotron-3.5-lightning-30b-a3b",
    compositeScore: 75,
    successRate: 0.98,
    runs: 24,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "gpt-oss-20b",
    compositeScore: 74,
    successRate: 1,
    runs: 14,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "nemotron-3-super-120b-a12b",
    compositeScore: 73,
    successRate: 0.9,
    runs: 26,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "nemotron-3-ultra-550b-a55b",
    compositeScore: 72,
    successRate: 0.88,
    runs: 38,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "nemotron-3-nano-omni-30b-a3b-reasoning",
    compositeScore: 68,
    successRate: 0.86,
    runs: 15,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "deepseek-v4-flash-0731",
    compositeScore: 53,
    successRate: 0.68,
    runs: 52,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "glm-5.2",
    compositeScore: 43,
    successRate: 0.18,
    runs: 53,
    source: "NIMStats",
  },
]);

export function validateProviderBenchmarkEvidence(
  entries: readonly ProviderBenchmarkEvidence[] = NIM_BENCHMARK_EVIDENCE
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const entry of entries) {
    if (!entry.provider || !entry.model || entry.source !== "NIMStats") {
      errors.push(`${entry.provider}/${entry.model} has invalid scope metadata`);
    }
    if (
      entry.compositeScore < 0 ||
      entry.successRate < 0 ||
      entry.successRate > 1 ||
      entry.runs <= 0
    ) {
      errors.push(`${entry.provider}/${entry.model} has invalid benchmark values`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Anthropic's four performance bands, with pricing kept as a separate pool axis. */
export const CLAUDE_PERFORMANCE_EVIDENCE: readonly ClaudeTierEvidence[] = Object.freeze([
  {
    tier: "haiku",
    model: "claude-haiku-4-5",
    inputUsdPer1M: 1,
    outputUsdPer1M: 5,
    performanceScore: 0.78,
    pricingStructures: ["free", "subscription"],
    source: "https://www.anthropic.com/claude/haiku",
  },
  {
    tier: "sonnet",
    model: "claude-sonnet-5",
    inputUsdPer1M: 2,
    outputUsdPer1M: 10,
    performanceScore: 0.86,
    pricingStructures: ["free", "subscription", "credits"],
    source: "https://www.anthropic.com/claude/sonnet",
  },
  {
    tier: "opus",
    model: "claude-opus-5",
    inputUsdPer1M: 5,
    outputUsdPer1M: 25,
    performanceScore: 0.94,
    pricingStructures: ["subscription", "credits", "api"],
    source: "https://www.anthropic.com/claude/opus",
  },
  {
    tier: "fable",
    model: "claude-fable-5",
    inputUsdPer1M: 10,
    outputUsdPer1M: 50,
    performanceScore: 1,
    pricingStructures: ["subscription", "credits", "api"],
    source: "https://www.anthropic.com/claude/fable",
  },
]);

export function validateClaudeTierEvidence(
  entries: readonly ClaudeTierEvidence[] = CLAUDE_PERFORMANCE_EVIDENCE
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const expected: ClaudePerformanceTier[] = ["haiku", "sonnet", "opus", "fable"];
  if (entries.length !== expected.length) {
    errors.push(`expected ${expected.length} Claude tiers, received ${entries.length}`);
  }
  entries.forEach((entry, index) => {
    if (entry.tier !== expected[index]) errors.push(`Claude tier order mismatch at ${index}`);
    if (!entry.source.startsWith("https://")) errors.push(`${entry.tier} source is not HTTPS`);
    if (entry.inputUsdPer1M < 0 || entry.outputUsdPer1M < 0) {
      errors.push(`${entry.tier} has negative pricing`);
    }
    if (entry.performanceScore <= 0 || entry.pricingStructures.length === 0) {
      errors.push(`${entry.tier} has invalid performance or pricing metadata`);
    }
    for (const structure of entry.pricingStructures) {
      if (!["free", "subscription", "credits", "api"].includes(structure)) {
        errors.push(`${entry.tier} has unknown pricing structure ${structure}`);
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

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
    // Same normalized general-access performance band as Claude Fable.
    performanceScore: 1,
    availabilityWeight: 1.2,
    source: "https://developers.openai.com/api/docs/models/gpt-5.6-terra",
  },
  {
    tier: "sol",
    description: "Flagship frontier capability",
    inputUsdPer1M: 5,
    outputUsdPer1M: 30,
    // Above the general-access scale; this model is explicitly gated.
    performanceScore: 1.1,
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
