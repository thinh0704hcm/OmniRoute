import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-xml-tool-stream-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { createSSEStream } = await import("../../open-sse/utils/stream.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const core = await import("../../src/lib/db/core.ts");

const encoder = new TextEncoder();
const XML_ARGS =
  "model preamble <tool_calls:6124c78e>" +
  "<tool_call:6124c78e>health_check<tool_sep:6124c78e>" +
  "<arg_key:6124c78e>status</arg_key:6124c78e>" +
  "<arg_value:6124c78e>ok</arg_value:6124c78e>" +
  "</tool_call:6124c78e></tool_calls:6124c78e>";

function chatChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl_xml",
    object: "chat.completion.chunk",
    created: 1,
    model: "tencent/hy3:free",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

async function runStream(chunks: string[]): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(
    source.pipeThrough(
      createSSEStream({
        mode: "passthrough",
        sourceFormat: FORMATS.OPENAI,
        provider: "tencent",
        model: "tencent/hy3:free",
        body: { messages: [{ role: "user", content: "check health" }] },
      })
    )
  ).text();
}

function jsonPayloads(output: string): Array<Record<string, unknown>> {
  return output
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

function emittedArguments(payload: Record<string, unknown>): string {
  const choices = payload.choices as
    Array<{ delta?: { tool_calls?: Array<{ function?: { arguments?: unknown } }> } }> | undefined;
  const args = choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments;
  return typeof args === "string" ? args : "";
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("passthrough stream buffers split XML args and flushes normalized JSON before finish", async () => {
  const splitAt = XML_ARGS.indexOf("tool_calls") + 4;
  const output = await runStream([
    chatChunk({
      tool_calls: [
        {
          index: 0,
          id: "call_xml",
          type: "function",
          function: { name: "health_check", arguments: XML_ARGS.slice(0, splitAt) },
        },
      ],
    }),
    chatChunk({
      tool_calls: [{ index: 0, function: { arguments: XML_ARGS.slice(splitAt) } }],
    }),
    chatChunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ]);
  const payloads = jsonPayloads(output);
  const argsIndex = payloads.findIndex((payload) => emittedArguments(payload).includes("status"));
  const finishIndex = payloads.findIndex(
    (payload) =>
      (payload.choices as Array<{ finish_reason?: unknown }> | undefined)?.[0]?.finish_reason ===
      "tool_calls"
  );

  assert.ok(argsIndex >= 0, output);
  assert.deepEqual(JSON.parse(emittedArguments(payloads[argsIndex])), { status: "ok" });
  assert.ok(finishIndex > argsIndex, "normalized arguments must precede the finish chunk");
  assert.doesNotMatch(output, /<tool_calls:/);
});

test("passthrough EOF flush emits buffered XML args before its synthetic tool finish", async () => {
  const output = await runStream([
    chatChunk({
      tool_calls: [
        {
          index: 0,
          id: "call_xml_eof",
          type: "function",
          function: { name: "health_check", arguments: XML_ARGS },
        },
      ],
    }),
  ]);
  const payloads = jsonPayloads(output);
  const argsIndex = payloads.findIndex((payload) => emittedArguments(payload).includes("status"));
  const finishIndex = payloads.findIndex(
    (payload) =>
      (payload.choices as Array<{ finish_reason?: unknown }> | undefined)?.[0]?.finish_reason ===
      "tool_calls"
  );

  assert.ok(argsIndex >= 0, output);
  assert.ok(finishIndex > argsIndex, "EOF flush must precede the synthetic finish chunk");
  assert.doesNotMatch(output, /<tool_calls:/);
});
