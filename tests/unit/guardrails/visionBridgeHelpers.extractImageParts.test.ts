/**
 * Tests for extractImageParts helper function.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { extractImageParts, extractImagePartsFromBody } from "@/lib/guardrails/visionBridgeHelpers";

interface RequestMessage {
  role?: string;
  content?: string | RequestContentPart[];
}

type RequestContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
    };

test("extractImageParts returns empty array for messages without images", () => {
  const messages: RequestMessage[] = [{ role: "user", content: "Hello, how are you?" }];
  const result = extractImageParts(messages);
  assert.deepStrictEqual(result, []);
});

test("extractImageParts detects image_url format", () => {
  const messages: RequestMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image_url", image_url: { url: "https://example.com/image.png" } },
      ],
    },
  ];
  const result = extractImageParts(messages);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].messageIndex, 0);
  assert.strictEqual(result[0].partIndex, 1);
  assert.strictEqual(result[0].imageUrl, "https://example.com/image.png");
  assert.strictEqual(result[0].imageType, "image_url");
});

test("extractImageParts detects base64 image format", () => {
  const messages: RequestMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          },
        },
      ],
    },
  ];
  const result = extractImageParts(messages);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].imageType, "image");
  assert.ok(result[0].imageUrl.startsWith("data:image/png;base64,"));
});

test("extractImageParts handles multiple images in single message", () => {
  const messages: RequestMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Compare these images" },
        { type: "image_url", image_url: { url: "https://example.com/image1.png" } },
        { type: "image_url", image_url: { url: "https://example.com/image2.png" } },
      ],
    },
  ];
  const result = extractImageParts(messages);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].partIndex, 1);
  assert.strictEqual(result[1].partIndex, 2);
});

test("extractImageParts handles images across multiple messages", () => {
  const messages: RequestMessage[] = [
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.com/image1.png" } }],
    },
    { role: "assistant", content: "Here is analysis of the first image." },
    {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "https://example.com/image2.png" } }],
    },
  ];
  const result = extractImageParts(messages);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].messageIndex, 0);
  assert.strictEqual(result[1].messageIndex, 2);
});

test("extractImageParts handles empty messages array", () => {
  const result = extractImageParts([]);
  assert.deepStrictEqual(result, []);
});

test("extractImageParts handles messages with null/undefined content", () => {
  const messages: RequestMessage[] = [
    { role: "user", content: null as unknown as RequestContentPart[] },
    { role: "user", content: undefined as unknown as RequestContentPart[] },
  ];
  const result = extractImageParts(messages);
  assert.deepStrictEqual(result, []);
});

test("extractImageParts handles data URI image_url format", () => {
  const dataUri =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const messages: RequestMessage[] = [
    { role: "user", content: [{ type: "image_url", image_url: { url: dataUri } }] },
  ];
  const result = extractImageParts(messages);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].imageUrl, dataUri);
});

test("extractImageParts preserves order of images", () => {
  const messages: RequestMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "First" },
        { type: "image_url", image_url: { url: "https://example.com/A.png" } },
        { type: "text", text: "Second" },
        { type: "image_url", image_url: { url: "https://example.com/B.png" } },
        { type: "image_url", image_url: { url: "https://example.com/C.png" } },
      ],
    },
  ];
  const result = extractImageParts(messages);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].partIndex, 1);
  assert.strictEqual(result[1].partIndex, 3);
  assert.strictEqual(result[2].partIndex, 4);
});

test("extractImageParts detects Anthropic-style image source url", () => {
  // Zoo Code / Claude-Code-compatible clients can send
  // { type: "image", source: { type: "url", url } } to the OpenAI surface.
  const messages: RequestMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "What's in this?" },
        {
          type: "image",
          source: { type: "url", url: "https://example.com/photo.png" },
        },
      ],
    },
  ];
  const result = extractImageParts(messages);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].imageUrl, "https://example.com/photo.png");
  assert.strictEqual(result[0].imageType, "url");
  assert.strictEqual(result[0].messageIndex, 0);
  assert.strictEqual(result[0].partIndex, 1);
});

test("extractImageParts ignores image source url when url is empty", () => {
  const messages: RequestMessage[] = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "url", url: "" } },
        { type: "text", text: "No image here" },
      ],
    },
  ];
  const result = extractImageParts(messages);
  assert.deepStrictEqual(result, []);
});

test("extractImageParts supports both base64 and url source blocks in one message", () => {
  const messages: RequestMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAA=" },
        },
        {
          type: "image",
          source: { type: "url", url: "https://example.com/B.png" },
        },
      ],
    },
  ];
  const result = extractImageParts(messages);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].imageType, "image");
  assert.strictEqual(result[0].imageUrl, "data:image/png;base64,AAA=");
  assert.strictEqual(result[1].imageType, "url");
  assert.strictEqual(result[1].imageUrl, "https://example.com/B.png");
});

test("extractImageParts detects image nested inside Anthropic tool_result content", () => {
  // Claude Code-style agent clients send the image inside a tool_result block:
  //   { type: "tool_result", content: [{ type: "image", source: { base64 } }] }
  // Previously invisible to the vision bridge, so the raw image leaked into the
  // combo capability filter and failed closed with "No target in combo … has
  // confirmed vision support".
  const messages: RequestMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Here is the screenshot you asked for" },
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA=" },
            },
          ],
        },
      ],
    },
  ];
  const result = extractImageParts(messages);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].messageIndex, 0);
  assert.strictEqual(result[0].imageType, "image");
  assert.strictEqual(result[0].imageUrl, "data:image/png;base64,AAAA=");
});

test("extractImageParts preserves ordering across nested tool_result and top-level images", () => {
  const messages: RequestMessage[] = [
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "https://example.com/top.png" } },
        {
          type: "tool_result",
          tool_use_id: "toolu_02",
          content: [
            { type: "text", text: "Result" },
            {
              type: "image",
              source: { type: "url", url: "https://example.com/nested.png" },
            },
          ],
        },
        { type: "image_url", image_url: { url: "https://example.com/tail.png" } },
      ],
    },
  ];
  const result = extractImageParts(messages);
  assert.strictEqual(result.length, 3);
  assert.strictEqual(result[0].imageUrl, "https://example.com/top.png");
  assert.strictEqual(result[1].imageUrl, "https://example.com/nested.png");
  assert.strictEqual(result[2].imageUrl, "https://example.com/tail.png");
});

test("extractImagePartsFromBody scans Responses API input list for input_image parts", () => {
  const body = {
    model: "openai/gpt-5",
    input: [
      { role: "system", content: "You are helpful." },
      {
        role: "user",
        content: [
          { type: "input_text", text: "What is in this image?" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA=" },
        ],
      },
      { type: "function_call_output", call_id: "call_01", output: "ok" },
    ],
  };
  const result = extractImagePartsFromBody(body);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].listKey, "input");
  assert.strictEqual(result[0].messageIndex, 1);
  assert.strictEqual(result[0].partIndex, 1);
  assert.strictEqual(result[0].imageType, "input_image");
  assert.strictEqual(result[0].imageUrl, "data:image/png;base64,AAAA=");
});

test("extractImagePartsFromBody scans input_image with image_url object shape", () => {
  const body = {
    model: "openai/gpt-5",
    input: [
      {
        role: "user",
        content: [{ type: "input_image", image_url: { url: "https://example.com/i.png" } }],
      },
    ],
  };
  const result = extractImagePartsFromBody(body);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].imageUrl, "https://example.com/i.png");
});

test("extractImagePartsFromBody scans messages list and records listKey messages", () => {
  const body = {
    model: "minimax/minimax-01",
    messages: [
      { role: "user", content: [{ type: "image_url", image_url: { url: "https://e.com/a.png" } }] },
    ],
  };
  const result = extractImagePartsFromBody(body);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].listKey, "messages");
  assert.strictEqual(result[0].messageIndex, 0);
  assert.strictEqual(result[0].partIndex, 0);
});

test("extractImagePartsFromBody returns empty when only string input is present", () => {
  const body = { model: "openai/gpt-5", input: "just a plain string prompt" };
  const result = extractImagePartsFromBody(body);
  assert.deepStrictEqual(result, []);
});

test("extractImagePartsFromBody returns empty for a body with neither list", () => {
  const result = extractImagePartsFromBody({ model: "openai/gpt-5" });
  assert.deepStrictEqual(result, []);
});

test("extractImagePartsFromBody detects a raw data URI string content part", () => {
  // valueContainsImagePart flags any string starting with data:image/ — the
  // bridge must match that reach so the part is described instead of leaking.
  const dataUri = "data:image/png;base64,AAAA=";
  const body = {
    model: "openai/gpt-4o",
    messages: [{ role: "user", content: [dataUri] }],
  };
  const result = extractImagePartsFromBody(body);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].imageUrl, dataUri);
});
