import test from "node:test";
import assert from "node:assert/strict";
import { opencodeProvider } from "../../open-sse/config/providers/registry/opencode/index.ts";

test("opencode muse-spark contributor-free has 1M context and auto-only tool choice", () => {
  const free = opencodeProvider.models.find((m) => m.id === "muse-spark-1.3-contributor-free");
  assert.ok(free);
  assert.equal(free!.targetFormat, "openai-responses");
  assert.equal(free!.contextLength, 1048576);
  assert.deepEqual(free!.supportedToolChoiceModes, ["auto"]);
  assert.equal(free!.supportsReasoning, true);
});

test("opencode paid muse-spark declares the verified 1M window", () => {
  // Was "no invented context limit" when no published window existed. The
  // 1048576 value is since verified real: opencode-go registry's own 1.2
  // entries, the published OpenCode catalog, and this repo's -free overlay
  // all agree (see the #12681 note in the registry).
  const paid = opencodeProvider.models.find((m) => m.id === "muse-spark-1.2");
  assert.ok(paid);
  assert.equal(paid!.targetFormat, "openai-responses");
  assert.equal(paid!.contextLength, 1048576);
});
