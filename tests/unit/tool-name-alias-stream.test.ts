import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-tool-alias-stream-"));

const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { createSSEStream } = await import("../../open-sse/utils/stream.ts");

function sse(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function transform(chunks: string[], toolNameMap: Map<string, string>): Promise<string> {
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });
  return new Response(
    source.pipeThrough(
      createSSEStream({
        mode: "passthrough",
        sourceFormat: FORMATS.OPENAI_RESPONSES,
        clientResponseFormat: FORMATS.OPENAI_RESPONSES,
        provider: "github",
        model: "gpt-5.6-luna",
        toolNameMap,
        body: {
          input: "inspect",
          tools: [{ type: "function", name: "Read", parameters: { type: "object" } }],
        },
      })
    )
  ).text();
}

test("Responses passthrough restores tool names in added, done, and completed events", async () => {
  const outputItem = {
    id: "fc_1",
    type: "function_call",
    call_id: "call_1",
    name: "read_abc123",
    arguments: "{}",
    status: "completed",
  };
  const text = await transform(
    [
      sse({ type: "response.output_item.added", output_index: 0, item: outputItem }),
      sse({ type: "response.output_item.done", output_index: 0, item: outputItem }),
      sse({
        type: "response.completed",
        response: {
          id: "resp_1",
          object: "response",
          status: "completed",
          output: [outputItem],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      }),
    ],
    new Map([["read_abc123", "Read"]])
  );

  const payloads = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .filter((line) => line !== "[DONE]")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.ok(payloads.length >= 3);
  assert.equal(text.includes("read_abc123"), false);
  assert.equal(text.match(/\"name\":\"Read\"/g)?.length, 3);
});
