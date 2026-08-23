/**
 * Evidence-first performance and economic-pool derivation.
 *
 * This module is deliberately pure.  It does not read SQLite, fetch provider
 * quotas, or infer credentials.  Callers provide the current evidence and
 * availability snapshot, which makes the ordering policy deterministic and
 * straightforward to replay in tests and operator tooling.
 */

export const PERFORMANCE_BANDS = ["economy", "standard", "high", "frontier"] as const;
export type PerformanceBand = (typeof PERFORMANCE_BANDS)[number];

export const ECONOMIC_POOLS = [
  "free",
  "cheap_subscription",
  "expensive_subscription",
  "raw_credits",
  "unclassified",
] as const;
export type EconomicPool = (typeof ECONOMIC_POOLS)[number];

export type BenchmarkEvidence = {
  provider?: string;
  model: string;
  /** Normalized quality score in [0, 1]. */
  score: number;
  /** Confidence in the score, based on sample count/interval/source quality. */
  confidence?: number;
  source: string;
  asOf?: string;
};

export type ModelPerformanceEvidence = {
  provider?: string;
  model: string;
  benchmarkScore?: number;
  benchmarkConfidence?: number;
  band?: PerformanceBand;
  /** Operational quality [0, 1], confidence-adjusted by the caller. */
  qualityScore?: number;
  p95LatencyMs?: number;
  avgTokensPerSecond?: number;
  errorRate?: number;
  sampleCount?: number;
};

export type AvailabilityObservation = {
  connectionId?: string;
  healthy?: boolean;
  terminal?: boolean;
  quotaExhausted?: boolean;
  /** Effective remaining fraction after combining mandatory quota windows. */
  headroom?: number | null;
  nextResetAt?: string | null;
};

export type EconomicOffering = {
  provider: string;
  model: string;
  accessPool?: EconomicPool;
  free?: boolean;
  subscription?: boolean;
  /** Monthly-equivalent plan cost, when the plan is known. */
  monthlyCostUsd?: number | null;
  /** True when the balance is finite and does not renew automatically. */
  nonReplenishingCredits?: boolean;
  autoTopUp?: boolean;
  availability?: readonly AvailabilityObservation[];
};

export type DerivedPoolCandidate = {
  provider: string;
  model: string;
  performanceBand: PerformanceBand;
  economicPool: EconomicPool;
  benchmarkScore: number;
  qualityScore: number;
  availabilityScore: number;
  healthyConnectionCount: number;
  effectiveHeadroom: number;
  nextResetAt: string | null;
};

export type DerivedEconomicPools = Record<
  PerformanceBand,
  Record<EconomicPool, DerivedPoolCandidate[]>
>;

const DEFAULT_SCORE = 0.5;
const CHEAP_SUBSCRIPTION_LIMIT_USD = 30;

function clamp01(value: unknown, fallback = DEFAULT_SCORE): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

function positive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function compareNullableDates(left: string | null, right: string | null): number {
  if (left && right) return left.localeCompare(right);
  if (left) return -1;
  if (right) return 1;
  return 0;
}

export function performanceBandRank(band: PerformanceBand): number {
  return PERFORMANCE_BANDS.indexOf(band);
}

/**
 * Assign stable quartile bands to a benchmark snapshot.  Ties remain in the
 * same band; a one-model snapshot is considered frontier rather than being
 * penalized by a synthetic lower quartile.
 */
export function assignPerformanceBands(
  evidence: readonly BenchmarkEvidence[]
): Map<string, PerformanceBand> {
  const sorted = [...evidence]
    .map((entry) => ({
      ...entry,
      score: clamp01(entry.score, 0),
      confidence: clamp01(entry.confidence, 1),
    }))
    .sort((left, right) => right.score - left.score || left.model.localeCompare(right.model));
  const result = new Map<string, PerformanceBand>();
  if (sorted.length === 0) return result;

  let previousScore: number | null = null;
  let previousBand: PerformanceBand = "frontier";
  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    const sameScore = previousScore !== null && entry.score === previousScore;
    const quartile = Math.min(3, Math.floor((index * 4) / sorted.length));
    const band = sameScore ? previousBand : PERFORMANCE_BANDS[3 - quartile];
    result.set(entry.model, band);
    previousScore = entry.score;
    previousBand = band;
  }
  return result;
}

/**
 * Classify the economic source of an offering.  Unknown billing semantics are
 * intentionally not guessed into a spend-sensitive pool.
 */
export function classifyEconomicPool(offering: EconomicOffering): EconomicPool {
  if (offering.accessPool && offering.accessPool !== "unclassified") {
    return offering.accessPool;
  }
  if (offering.free === true) return "free";
  if (offering.nonReplenishingCredits === true && offering.autoTopUp !== true) {
    return "raw_credits";
  }
  if (offering.subscription === true) {
    const monthlyCost = positive(offering.monthlyCostUsd);
    return monthlyCost !== null && monthlyCost >= CHEAP_SUBSCRIPTION_LIMIT_USD
      ? "expensive_subscription"
      : "cheap_subscription";
  }
  return "unclassified";
}

