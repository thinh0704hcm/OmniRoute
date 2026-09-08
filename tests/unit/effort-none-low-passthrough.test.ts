import assert from "node:assert/strict";
import test from "node:test";

import { normalizeReasoningRequest } from "../../src/shared/reasoning/effortStandardization.ts";

test("effort none folds onto reasoning fields", () => {
  const out = normalizeReasoningRequest({ model: "codex/gpt-5.6-sol", effort: "none" }, "codex");
  assert.equal(out.reasoning_effort, "none");
  assert.equal((out.reasoning as Record<string, unknown>).effort, "none");
});

test("effort low folds onto reasoning fields", () => {
  const out = normalizeReasoningRequest({ model: "codex/gpt-5.6-sol", effort: "low" }, "codex");
  assert.equal(out.reasoning_effort, "low");
});

test("explicit reasoning_effort wins over canonical effort", () => {
  const out = normalizeReasoningRequest(
    { model: "codex/gpt-5.6-sol", effort: "low", reasoning_effort: "high" },
    "codex"
  );
  assert.equal(out.reasoning_effort, "high");
});

test("deepseek native max preserved with provider", () => {
  const out = normalizeReasoningRequest(
    { model: "deepseek/deepseek-v4-pro", effort: "max" },
    "deepseek"
  );
  assert.equal(out.reasoning_effort, "max");
});

test("thinking false is preserved as boolean", () => {
  const out = normalizeReasoningRequest({ model: "x", thinking: false }, null);
  assert.equal(out.thinking, false);
});
