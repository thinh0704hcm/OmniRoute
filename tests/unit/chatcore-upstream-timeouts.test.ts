import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

import {
  createBodyTimeoutError,
  createUpstreamStartTimeoutError,
  createAbortError,
  executeWithUpstreamStartTimeout,
  computeBillableTokens,
  getExecutorTimeoutMs,
  normalizeExecutorResult,
} from "../../open-sse/handlers/chatCore/upstreamTimeouts.ts";

test("error factories set name and message", () => {
  const body = createBodyTimeoutError(1234);
  assert.equal(body.name, "BodyTimeoutError");
  assert.match(body.message, /1234ms/);

  const start = createUpstreamStartTimeoutError(500, "openai", "gpt-4o");
  assert.equal(start.name, "TimeoutError");
  assert.match(start.message, /openai\/gpt-4o/);

  const ctrl = new AbortController();
  ctrl.abort("nope");
  const ab = createAbortError(ctrl.signal);
  assert.equal(ab.name, "AbortError");
});

test("computeBillableTokens sums input+output+reasoning (no cache double-count)", () => {
  const total = computeBillableTokens({
    prompt_tokens: 10,
    completion_tokens: 5,
    reasoning_tokens: 2,
  });
  assert.equal(total, 17);
});

test("getExecutorTimeoutMs floors valid values and falls back to default", () => {
  assert.equal(getExecutorTimeoutMs({ getTimeoutMs: () => 1234.9 }), 1234);
  assert.equal(getExecutorTimeoutMs({ getTimeoutMs: () => NaN }), getExecutorTimeoutMs(null));
  assert.ok(Number.isFinite(getExecutorTimeoutMs(null)));
});

test("normalizeExecutorResult wraps bare Response and passes through rich result", () => {
  const r = new Response("x");
  const wrapped = normalizeExecutorResult(r);
  assert.equal(wrapped.response, r);
  assert.equal(wrapped.url, "");
  const rich = normalizeExecutorResult({ response: r, url: "u", headers: { a: "b" } });
  assert.equal(rich.url, "u");
  assert.equal(rich.headers.a, "b");
});

test("normalizeExecutorResult rejects malformed executor output", () => {
  assert.throws(() => normalizeExecutorResult({}), /must contain a Response/);
  assert.throws(
    () => normalizeExecutorResult({ response: "not-a-response" }),
    /must contain a Response/
  );
});
test("executeWithUpstreamStartTimeout keeps the client-abort link after resolve so post-resolve disconnects reach upstream", async () => {
  // The timeout only bounds time-to-headers: once execute() resolves, the
  // response body still streams on the combined signal, so the client-abort
  // link is intentionally retained (bounded: `once` + per-request signal)
  // instead of removed. Aborting after resolve must propagate to the
  // in-flight execution signal; the once-listener then detaches itself.
  const client = new AbortController();
  const before = getEventListeners(client.signal, "abort").length;
  let captured: AbortSignal | undefined;
  const result = await executeWithUpstreamStartTimeout({
    executor: {},
    provider: "test-provider",
    model: "test-model",
    connectionTimeoutMs: 5_000,
    signal: client.signal,
    execute: async (sig) => {
      captured = sig;
      return "ok";
    },
  });
  assert.equal(result, "ok");
  assert.ok(captured, "execute must receive the combined signal");
  assert.equal(
    getEventListeners(client.signal, "abort").length,
    before + 1,
    "the abort-forwarding link outlives a resolved execute"
  );
  client.abort();
  assert.equal(captured.aborted, true, "post-resolve client abort must reach upstream");
  assert.equal(
    getEventListeners(client.signal, "abort").length,
    before,
    "the once-link detaches after it fires"
  );
});

test("executeWithUpstreamStartTimeout: a synchronously throwing execute cannot orphan abortPromise (2026-08-31 hedge-cancelled exit)", async () => {
  // Production shape: execute() threw before Promise.race subscribed, so the
  // abortPromise listener stayed on the long-lived client signal with nobody
  // awaiting its rejection. The next hedge cancellation / client disconnect
  // then aborted that signal with a string reason and the rejection became an
  // unhandledRejection: `Error [AbortError]: hedge-cancelled`.
  const client = new AbortController();
  const before = getEventListeners(client.signal, "abort").length;
  await assert.rejects(
    executeWithUpstreamStartTimeout({
      executor: {},
      provider: "test-provider",
      model: "test-model",
      connectionTimeoutMs: 5_000,
      signal: client.signal,
      execute: () => {
        throw new Error("sync failure before the race subscribed");
      },
    }),
    /sync failure before the race subscribed/
  );
  assert.equal(
    getEventListeners(client.signal, "abort").length,
    before,
    "no listener may leak onto the client signal when execute() throws synchronously"
  );

  let unhandled: unknown = null;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    client.abort("hedge-cancelled");
    await new Promise((resolve) => setTimeout(resolve, 25));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(
    unhandled,
    null,
    "a late abort must not surface as an unhandledRejection: " + String(unhandled)
  );
});