function deriveAvailability(observations: readonly AvailabilityObservation[] | undefined) {
  const eligible = (observations ?? []).filter(
    (observation) =>
      observation.terminal !== true &&
      observation.quotaExhausted !== true &&
      observation.healthy !== false
  );
  const healthyConnectionCount = eligible.length;
  const headrooms = eligible
    .map((observation) => clamp01(observation.headroom, DEFAULT_SCORE))
    .filter((headroom) => Number.isFinite(headroom));
  const effectiveHeadroom = headrooms.reduce((sum, value) => sum + value, 0);
  const knownHeadroom = headrooms.length > 0;
  const nextResetAt =
    eligible
      .map((observation) => observation.nextResetAt ?? null)
      .filter((value): value is string => value !== null)
      .sort((left, right) => left.localeCompare(right))[0] ?? null;

  return {
    healthyConnectionCount,
    effectiveHeadroom,
    // A candidate without a quota feed remains routable but cannot outrank a
    // measured candidate solely because the feed is missing.
    availabilityScore: knownHeadroom
      ? Math.min(1, effectiveHeadroom / Math.max(1, healthyConnectionCount))
      : healthyConnectionCount > 0
        ? DEFAULT_SCORE
        : 0,
    nextResetAt,
  };
}

export function compareDerivedCandidates(
  left: DerivedPoolCandidate,
  right: DerivedPoolCandidate
): number {
  return (
    performanceBandRank(right.performanceBand) - performanceBandRank(left.performanceBand) ||
    right.benchmarkScore - left.benchmarkScore ||
    right.qualityScore - left.qualityScore ||
    right.availabilityScore - left.availabilityScore ||
    right.effectiveHeadroom - left.effectiveHeadroom ||
    right.healthyConnectionCount - left.healthyConnectionCount ||
    compareNullableDates(left.nextResetAt, right.nextResetAt) ||
    `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`)
  );
}

function emptyPools(): DerivedEconomicPools {
  return Object.fromEntries(
    PERFORMANCE_BANDS.map((band) => [
      band,
      Object.fromEntries(ECONOMIC_POOLS.map((pool) => [pool, []])) as unknown as Record<
        EconomicPool,
        DerivedPoolCandidate[]
      >,
    ])
  ) as unknown as DerivedEconomicPools;
}

export function deriveEconomicPools(
  offerings: readonly EconomicOffering[],
  performance: readonly ModelPerformanceEvidence[] = []
): DerivedEconomicPools {
  const pools = emptyPools();
  const performanceByKey = new Map(
    performance.map((entry) => [`${entry.provider ?? ""}/${entry.model}`, entry])
  );
  const benchmarkEvidence = performance
    .filter((entry) => typeof entry.benchmarkScore === "number")
    .map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      score: entry.benchmarkScore ?? DEFAULT_SCORE,
      confidence: entry.benchmarkConfidence,
      source: "derived",
    }));
  const assignedBands = assignPerformanceBands(benchmarkEvidence);

  for (const offering of offerings) {
    const key = `${offering.provider}/${offering.model}`;
    const observed = performanceByKey.get(key) ?? performanceByKey.get(`/${offering.model}`);
    const benchmarkScore = clamp01(observed?.benchmarkScore, DEFAULT_SCORE);
    const performanceBand =
      observed?.band ?? assignedBands.get(observed?.model ?? offering.model) ?? "economy";
    const availability = deriveAvailability(offering.availability);
    const candidate: DerivedPoolCandidate = {
      provider: offering.provider,
      model: offering.model,
      performanceBand,
      economicPool: classifyEconomicPool(offering),
      benchmarkScore,
      qualityScore: clamp01(observed?.qualityScore, benchmarkScore),
      ...availability,
    };
    pools[performanceBand][candidate.economicPool].push(candidate);
  }

  for (const band of PERFORMANCE_BANDS) {
    for (const pool of ECONOMIC_POOLS) {
      pools[band][pool].sort(compareDerivedCandidates);
    }
  }
  return pools;
}

/**
 * Comparator for the runtime auto-combo path.  It enforces the hard band
 * boundary before considering the existing weighted availability score.
 */
export function comparePerformanceFirst(
  left: {
    performanceBand?: PerformanceBand;
    benchmarkScore?: number;
    quality?: number;
    score: number;
    provider: string;
    model: string;
  },
  right: {
    performanceBand?: PerformanceBand;
    benchmarkScore?: number;
    quality?: number;
    score: number;
    provider: string;
    model: string;
  }
): number {
  // Candidates from custom/injected callers may not have benchmark evidence
  // yet. Preserve the historical score ordering for that legacy shape until
  // evidence is available; seeded/runtime candidates take the policy below.
  const hasPerformanceEvidence =
    left.performanceBand !== undefined ||
    right.performanceBand !== undefined ||
    left.benchmarkScore !== undefined ||
    right.benchmarkScore !== undefined;
  if (!hasPerformanceEvidence) {
    return (
      right.score - left.score ||
      `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`)
    );
  }
  const leftBand = left.performanceBand ?? "economy";
  const rightBand = right.performanceBand ?? "economy";
  return (
    performanceBandRank(rightBand) - performanceBandRank(leftBand) ||
    clamp01(right.benchmarkScore) - clamp01(left.benchmarkScore) ||
    clamp01(right.quality) - clamp01(left.quality) ||
    right.score - left.score ||
    `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`)
  );
}
