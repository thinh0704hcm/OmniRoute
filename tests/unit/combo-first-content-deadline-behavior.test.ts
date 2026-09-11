/**
 * tests/unit/combo-first-content-deadline-behavior.test.ts
 *
 * Behavioural proof that the first-content deadline actually aborts a stalled
 * target inside the real attempt loop. The sibling source-wiring tests only
 * assert the call is wrapped; they cannot tell whether a stalled stream is
 * abandoned, so this drives `executeTargetAttempt` directly.
 *
 * Shape under test is the one observed live on the free pools: HTTP 200,
 * `text/event-stream`, a role-only delta, then silence for as long as the
 * upstream feels like taking while the client sits on keepalive frames.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type {
  AttemptLoopDeps,
  AttemptLoopState,
} from "../../open-sse/services/combo/attemptLoopTypes.ts";
import type { ResolvedComboTarget } from "../../open-sse/services/combo/types.ts";

function emptyState(overrides: Partial<AttemptLoopState> = {}): AttemptLoopState {
  return {
    orderedTargets: [],
    fallbackCount: 0,
    recordedAttempts: 0,
    comboErrors: [],
    lastError: null,
    lastStatus: null,
    earliestRetryAfter: null,
    comboExpired: false,
    exhaustedProviders: new Set(),
    exhaustedConnections: new Set(),
    transientRateLimitedProviders: new Set(),
    abortControllers: new Map([[0, new AbortController()]]),
    dispatchedTargets: new Set(),
    targetFailureTrust: new Map(),
    comboAttemptOrder: [],
    skippedForCircuitOpen: false,
    earliestCircuitOpenRetryMs: 0,
    globalAttempts: 0,
    observedFailure: false,
    allObservedFailuresQuota: true,
    observeFailure() {},
    ...overrides,
  };
}

function baseDeps(overrides: Partial<AttemptLoopDeps> = {}): AttemptLoopDeps {
  return {
    strategy: "priority",
    combo: { name: "t", models: [] },
    config: {},
    log: { info() {}, warn() {}, debug() {}, error() {} },
    settings: null,
    resilienceSettings: { providerCooldown: { enabled: false } } as AttemptLoopDeps["resilienceSettings"],
    sticky: { targets: [], messageHash: null, stuck: false },
    effectiveSessionId: null,
    preScreenMap: new Map(),
    quotaCutoffResetWindowConfig: {} as AttemptLoopDeps["quotaCutoffResetWindowConfig"],
    maxRetries: 0,
    traceInvocationId: "inv-deadline",
    clientRequestedStream: true,
    handleSingleModelWithTimeout: async () => stalledSse200(),
    body: { messages: [{ role: "user", content: "hi" }] },
    startTime: Date.now(),
    releaseStickyPinOnFailure() {},
    clearStaleLKGP() {},
    ...overrides,
  };
}

function modelTarget(overrides: Partial<ResolvedComboTarget> = {}): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: "s1",
    executionKey: "ek-1",
    modelStr: "openai/gpt-4o",
    provider: "openai",
    providerId: null,
    connectionId: "c-1",
    weight: 1,
    label: null,
    ...overrides,
  };
}

/** 200 + SSE open forever with only role-only deltas — never real content. */
function stalledSse200(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"id":"x","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
        )
      );
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "x-omniroute-selected-connection-id": "c-1" },
  });
}

const ATTEMPT_ARGS = (deps: AttemptLoopDeps, state: AttemptLoopState, target: ResolvedComboTarget) =>
  ({ index: 0, state, deps, targetForAttempt: target, profile: {}, protectedPriorityTarget: false });

test("a stalled target is abandoned at the configured budget, not on stream end", async () => {
  const { executeTargetAttempt } =
    await import("../../open-sse/services/combo/executeTargetAttempt.ts");
  const target = modelTarget();
  const state = emptyState({ orderedTargets: [target] });
  const deps = baseDeps({ config: { firstContentTimeoutMs: 250 } });

  const started = Date.now();
  const result = await executeTargetAttempt(ATTEMPT_ARGS(deps, state, target));
  const elapsed = Date.now() - started;

  assert.equal(result, null, "a stalled target must fail over");
  assert.match(
    String(state.lastError),
    /first-content deadline/,
    `the recorded reason must name the deadline, got: ${state.lastError}`
  );
  assert.ok(
    elapsed < 2_000,
    `the deadline must fire at the budget, took ${elapsed}ms — an unbounded peek would hang forever here`
  );
});

test("no budget configured keeps the historical unbounded wait", async () => {
  const { executeTargetAttempt } =
    await import("../../open-sse/services/combo/executeTargetAttempt.ts");
  const target = modelTarget();
  const state = emptyState({ orderedTargets: [target] });
  const deps = baseDeps({ config: {} });

  let settled = false;
  const attempt = executeTargetAttempt(ATTEMPT_ARGS(deps, state, target)).then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(settled, false, "with no budget the peek must still be waiting");

  void attempt;
  await state.abortControllers.get(0)?.abort();
});

test("a target that produces content is not affected by the budget", async () => {
  const { executeTargetAttempt } =
    await import("../../open-sse/services/combo/executeTargetAttempt.ts");
  const encoder = new TextEncoder();
  const contentResponse = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"id":"y","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'
          )
        );
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-omniroute-selected-connection-id": "c-1" },
    }
  );
  const target = modelTarget();
  const state = emptyState({ orderedTargets: [target] });
  const deps = baseDeps({
    config: { firstContentTimeoutMs: 250 },
    handleSingleModelWithTimeout: async () => contentResponse,
  });

  const result = await executeTargetAttempt(ATTEMPT_ARGS(deps, state, target));
  assert.ok(result && result.ok === true, "a content-bearing target must still be accepted");
});
