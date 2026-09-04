import test from "node:test";
import assert from "node:assert/strict";

const { applyMuseSparkMinOutputTokens, MUSE_SPARK_MIN_OUTPUT_TOKENS } =
  await import("../../open-sse/executors/opencode.ts");
const { OpencodeExecutor } = await import("../../open-sse/executors/opencode.ts");

test("muse-spark tiny max_output_tokens is raised to 8192", () => {
  const body: Record<string, unknown> = { model: "x", max_output_tokens: 64, messages: [] };
  applyMuseSparkMinOutputTokens("muse-spark-1.2-contributor", body);
  assert.equal(body.max_output_tokens, 8192);
  assert.equal(body.max_output_tokens, MUSE_SPARK_MIN_OUTPUT_TOKENS);
  assert.equal("max_tokens" in body, false);
});

test("all muse-spark id variants are covered by the prefix match", () => {
  for (const model of ["muse-spark-1", "muse-spark-1.2", "muse-spark-1.2-contributor"]) {
    const body: Record<string, unknown> = { max_output_tokens: 100 };
    applyMuseSparkMinOutputTokens(model, body);
    assert.equal(body.max_output_tokens, 8192, model);
  }
});

test("budgets at or above 8192 are untouched", () => {
  const body: Record<string, unknown> = { max_output_tokens: 8192 };
  applyMuseSparkMinOutputTokens("muse-spark-1.2-contributor", body);
  assert.equal(body.max_output_tokens, 8192);
  const big: Record<string, unknown> = { max_output_tokens: 16384 };
  applyMuseSparkMinOutputTokens("muse-spark-1.2-contributor", big);
  assert.equal(big.max_output_tokens, 16384);
});

test("non-muse-spark models are never modified", () => {
  const body: Record<string, unknown> = { max_output_tokens: 16 };
  applyMuseSparkMinOutputTokens("ox-alpha-free", body);
  assert.equal(body.max_output_tokens, 16);
  assert.equal("max_tokens" in body, false);
});

test("missing/non-numeric max_output_tokens stays absent (no synthetic budget)", () => {
  const body: Record<string, unknown> = { messages: [] };
  applyMuseSparkMinOutputTokens("muse-spark-1.2-contributor", body);
  assert.equal("max_output_tokens" in body, false);
  assert.equal("max_tokens" in body, false);
  const bad: Record<string, unknown> = { max_output_tokens: "512" };
  applyMuseSparkMinOutputTokens("muse-spark-1.2-contributor", bad);
  assert.equal(bad.max_output_tokens, "512");
});

test("non-streaming Responses JSON is preserved byte-for-byte for muse-spark", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const payload = JSON.stringify({
      id: "resp_123",
      output: [{ type: "message", content: "hi" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    globalThis.fetch = (async () =>
      new Response(payload, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    const result = await new OpencodeExecutor("opencode").execute({
      model: "muse-spark-1.3-contributor-free",
      body: { model: "muse-spark-1.3-contributor-free", input: "hi" },
      stream: false,
      credentials: {},
    });
    const text = await result.response.text();
    assert.equal(text, payload);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streaming terminal: complete SSE frame with blank delimiter, single terminal, no ping", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        [
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"OK"}',
          "event: response.completed",
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}',
          "event: ping",
          'data: {"type":"ping"}',
          "",
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )) as typeof fetch;
    const result = await new OpencodeExecutor("opencode").execute({
      model: "muse-spark-1.3-contributor-free",
      body: { model: "muse-spark-1.3-contributor-free", max_output_tokens: 8192, stream: true },
      stream: true,
      credentials: {},
    });
    const text = await result.response.text();
    const completedCount = (text.match(/"type":"response\.completed"/g) || []).length;
    assert.equal(completedCount, 1);
    assert.doesNotMatch(text, /"type":"ping"/);
    assert.match(text, /data: \{"type":"response\.completed".*\n\n/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("terminal at EOF (no trailing newline) still emits blank delimiter", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const sse =
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}';
    globalThis.fetch = (async () =>
      new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as typeof fetch;
    const result = await new OpencodeExecutor("opencode").execute({
      model: "muse-spark-1.3-contributor-free",
      body: { model: "muse-spark-1.3-contributor-free", stream: true },
      stream: true,
      credentials: {},
    });
    const text = await result.response.text();
    assert.match(text, /response\.completed/);
    assert.match(text, /\n\n$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("terminal split across chunks still completes", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      const part1 = 'data: {"type":"response.';
      const part2 = 'completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n';
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(part1));
          c.enqueue(new TextEncoder().encode(part2));
          c.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }) as typeof fetch;
    const result = await new OpencodeExecutor("opencode").execute({
      model: "muse-spark-1.3-contributor-free",
      body: { model: "muse-spark-1.3-contributor-free", stream: true },
      stream: true,
      credentials: {},
    });
    const text = await result.response.text();
    assert.match(text, /response\.completed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
