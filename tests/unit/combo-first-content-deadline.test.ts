/**
 * tests/unit/combo-first-content-deadline.test.ts
 *
 * Regression guard for the streaming first-content failover deadline.
 *
 * Symptom this exists for: a combo target returns HTTP 200 and then produces no
 * content for tens of seconds while the client sits on keepalive frames. Free-model
 * pools made that the common case (observed live: 17s-166s to first content on
 * `pool-sonnet` / `pool-haiku`), because the quality peek waited on content with no
 * deadline and the per-target `targetTimeoutMs` only bounds time-to-first-headers
 * for streaming requests.
 *
 * Covers:
 *   1. The deadline helper: pass-through, expiry, disabled budget, abandoned peek.
 *   2. Config plumbing: default off, per-combo override reaches the resolved config.
 *   3. Wiring: the combo attempt loop wraps the quality peek and gates on streaming.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  raceFirstContentDeadline,
  resolveFirstContentBudgetMs,
} from "../../open-sse/services/combo/firstContentDeadline.ts";
import { validateResponseQuality } from "../../open-sse/services/combo/validateQuality.ts";
import { getDefaultComboConfig, resolveComboConfig } from "../../open-sse/services/comboConfig.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 1. Deadline helper ────────────────────────────────────────────────────────

test("first-content deadline — returns the peek result when it settles first", async () => {
  const result = await raceFirstContentDeadline(
    Promise.resolve({ valid: true, clonedResponse: new Response("ok") }),
    5_000
  );
  assert.equal(result.valid, true);
  assert.ok(result.clonedResponse);
});

test("first-content deadline — expires as quality-invalid so the combo fails over", async () => {
  let expired = false;
  // A peek that never resolves: exactly the stalled-upstream shape.
  const stalled = new Promise<{ valid: boolean; reason?: string }>(() => {});
  const result = await raceFirstContentDeadline(stalled, 30, () => {
    expired = true;
  });

  assert.equal(result.valid, false, "expiry must be a failover, not a success");
  assert.match(String(result.reason), /no content within 30ms/);
  assert.equal(expired, true, "onExpired hook must fire so callers can cancel upstream");
});

test("first-content deadline — disabled budget (0) awaits the peek unchanged", async () => {
  const result = await raceFirstContentDeadline(
    Promise.resolve({ valid: false, reason: "peek verdict" }),
    0
  );
  assert.equal(result.valid, false);
  assert.equal(result.reason, "peek verdict", "disabled budget must not synthesize a reason");
});

test("first-content deadline — a peek rejected after expiry cannot surface as unhandled", async () => {
  // Simulates the abandoned peek: the caller cancels the response branches once
  // the deadline wins, which makes the peek's reader throw. That rejection must be
  // absorbed by the helper instead of crashing the process.
  let rejectPeek: (err: Error) => void = () => {};
  const peek = new Promise<{ valid: boolean }>((_, reject) => {
    rejectPeek = reject;
  });
  const result = await raceFirstContentDeadline(peek, 20);
  assert.equal(result.valid, false);

  rejectPeek(new Error("Invalid state: The ReadableStream is locked"));
  await wait(10);
  // Reaching here without an unhandledRejection terminating the run is the assertion.
  assert.ok(true);
});

// ── 2. Real-code integration: a stalled upstream body through the actual peek ──

/**
 * The shape observed live on the free pools: HTTP 200, `text/event-stream`, a
 * role-only delta, then silence — the upstream holds the connection open while it
 * "thinks". `validateResponseQuality` waits on content, so without a deadline the
 * combo has nothing to fail over on.
 */
function stalledUpstreamResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl-x","object":"chat.completion.chunk","model":"mw","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
        )
      );
      // Deliberately never enqueued again and never closed.
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

