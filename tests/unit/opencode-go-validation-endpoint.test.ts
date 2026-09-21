import assert from "node:assert/strict";
import test from "node:test";

const { validateProviderApiKey } = await import("../../src/lib/providers/validation.ts");

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("OpenCode Go validates API keys against the Go models endpoint", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const result = await validateProviderApiKey({
    provider: "opencode-go",
    apiKey: "sk-opencode-go-test",
  });

  assert.equal(result.valid, true);
  assert.deepEqual(calls, ["https://opencode.ai/zen/go/v1/models"]);
});
