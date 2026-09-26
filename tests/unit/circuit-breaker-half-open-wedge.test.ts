/**
 * A circuit breaker can wedge in HALF_OPEN with its probe budget spent and no
 * path back to a working state. Two independent ways in, both ending at the
 * same place: `execute()` throws "is HALF_OPEN, no more probe requests allowed"
 * for every subsequent request, and because the *state* is persisted while
 * `halfOpenAllowed` is not, a container restart does not clear it. Recovery
 * needed a manual `POST /api/resilience/reset`.
 *
 *   1. RESTORE — `_restoreFromDb()` restores `state = HALF_OPEN`, but the
 *      constructor set `halfOpenAllowed = 0` and `_refreshOpenState()` only
 *      handles OPEN → HALF_OPEN, so nothing ever re-arms the budget.
 *   2. SILENT PROBE — `execute()` decrements `halfOpenAllowed`, but its catch
 *      only calls `_onFailure()` when `isFailure(error)` is true. An error the
 *      classifier does not count as a failure consumes the slot without any
 *      transition back to OPEN, so the budget stays at 0.
 *
 * Both are fixed by letting `_refreshOpenState()` re-arm an exhausted HALF_OPEN
 * budget once the cooldown has elapsed, which keeps recovery lazy and
 * self-healing rather than requiring an operator.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("circuit-breaker-half-open-wedge");
const { resetStorage } = harness;
const { CircuitBreaker, STATE } = await import("../../src/shared/utils/circuitBreaker.ts");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const uniqueName = (label: string) =>
  `cb-wedge-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Short enough to keep the test fast, long enough to be unambiguous. */
const RESET_TIMEOUT_MS = 20;
const AFTER_COOLDOWN_MS = 35;

const BASE_OPTIONS = {
  failureThreshold: 1,
  resetTimeout: RESET_TIMEOUT_MS,
  halfOpenRequests: 1,
};

/** Drive a fresh breaker to OPEN, then past its cooldown so one probe is allowed. */
async function openThenArm(name: string, isFailure?: () => boolean) {
  const breaker = new CircuitBreaker(
    name,
    isFailure ? { ...BASE_OPTIONS, isFailure } : BASE_OPTIONS
  );

  await assert.rejects(
    breaker.execute(async () => {
      throw new Error("opens the breaker");
    })
  );
  assert.equal(breaker.state, STATE.OPEN, "one failure opens it at threshold 1");

  await sleep(AFTER_COOLDOWN_MS);
  assert.equal(breaker.canExecute(), true, "cooldown elapsed → a single probe is allowed");
  assert.equal(breaker.state, STATE.HALF_OPEN);
  return breaker;
}

test.afterEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await harness.cleanup();
});

test("a probe that settles with an unclassified error still settles the breaker", async () => {
  let countsAsFailure = true;
  const breaker = await openThenArm(uniqueName("silent-probe"), () => countsAsFailure);

  // The probe spends its slot, then settles with an error the classifier does
  // not count as a failure. Before the fix the catch skipped `_onFailure()`
  // entirely, so the breaker stayed in HALF_OPEN with `halfOpenAllowed = 0` and
  // refused every later request until someone reset it by hand.
  countsAsFailure = false;
  await assert.rejects(
    breaker.execute(async () => {
      throw new Error("consumes the probe without being a failure");
    })
  );

  assert.equal(
    breaker.state,
    STATE.OPEN,
    "the probe must settle the state instead of stranding it in HALF_OPEN"
  );
  assert.equal(
    breaker.canExecute(),
    false,
    "the cooldown restarts, so the next probe waits a full reset timeout"
  );

  // The point of the fix: recovery is now automatic. The breaker returns to
  // HALF_OPEN on its own and lets a probe through again.
  await sleep(AFTER_COOLDOWN_MS);
  assert.equal(
    breaker.canExecute(),
    true,
    "an abandoned probe must not disable the breaker until an operator resets it"
  );
});

test("a breaker restored from the DB in HALF_OPEN still allows its probe", async () => {
  const name = uniqueName("restore");
  const original = await openThenArm(name);

  // `canExecute()` above persisted HALF_OPEN. A new instance with the same name
  // is what a process restart looks like to the breaker.
  const restored = new CircuitBreaker(name, BASE_OPTIONS);

  assert.equal(restored.state, STATE.HALF_OPEN, "state is restored from the DB");
  assert.equal(
    restored.canExecute(),
    true,
    "a restored HALF_OPEN breaker must not refuse every probe until it is reset by hand"
  );
  assert.ok(original.state === STATE.HALF_OPEN, "sanity: the persisted state was HALF_OPEN");
});

test("an exhausted HALF_OPEN budget does not re-arm before the cooldown elapses", async () => {
  let countsAsFailure = true;
  const breaker = await openThenArm(uniqueName("no-early-rearm"), () => countsAsFailure);

  countsAsFailure = false;
  await assert.rejects(
    breaker.execute(async () => {
      throw new Error("consumes the probe");
    })
  );

  // Well inside the cooldown — re-arming here would let a failing provider be
  // probed on every single request, which is what the budget exists to prevent.
  assert.equal(breaker.canExecute(), false, "must not re-arm before the cooldown elapses");
});
