import assert from "node:assert/strict";
import test from "node:test";

import {
  hardenBuiltinAutoCombo,
  rejectEmptyVirtualAutoCombo,
  resolveAutoRoutingState,
} from "../../src/sse/handlers/autoRouting.ts";

test("deals auto models retain their runtime routing constraints", async () => {
  const fast = await resolveAutoRoutingState("auto/best-fast");
  assert.equal(fast.recognizedBuiltInAuto, true);
  assert.equal(fast.variant, "fast");
  assert.equal(fast.spec?.category, undefined);

  const vision = await resolveAutoRoutingState("auto/best-vision");
  assert.equal(vision.recognizedBuiltInAuto, true);
  assert.equal(vision.variant, undefined);
  assert.equal(vision.spec?.category, "vision");

  const reasoning = await resolveAutoRoutingState("auto/best-reasoning");
  assert.equal(reasoning.recognizedBuiltInAuto, true);
  assert.equal(reasoning.variant, "smart");
  assert.equal(reasoning.spec?.category, undefined);
});

test("empty constrained auto pools fail closed with a stable 503 code", async () => {
  const response = rejectEmptyVirtualAutoCombo({ models: [], config: {} });
  assert.ok(response);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error?.code, "auto_candidate_pool_empty");
  assert.equal(rejectEmptyVirtualAutoCombo({ models: [{}] }), null);
});

test("runtime built-in auto combos have bounded target time and attempt fanout", () => {
  const hardened = hardenBuiltinAutoCombo({
    models: [{}],
    config: {
      targetTimeoutMs: 300_000,
      maxGlobalAttempts: 30,
      comboTimeoutMs: 600_000,
      preserved: true,
    },
  });
  assert.deepEqual(hardened.config, {
    targetTimeoutMs: 60_000,
    maxGlobalAttempts: 6,
    comboTimeoutMs: 300_000,
    preserved: true,
  });

  const stricter = hardenBuiltinAutoCombo({
    models: [{}],
    config: { targetTimeoutMs: 10_000, maxGlobalAttempts: 2, comboTimeoutMs: 45_000 },
  });
  assert.equal(stricter.config.targetTimeoutMs, 10_000);
  assert.equal(stricter.config.maxGlobalAttempts, 2);
  assert.equal(stricter.config.comboTimeoutMs, 45_000);
});
