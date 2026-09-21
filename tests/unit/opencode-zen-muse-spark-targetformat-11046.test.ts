import test from "node:test";
import assert from "node:assert/strict";
import { opencode_zenProvider } from "../../open-sse/config/providers/registry/opencode/zen/index.ts";

test("opencode-zen muse-spark contributor-free has 1M context and auto-only tool choice", () => {
  const free = opencode_zenProvider.models.find((m) => m.id === "muse-spark-1.3-contributor-free");
  assert.ok(free);
  assert.equal(free!.targetFormat, "openai-responses");
  assert.equal(free!.contextLength, 1048576);
  assert.deepEqual(free!.supportedToolChoiceModes, ["auto"]);
});

test("opencode-zen paid muse-spark has no invented context limit", () => {
  const paid = opencode_zenProvider.models.find((m) => m.id === "muse-spark-1.2");
  assert.ok(paid);
  assert.equal(paid!.targetFormat, "openai-responses");
  assert.equal(paid!.contextLength, undefined);
});
