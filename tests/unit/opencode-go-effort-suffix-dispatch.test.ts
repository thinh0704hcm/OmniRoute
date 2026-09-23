import test from "node:test";
import assert from "node:assert/strict";

const { applyGoEffortSuffixMapping } = await import("../../open-sse/executors/opencode.ts");

function bodyFor(model: string, extra: Record<string, unknown> = {}) {
  return { model, messages: [], ...extra };
}

// Live-verified 2026-09-23 against https://opencode.ai/zen/go/v1/responses:
// suffixed muse-spark ids 400 ("Model is unavailable"); base id +
// reasoning.effort field 200s for both high and xhigh. The executor must
// therefore strip the tier suffix to the base id and carry the tier as
// reasoning_effort (the DeepSeek pattern), never forward the alias verbatim.
test("muse-spark-1.3 high suffix maps to base id + effort field", () => {
  const mb = bodyFor("muse-spark-1.3-contributor-high");
  applyGoEffortSuffixMapping("muse-spark-1.3-contributor-high", mb);
  assert.equal(mb.model, "muse-spark-1.3-contributor");
  assert.equal(mb.reasoning_effort, "high");
});

test("muse-spark-1.3 xhigh suffix maps to base id + effort field", () => {
  const mb = bodyFor("muse-spark-1.3-contributor-xhigh");
  applyGoEffortSuffixMapping("muse-spark-1.3-contributor-xhigh", mb);
  assert.equal(mb.model, "muse-spark-1.3-contributor");
  assert.equal(mb.reasoning_effort, "xhigh");
});

test("explicit reasoning_effort wins over the suffix tier", () => {
  const mb = bodyFor("muse-spark-1.3-contributor-high", { reasoning_effort: "low" });
  applyGoEffortSuffixMapping("muse-spark-1.3-contributor-high", mb);
  assert.equal(mb.model, "muse-spark-1.3-contributor");
  assert.equal(mb.reasoning_effort, "low");
});

test("unsuffixed muse-spark base is untouched", () => {
  const mb = bodyFor("muse-spark-1.3-contributor");
  applyGoEffortSuffixMapping("muse-spark-1.3-contributor", mb);
  assert.equal(mb.model, "muse-spark-1.3-contributor");
  assert.equal("reasoning_effort" in mb, false);
});

test("other families keep verbatim ids (scope guard)", () => {
  for (const model of ["glm-5.2-high", "kimi-k2.6", "grok-4.5-low"]) {
    const mb = bodyFor(model);
    applyGoEffortSuffixMapping(model, mb);
    assert.equal(mb.model, model);
    assert.equal("reasoning_effort" in mb, false);
  }
});

test("deepseek family keeps its existing base+field mapping", () => {
  const mb = bodyFor("deepseek-v4-flash-low");
  applyGoEffortSuffixMapping("deepseek-v4-flash-low", mb);
  assert.equal(mb.model, "deepseek-v4-flash");
  assert.equal(mb.reasoning_effort, "low");
});
