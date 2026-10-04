/**
 * First-content deadline for combo targets.
 *
 * A combo target that returns HTTP 200 but never produces real content keeps the
 * quality peek (`validateResponseQuality`) waiting forever: the peek resolves on
 * content or stream end, and a stalled upstream does neither. While it waits, the
 * combo cannot fail over — the client sits on keepalive frames for as long as the
 * slow target feels like taking (observed: 17s-166s on free-model pools, where the
 * individual targets are interchangeable and the next one is often sub-second).
 *
 * The per-target timeout (`comboConfig.targetTimeoutMs`, enforced by
 * targetTimeoutRunner) does NOT cover this: for streaming requests it bounds the
 * time-to-first-headers only, which arrives in ~2s even when the first token is a
 * minute away.
 *
 * This deadline bounds the *content* wait specifically and, on expiry, reports the
 * target as quality-invalid so the caller takes the ordinary rejection path: cancel
 * both response branches, record the failure, and try the next target.
 */

import { toPositiveInteger } from "../reasoningTokenBuffer.ts";

export type FirstContentQuality = {
  valid: boolean;
  reason?: string;
  clonedResponse?: Response;
};

/**
 * Resolve the per-combo first-content budget for one target dispatch.
 *
 * Non-streaming responses skip the content peek entirely, so the deadline does
 * not apply to them. A missing/zero/invalid value disables it.
 */
export function resolveFirstContentBudgetMs(
  config: { firstContentTimeoutMs?: unknown } | null | undefined,
  isStreaming: boolean
): number {
  if (!isStreaming) return 0;
  return toPositiveInteger(config?.firstContentTimeoutMs) ?? 0;
}

/**
 * Race a streaming quality peek against `timeoutMs`.
 *
 * Returns the peek's own result when it settles first. On expiry returns
 * `{valid:false}` with a reason naming the budget, which the combo attempt loop
 * treats exactly like any other quality rejection (failover, not a client error).
 *
 * `timeoutMs <= 0` disables the deadline and awaits the peek unchanged, preserving
 * the historical behavior for combos that do not opt in.
 */
export async function raceFirstContentDeadline(
  peek: Promise<FirstContentQuality>,
  timeoutMs: number,
  onExpired?: () => void
): Promise<FirstContentQuality> {
  if (!(timeoutMs > 0)) return peek;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<FirstContentQuality>((resolve) => {
    // Deliberately NOT unref'd: this deadline is a guarantee the caller relies on
    // to break a stalled target. It is cleared as soon as the peek settles, so it
    // never outlives the attempt.
    timer = setTimeout(() => {
      onExpired?.();
      resolve({
        valid: false,
        reason: `no content within ${timeoutMs}ms (first-content deadline)`,
      });
    }, timeoutMs);
  });

  try {
    // The peek keeps running after the deadline wins; it is abandoned by the
    // caller's response cancellation and must not surface as an unhandled
    // rejection when that cancellation makes its reader throw.
    const guardedPeek = peek.catch((err: unknown) => ({
      valid: false,
      reason: `quality peek failed: ${err instanceof Error ? err.message : String(err)}`,
    }));
    return await Promise.race([guardedPeek, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
