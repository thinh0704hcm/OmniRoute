import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  REASONING_EFFORT_ORDER,
  parseReasoningEffortEnum,
  recordLearnedReasoningEffort,
  getLearnedReasoningEffort,
  __test_resetLearnedReasoningEffortCaps,
} from "../../open-sse/services/learnedReasoningEffortCaps.ts";

beforeEach(() => {
  __test_resetLearnedReasoningEffortCaps();
});

after(() => {
  __test_resetLearnedReasoningEffortCaps();
});

// ── REASONING_EFFORT_ORDER ──────────────────────────────────────────────────

test("REASONING_EFFORT_ORDER is none < minimal < low < medium < high < xhigh < max", () => {
  assert.deepEqual(REASONING_EFFORT_ORDER, [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

// ── parseReasoningEffortEnum ────────────────────────────────────────────────

test("parseReasoningEffortEnum extracts the real OVH 422 enum (backtick-quoted)", () => {
  const err =
    "Failed to deserialize the JSON body into the target type: reasoning_effort: " +
    "unknown variant `xhigh`, expected one of `none`, `high`, `medium`, `low`, `minimal`";
  assert.deepEqual(parseReasoningEffortEnum(err), ["none", "high", "medium", "low", "minimal"]);
});

test("parseReasoningEffortEnum extracts a bare comma/and-joined enum with annotations", () => {
  const err =
    "Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.";
  assert.deepEqual(parseReasoningEffortEnum(err), ["xhigh", "medium", "low"]);
});

test("parseReasoningEffortEnum drops unrecognized tokens", () => {
  const err = "expected one of `none`, `turbo`, `high`";
  assert.deepEqual(parseReasoningEffortEnum(err), ["none", "high"]);
});

test("parseReasoningEffortEnum returns null for unrelated error text", () => {
  assert.equal(parseReasoningEffortEnum("connection refused"), null);
  assert.equal(parseReasoningEffortEnum(""), null);
  assert.equal(parseReasoningEffortEnum(null), null);
  assert.equal(parseReasoningEffortEnum(undefined), null);
});

test("parseReasoningEffortEnum returns null when the list has no recognized token", () => {
  assert.equal(parseReasoningEffortEnum("expected one of `foo`, `bar`"), null);
});

// ── recordLearnedReasoningEffort / getLearnedReasoningEffort ───────────────

test("records the highest recognized value from the accepted list", () => {
  const learned = recordLearnedReasoningEffort("ovh", "qwen3-coder-30b-a3b-instruct", [
    "none",
    "high",
    "medium",
    "low",
    "minimal",
  ]);
  assert.equal(learned, "high");
  assert.equal(getLearnedReasoningEffort("ovh", "qwen3-coder-30b-a3b-instruct"), "high");
});

test("returns null and stores nothing when acceptedValues has no recognized token", () => {
  const learned = recordLearnedReasoningEffort("acme", "model-x", ["foo", "bar"]);
  assert.equal(learned, null);
  assert.equal(getLearnedReasoningEffort("acme", "model-x"), null);
});

test("monotonic decrease: a later, higher accepted-list never ratchets the cap back up", () => {
  recordLearnedReasoningEffort("acme", "model-x", ["none", "low", "medium"]);
  const learned = recordLearnedReasoningEffort("acme", "model-x", [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.equal(learned, "medium");
  assert.equal(getLearnedReasoningEffort("acme", "model-x"), "medium");
});

test("a later, lower accepted-list does ratchet the cap down", () => {
  recordLearnedReasoningEffort("acme", "model-x", ["none", "low", "medium", "high"]);
  const learned = recordLearnedReasoningEffort("acme", "model-x", ["none", "low"]);
  assert.equal(learned, "low");
  assert.equal(getLearnedReasoningEffort("acme", "model-x"), "low");
});

test("getLearnedReasoningEffort returns null for unknown provider+model", () => {
  assert.equal(getLearnedReasoningEffort("acme", "unknown-model"), null);
});

test("getLearnedReasoningEffort is keyed case-insensitively on provider+model", () => {
  recordLearnedReasoningEffort("OVH", "Qwen3-Coder-30B", ["none", "high"]);
  assert.equal(getLearnedReasoningEffort("ovh", "qwen3-coder-30b"), "high");
  assert.equal(getLearnedReasoningEffort("OVH", "QWEN3-CODER-30B"), "high");
});

test("different providers for the same model id have independent caps", () => {
  recordLearnedReasoningEffort("ovh", "shared-model", ["none", "high"]);
  assert.equal(getLearnedReasoningEffort("openrouter", "shared-model"), null);
});

test("handles empty/null provider or model gracefully", () => {
  assert.equal(getLearnedReasoningEffort("", "m"), null);
  assert.equal(getLearnedReasoningEffort("p", ""), null);
  assert.equal(getLearnedReasoningEffort(null, "m"), null);
  assert.equal(getLearnedReasoningEffort("p", null), null);
  assert.equal(recordLearnedReasoningEffort("", "m", ["high"]), null);
  assert.equal(recordLearnedReasoningEffort("p", "", ["high"]), null);
});