test("first-content deadline — the real quality peek on a stalled stream is bounded", async () => {
  const response = stalledUpstreamResponse();
  const peek = validateResponseQuality(response, true, { warn() {} });

  // Baseline: the peek alone never settles — this is the unbounded wait the
  // deadline exists to break, and the reason a stalled target could hold a combo.
  let peekSettled = false;
  void peek.then(() => {
    peekSettled = true;
  });
  await wait(40);
  assert.equal(peekSettled, false, "validateResponseQuality must still be waiting for content");

  // With the deadline, the same peek resolves as quality-invalid at the budget.
  const started = Date.now();
  const result = await raceFirstContentDeadline(
    validateResponseQuality(stalledUpstreamResponse(), true, { warn() {} }),
    60
  );
  const elapsed = Date.now() - started;

  assert.equal(result.valid, false, "a target with no content must fail over");
  assert.match(String(result.reason), /first-content deadline/);
  assert.ok(elapsed < 1_000, `deadline must fire at the budget, took ${elapsed}ms`);
});

test("first-content deadline — a stream that does produce content is still accepted", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"id":"chatcmpl-y","object":"chat.completion.chunk","model":"mw","choices":[{"index":0,"delta":{"content":"A banana is yellow."},"finish_reason":null}]}\n\n'
        )
      );
      controller.close();
    },
  });
  const response = new Response(body, { headers: { "content-type": "text/event-stream" } });

  const result = await raceFirstContentDeadline(
    validateResponseQuality(response, true, { warn() {} }),
    5_000
  );
  assert.equal(result.valid, true, "content-bearing targets must not be failed over");
});

// ── 3. Config plumbing ────────────────────────────────────────────────────────

test("first-content deadline — off by default so no combo changes behavior implicitly", () => {
  assert.equal(getDefaultComboConfig().firstContentTimeoutMs, 0);
});

test("first-content deadline — a per-combo override reaches the resolved config", () => {
  const resolved = resolveComboConfig(
    { config: { firstContentTimeoutMs: 6000 } },
    { comboDefaults: {} }
  );
  assert.equal(resolved.firstContentTimeoutMs, 6000);
});

// ── 3. Wiring in every target-dispatch path ───────────────────────────────────

/**
 * The peek is awaited in four separate dispatch paths, one per combo family, and
 * a combo is only covered if EVERY path it can take is wrapped. Missing one is
 * how the first cut of this fix shipped inert: `pool-sonnet-free` (reset-aware)
 * and `pool-haiku-free` (random) route through `roundRobinCombo`, so a deadline
 * wired only into the priority/speculative loop changed nothing for them and the
 * measured latency stayed at 25-62s.
 */
const PEEK_SITES = [
  "open-sse/services/combo/executeTargetAttempt.ts",
  "open-sse/services/combo/roundRobinCombo.ts",
  "open-sse/services/combo/runtimeUnits.ts",
  "open-sse/services/combo/dispatchPrelude.ts",
];

test("first-content deadline — every quality-peek call site is wrapped", () => {
  for (const relative of PEEK_SITES) {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");

    const deadlineIndex = source.indexOf("raceFirstContentDeadline(");
    const peekIndex = source.indexOf("validateResponseQuality(");
    assert.ok(deadlineIndex > -1, `${relative}: must wrap its quality peek in the deadline`);
    assert.ok(
      peekIndex > -1 && deadlineIndex < peekIndex,
      `${relative}: validateResponseQuality must be the deadline's argument`
    );

    // The budget must come from the combo config and be gated on streaming.
    assert.match(
      source,
      /resolveFirstContentBudgetMs\(/,
      `${relative}: must resolve the per-combo budget`
    );
    assert.match(
      source,
      /resolveFirstContentBudgetMs\([^)]*,\s*(?:deps\.)?clientRequestedStream\)/,
      `${relative}: the deadline must apply only to streaming requests`
    );
  }
});

test("first-content deadline — the budget helper is off unless the combo opts in", () => {
  assert.equal(resolveFirstContentBudgetMs(undefined, true), 0);
  assert.equal(resolveFirstContentBudgetMs({}, true), 0);
  assert.equal(resolveFirstContentBudgetMs({ firstContentTimeoutMs: 0 }, true), 0);
  assert.equal(resolveFirstContentBudgetMs({ firstContentTimeoutMs: 15000 }, true), 15_000);
  assert.equal(
    resolveFirstContentBudgetMs({ firstContentTimeoutMs: 15000 }, false),
    0,
    "non-streaming responses are never peeked, so the deadline must not apply"
  );
  assert.equal(
    resolveFirstContentBudgetMs({ firstContentTimeoutMs: "15000" }, true),
    15_000,
    "a string value from a stored combo config must still resolve"
  );
});
