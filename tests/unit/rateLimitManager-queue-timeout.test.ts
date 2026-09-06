import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

const rlm = await import("../../open-sse/services/rateLimitManager.ts");
const { enableRateLimitProtection, withRateLimit, __resetRateLimitManagerForTests } = rlm;

test.beforeEach(async () => {
  await __resetRateLimitManagerForTests();
});

test("withRateLimit works without abort signal (backward compat)", async () => {
  enableRateLimitProtection("test-queue-1");
  const result = await withRateLimit("openai", "test-queue-1", "gpt-4", async () => "ok");
  assert.equal(result, "ok");
});

test("withRateLimit works with AbortSignal", async () => {
  enableRateLimitProtection("test-queue-2");
  const ac = new AbortController();
  const result = await withRateLimit(
    "openai",
    "test-queue-2",
    "gpt-4",
    async () => "ok",
    ac.signal
  );
  assert.equal(result, "ok");
  ac.abort();
});

test("client abort reaches running rate-limited work and releases signal listeners", async () => {
  enableRateLimitProtection("test-queue-forward-abort");
  const ac = new AbortController();
  const abortReason = new Error("client disconnected");
  const started = Promise.withResolvers<void>();
  let effectiveSignal: AbortSignal | undefined;

  const running = withRateLimit(
    "openai",
    "test-queue-forward-abort",
    "gpt-4",
    async (signal: AbortSignal) => {
      effectiveSignal = signal;
      started.resolve();
      await new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
    ac.signal
  );

  await started.promise;
  assert.notEqual(effectiveSignal, ac.signal, "execution receives a linked, disposable signal");
  ac.abort(abortReason);
  await assert.rejects(running, abortReason);
  assert.equal(effectiveSignal?.aborted, true);
  assert.equal(effectiveSignal?.reason, abortReason);
  assert.equal(getEventListeners(ac.signal, "abort").length, 0);

  const sameConnection = await Promise.race([
    withRateLimit("openai", "test-queue-forward-abort", "gpt-4", async () => "same-connection-ok"),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("aborted limiter slot was not released")), 500)
    ),
  ]);
  assert.equal(sameConnection, "same-connection-ok");

  enableRateLimitProtection("test-queue-other-key");
  const otherTenant = await withRateLimit(
    "openai",
    "test-queue-other-key",
    "gpt-4",
    async () => "other-tenant-ok"
  );
  assert.equal(otherTenant, "other-tenant-ok");
});

test("multiple sequential withRateLimit calls work", async () => {
  enableRateLimitProtection("test-queue-3");
  const results = await Promise.all([
    withRateLimit("openai", "test-queue-3", "gpt-4", async () => "a"),
    withRateLimit("openai", "test-queue-3", "gpt-4", async () => "b"),
  ]);
  assert.deepEqual(results.sort(), ["a", "b"]);
});

test("abort signal rejection does not leak as unhandledRejection", async () => {
  // Simulate the combo-per-model-timeout scenario: abort signal fires while
  // fn is running inside Bottleneck's limiter. The abortPromise rejects and
  // wins Promise.race, but fn's eventual rejection must be silently caught
  // (not surface as unhandledRejection).
  enableRateLimitProtection("test-queue-abort");

  let unhandledRejectionFired = false;
  const handler = (reason: unknown) => {
    if (reason instanceof Error && reason.message === "combo-per-model-timeout") {
      unhandledRejectionFired = true;
    }
  };
  process.on("unhandledRejection", handler);

  const ac = new AbortController();
  const err = new Error("combo-per-model-timeout");

  // Schedule a slow function, then abort mid-flight.
  const promise = withRateLimit(
    "openai",
    "test-queue-abort",
    "gpt-4",
    async () => {
      // Simulate work that respects the abort signal (like a fetch).
      await new Promise((r) => setTimeout(r, 200));
      throw err;
    },
    ac.signal
  );

  // Abort quickly so abortPromise wins the race.
  setTimeout(() => ac.abort(err), 10);

  // The withRateLimit call itself should reject (from abortPromise).
  await assert.rejects(promise, (e: Error) => e.message === "combo-per-model-timeout");

  // Give Bottleneck time to finish the orphaned job and let any
  // unhandledRejection fire.
  await new Promise((r) => setTimeout(r, 500));

  process.removeListener("unhandledRejection", handler);
  assert.equal(
    unhandledRejectionFired,
    false,
    "fn rejection after abort must be silently caught, not leak as unhandledRejection"
  );
});
