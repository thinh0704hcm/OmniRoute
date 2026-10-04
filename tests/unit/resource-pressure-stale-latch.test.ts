/**
 * tests/unit/resource-pressure-stale-latch.test.ts
 *
 * Regression guard for the latched-critical deadlock that took production chat
 * down: every request answered 503 `resource_pressure` while every live signal
 * (cgroup ratio, V8 heap, PSI) read normal, and the guard never logged a trip
 * because the guard was never reached.
 *
 * Mechanism: `admitChatRequest` reads the cached severity BEFORE handing the
 * request to the handler, and the ONLY code that refreshes the cached sample is
 * `checkResourcePressureGuard()` — called by the handler, i.e. downstream of
 * admission. A cached `critical` therefore sheds every request forever: each
 * shed returns before the handler, so no refresh runs, so the latch never
 * clears. Only a process restart recovered it.
 *
 * The fix bounds the admission read with the same `maxStaleMs` the guard itself
 * applies, and schedules a refresh from that read. These tests pin both halves:
 * the stale read must not shed, and a genuinely fresh critical must still shed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createResourcePressureRuntime,
  getResourcePressureSeverity,
  reloadResourcePressureRuntime,
  type ResourceSignals,
} from "../../open-sse/utils/resourcePressure.ts";

const MiB = 1024 ** 2;

function signals(observedAtMs: number, heapUsedMb: number): ResourceSignals {
  return {
    observedAtMs,
    v8: { heapUsedBytes: heapUsedMb * MiB, heapLimitBytes: 1_000 * MiB },
    process: {
      rssBytes: 200 * MiB,
      externalBytes: 10 * MiB,
      arrayBuffersBytes: MiB,
      availableBytes: null,
      constrainedBytes: null,
    },
    cgroup: { currentBytes: null, maxBytes: null, highBytes: null, fileBytes: null, events: null },
    psi: null,
  };
}

/** Heap at 95% of the limit classifies as `critical` (criticalRatio 0.92). */
const CRITICAL_HEAP_MB = 950;
const CALM_HEAP_MB = 100;
const STALE_AFTER_MS = 1_000;

type Runtime = ReturnType<typeof createResourcePressureRuntime>;

/**
 * Drive the tracker to `critical`. Reaching critical requires
 * `sustainedSamplesCritical` (2) consecutive critical samples, so this samples,
 * ages the sample past `staleAfterMs` to unlock the next refresh, samples again,
 * then asserts the latch actually took — so a tracker change that alters the
 * streak math fails loudly here instead of silently weakening the suite.
 */
async function latchCritical(runtime: Runtime, advance: (ms: number) => void): Promise<void> {
  runtime.check();
  await runtime.whenRefreshSettled();
  advance(STALE_AFTER_MS);
  runtime.severity();
  await runtime.whenRefreshSettled();
  assert.equal(runtime.severity(), "critical", "setup: tracker must reach critical");
}

describe("resource pressure stale-latch deadlock", () => {
  it("an unobserved runtime reports normal, never the unset state", () => {
    const runtime = createResourcePressureRuntime({
      immediateHeapUsedMb: () => 1,
      sample: async () => signals(1, CALM_HEAP_MB),
    });
    assert.equal(runtime.severity(), "normal");
    runtime.dispose();
  });

  it("does NOT shed on a latched critical whose sample is older than maxStaleMs", async () => {
    let now = 1_000;
    const advance = (ms: number) => {
      now += ms;
    };
    const runtime = createResourcePressureRuntime({
      immediateHeapUsedMb: () => 1,
      maxStaleMs: 30_000,
      staleAfterMs: STALE_AFTER_MS,
      nowMs: () => now,
      sample: async () => signals(now, CRITICAL_HEAP_MB),
      schedule: (refresh) => {
        void refresh();
      },
    });

    await latchCritical(runtime, advance);

    // The deadlock window: the process is healthy again, but nothing has
    // refreshed because every request was shed before the handler ran.
    advance(60_000);
    assert.equal(
      runtime.severity(),
      "normal",
      "a stale critical must not keep shedding — that is the unrecoverable state"
    );
    assert.equal(
      runtime.check(),
      null,
      "the guard itself already refuses to act on a stale sample"
    );
    runtime.dispose();
  });

  it("recovers from the latch within one refresh once reads resume", async () => {
    let now = 1_000;
    let heapMb = CRITICAL_HEAP_MB;
    const runtime = createResourcePressureRuntime({
      immediateHeapUsedMb: () => 1,
      maxStaleMs: 30_000,
      staleAfterMs: STALE_AFTER_MS,
      nowMs: () => now,
      sample: async () => signals(now, heapMb),
      schedule: (refresh) => {
        void refresh();
      },
    });

    await latchCritical(runtime, (ms) => {
      now += ms;
    });

    // Host recovers; the staleness bound lets a request through, which is what
    // schedules the refresh that clears the latch for good.
    now += 60_000;
    heapMb = CALM_HEAP_MB;
    assert.equal(runtime.severity(), "normal");
    await runtime.whenRefreshSettled();
    assert.equal(runtime.severity(), "normal", "post-refresh severity reflects live signals");
    runtime.dispose();
  });

  it("keeps shedding while the critical sample is fresh", async () => {
    let now = 1_000;
    const runtime = createResourcePressureRuntime({
      immediateHeapUsedMb: () => 1,
      maxStaleMs: 30_000,
      staleAfterMs: STALE_AFTER_MS,
      nowMs: () => now,
      sample: async () => signals(now, CRITICAL_HEAP_MB),
      schedule: (refresh) => {
        void refresh();
      },
    });

    await latchCritical(runtime, (ms) => {
      now += ms;
    });

    // Still inside maxStaleMs and still critical: the guard must hold the line.
    now += 5_000;
    assert.equal(runtime.severity(), "critical");
    assert.ok(runtime.check(), "a fresh critical sample must still return the 503");
    runtime.dispose();
  });

  it("the exported facade reflects the same staleness bound", async () => {
    let now = 1_000;
    const runtime = reloadResourcePressureRuntime({
      immediateHeapUsedMb: () => 1,
      maxStaleMs: 30_000,
      staleAfterMs: STALE_AFTER_MS,
      nowMs: () => now,
      sample: async () => signals(now, CRITICAL_HEAP_MB),
      schedule: (refresh) => {
        void refresh();
      },
    });

    await latchCritical(runtime, (ms) => {
      now += ms;
    });
    assert.equal(getResourcePressureSeverity(), "critical");

    now += 60_000;
    assert.equal(
      getResourcePressureSeverity(),
      "normal",
      "chatBodyAdmission's read must not outlive the guard's own freshness rule"
    );
    runtime.dispose();
  });
});
