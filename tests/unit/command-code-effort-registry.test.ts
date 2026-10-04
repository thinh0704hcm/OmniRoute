// command-code effort enforcement for combo targets: these upstream-served ids
// must be registered with declared thinking efforts so that (a) suffixed
// requests (e.g. -max/-xhigh) split to base+effort instead of 400ing verbatim
// upstream, and (b) capability/scoring systems see them. Live-verified against
// https://api.commandcode.ai/provider/v1/models (82-model pull): both base ids
// exist; zero -max ids exist anywhere.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { command_codeProvider } from "../../open-sse/config/providers/registry/command-code/index.ts";

describe("command-code effort registry", () => {
  it("registers deepseek-v4.1-flash with the family effort vocabulary", () => {
    const entry = command_codeProvider.models.find((m) => m.id === "deepseek/deepseek-v4.1-flash");
    assert.ok(entry, "deepseek/deepseek-v4.1-flash must be registered");
    for (const tier of ["low", "medium", "high", "xhigh", "max"]) {
      assert.ok(
        entry.supportedThinkingEfforts?.includes(tier as never),
        `deepseek-v4.1-flash must declare ${tier}`
      );
    }
    assert.equal(entry.contextLength, 1000000);
  });

  it("registers meta/muse-spark-1.3-contributor with effort vocabulary", () => {
    const entry = command_codeProvider.models.find(
      (m) => m.id === "meta/muse-spark-1.3-contributor"
    );
    assert.ok(entry, "meta/muse-spark-1.3-contributor must be registered");
    assert.ok(
      (entry.supportedThinkingEfforts?.length ?? 0) > 0,
      "muse-spark entry must declare thinking efforts"
    );
    assert.equal(entry.contextLength, 1048576);
  });
});
