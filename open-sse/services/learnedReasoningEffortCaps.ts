/**
 * Learned Reasoning-Effort Caps — reactive capability memory for providers/models
 * OmniRoute has no static registry entry for (custom OpenAI-compatible connections,
 * or any registered provider whose registry entry carries no reasoning metadata).
 *
 * Same shape as `learnedThinkingCaps.ts` (thinking_budget), generalized from a
 * numeric budget to an ordinal reasoning_effort scale: on a 4xx whose body
 * enumerates the accepted values, `base.ts`'s executor calls
 * `recordLearnedReasoningEffort`, which stores the highest recognized value in a
 * module-level Map keyed "provider:model" (lowercased). Subsequent requests for
 * the same provider+model read the cap via `getLearnedReasoningEffort` (consulted
 * by `sanitizeReasoningEffortForProvider` in `executors/base/reasoningEffort.ts`)
 * so the 4xx→retry round-trip is paid at most once per process per provider+model.
 *
 * In-memory only (same operator-accepted tradeoff as the thinking-budget cache):
 * restart resets, the first request after a restart may re-learn at the cost of
 * one upstream 4xx.
 */

export const REASONING_EFFORT_ORDER: readonly string[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// key: `${provider}:${model}` lowercased → highest value known to be accepted.
const learnedCaps = new Map<string, string>();

function buildKey(provider: string | null | undefined, model: string | null | undefined): string {
  const p = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  const m = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (!p || !m) return "";
  return `${p}:${m}`;
}

function rankOf(value: string): number {
  return REASONING_EFFORT_ORDER.indexOf(value);
}

/**
 * Return the learned cap for provider+model, or null when nothing has been
 * learned yet (no upstream 4xx recorded). Keyed case-insensitively.
 */
export function getLearnedReasoningEffort(
  provider: string | null | undefined,
  model: string | null | undefined
): string | null {
  const key = buildKey(provider, model);
  if (!key) return null;
  return learnedCaps.get(key) ?? null;
}

/**
 * Record that `acceptedValues` is the enum the upstream advertised for
 * provider+model, and store the highest recognized value as the learned cap.
 * Returns the stored value, or null when `acceptedValues` contained no token
 * from `REASONING_EFFORT_ORDER` (nothing usable to learn) or the key is unusable.
 *
 * Always monotonically decreases: if a cap already stored ranks lower than the
 * newly computed highest, the stored (lower) value wins and is returned
 * unchanged. This keeps a later, laxer-looking response (or a race between
 * concurrent requests) from ratcheting the cap back up.
 */
export function recordLearnedReasoningEffort(
  provider: string | null | undefined,
  model: string | null | undefined,
  acceptedValues: string[]
): string | null {
  const key = buildKey(provider, model);
  if (!key) return null;

  let best: string | null = null;
  let bestRank = -1;
  for (const raw of acceptedValues) {
    const rank = rankOf(raw);
    if (rank > bestRank) {
      bestRank = rank;
      best = raw;
    }
  }
  if (best === null) return null;

  const existing = learnedCaps.get(key);
  if (existing !== undefined && rankOf(existing) <= bestRank) {
    return existing; // already learned an equal-or-lower cap; keep it
  }
  learnedCaps.set(key, best);
  return best;
}

// Matches both prose shapes observed: OVH's `@ai-sdk/openai-compatible`
// deserializer ("expected one of `a`, `b`") and a generic vendor prose form
// ("Supported types are a, b, and c").
const LIST_INTRO = /(?:expected one of|supported (?:types|values) are)[:\s]*([^.]+)/i;

/**
 * Extract the upstream-advertised accepted reasoning_effort values from a 4xx
 * error body. Returns only tokens present in REASONING_EFFORT_ORDER (unknown
 * tokens are dropped defensively) in the order they appeared, or null when the
 * text names no recognized enum member.
 */
export function parseReasoningEffortEnum(errText: unknown): string[] | null {
  if (typeof errText !== "string" || !errText) return null;
  const match = LIST_INTRO.exec(errText);
  if (!match) return null;
  const tokens = match[1]
    .split(/,|\band\b|&/i)
    .map((t) =>
      t
        .replace(/`/g, "")
        .replace(/\([^)]*\)/g, "")
        .trim()
        .toLowerCase()
    )
    .filter((t) => t.length > 0 && REASONING_EFFORT_ORDER.includes(t));
  return tokens.length > 0 ? tokens : null;
}

/** Test-only: clear the learned-cap Map between tests. */
export function __test_resetLearnedReasoningEffortCaps(): void {
  learnedCaps.clear();
}
