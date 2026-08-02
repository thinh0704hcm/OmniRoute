/**
 * Regression test for #6459: tool-call arguments render as
 * `[object Object][object Object]` in the user-visible transcript when the
 * upstream provider delivers the FULL `tool_calls[].function.arguments` value
 * as an already-parsed JSON object (not a JSON-encoded string), which is what
 * some Anthropic-shape-compatible backends do instead of following the OpenAI
 * streaming contract.
 *
 * Before the fix, `appendToolCallArgumentDelta()` treated any non-string
 * `incoming` fragment as an empty string, so the accumulated `argBuffer`
 * never picked up the object at all — `openaiToClaudeResponse()` (the
 * translator that builds the live /anthropic SSE stream, see
 * `open-sse/translator/response/openai-to-claude.ts`) then emitted no
 * `input_json_delta` for that chunk, and the client is left to coerce
 * whatever partial data it has via string concatenation/`String(object)`,
 * which is exactly how `[object Object]` sequences end up in the transcript.
 *
 * The fix: JSON.stringify() a non-string, non-null object/array fragment
 * instead of discarding it, so the assembled `partial_json` is always valid
 * JSON that parses back into the original structured value.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { openaiToClaudeResponse } from "../../open-sse/translator/response/openai-to-claude.ts";

function createState() {
  return { toolCalls: new Map() };
}

function flatten(items: unknown[][]) {
  return items.flatMap((item) => item || []);
}

function assembleToolUseInput(events: Array<Record<string, unknown>>) {
  const jsonDeltas = events.filter(
    (e) => e?.type === "content_block_delta" && (e.delta as Record<string, unknown>)?.type === "input_json_delta"
  );
  const assembled = jsonDeltas
    .map((e) => (e.delta as Record<string, unknown>).partial_json as string)
    .join("");
  return assembled;
}

test("#6459: tool-call arguments delivered as a structured object (not a JSON string) render as the real object, not [object Object]", () => {
  const state = createState();

  const chunk1 = openaiToClaudeResponse(
    {
      id: "chatcmpl-6459",
      model: "auto/claude-opus",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_6459",
                type: "function",
                function: { name: "AskUserQuestion", arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    state
  );

  // Non-conformant upstream: the FULL arguments value arrives as an already-
  // parsed JS object (mirroring a nested tool_use.input structure), not a
  // JSON-encoded string fragment.
  const chunk2 = openaiToClaudeResponse(
    {
      id: "chatcmpl-6459",
      model: "auto/claude-opus",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: {
                    questions: [
                      { header: "Deploy target", options: [{ label: "staging" }] },
                      { header: "Confirm rollback", options: [{ label: "yes" }, { label: "no" }] },
                    ],
                  },
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    state
  );

  const events = flatten([chunk1, chunk2]) as Array<Record<string, unknown>>;
  const assembled = assembleToolUseInput(events);

  assert.ok(assembled.length > 0, "expected at least one input_json_delta with the tool args");
  assert.ok(
    !assembled.includes("[object Object]"),
    `assembled partial_json leaked a stringified-object coercion: ${assembled}`
  );

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(assembled);
  } catch {
    assert.fail(`assembled partial_json is not valid JSON — arguments object was corrupted: ${assembled}`);
  }

  assert.ok(Array.isArray(parsed.questions), "questions array must survive as structured data");
  assert.equal(parsed.questions.length, 2);
  assert.equal((parsed.questions[0] as Record<string, unknown>).header, "Deploy target");
  assert.equal((parsed.questions[1] as Record<string, unknown>).header, "Confirm rollback");
});

test("#6459 no-regression: a plain text-only turn still translates normally", () => {
  const state = createState();

  const chunk1 = openaiToClaudeResponse(
    {
      id: "chatcmpl-6459-text",
      model: "auto/claude-opus",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    state
  );
  const chunk2 = openaiToClaudeResponse(
    {
      id: "chatcmpl-6459-text",
      model: "auto/claude-opus",
      choices: [{ index: 0, delta: { content: "Hello, world!" }, finish_reason: null }],
    },
    state
  );
  const chunk3 = openaiToClaudeResponse(
    {
      id: "chatcmpl-6459-text",
      model: "auto/claude-opus",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    state
  );

  const events = flatten([chunk1, chunk2, chunk3]) as Array<Record<string, unknown>>;
  const textDeltas = events.filter(
    (e) => e?.type === "content_block_delta" && (e.delta as Record<string, unknown>)?.type === "text_delta"
  );

  assert.equal(textDeltas.length, 1);
  assert.equal((textDeltas[0].delta as Record<string, unknown>).text, "Hello, world!");
});

// Additional regression for #6459 / Haiku-Mistral: delta.content
// delivered as a non-string object (e.g. already-parsed JSON).
// `openaiToClaudeResponse` must convert it to a string fragment so
// the downstream chain never coerces it into literal `[object Object]`.
test("non-string delta.content is JSON.stringify'ed, never rendered as [object Object]", () => {
  const state = createState();
  const chunk = openaiToClaudeResponse(
    {
      id: "chatcmpl-6459-obj-content",
      model: "auto/claude-haiku",
      choices: [
        {
          index: 0,
          delta: { content: { text: "hello world" } },
          finish_reason: null,
        },
      ],
    },
    state
  );
  const events = flatten([chunk]) as Array<Record<string, unknown>>;
  const textDeltas = events.filter(
    (e) => e?.type === "content_block_delta" && (e.delta as Record<string, unknown>)?.type === "text_delta"
  );
  assert.equal(textDeltas.length, 1, "expected one text_delta for non-string content");
  const emitted = (textDeltas[0].delta as Record<string, unknown>).text as string;
  assert.ok(
    !emitted.includes("[object Object]"),
    `emitted text must not contain literal [object Object], got: ${emitted}`
  );
  assert.ok(
    emitted.includes("hello world"),
    `emitted text must contain the JSON.stringify'd content, got: ${emitted}`
  );
});

// Additional regression for #6459 / Haiku-Mistral: delta.reasoning_content
// delivered as a non-string object — the guard must skip it (or stringify it),
// never emit a thinking_delta containing literal `[object Object]`.
test("non-string delta.reasoning_content never produces [object Object] in thinking_delta", () => {
  const state = createState();
  const chunk = openaiToClaudeResponse(
    {
      id: "chatcmpl-6459-obj-thinking",
      model: "auto/claude-haiku",
      choices: [
        {
          index: 0,
          delta: { reasoning_content: { reasoning: "the-model-output" } },
          finish_reason: null,
        },
      ],
    },
    state
  );
  const events = flatten([chunk]) as Array<Record<string, unknown>>;
  const thinkingDeltas = events.filter(
    (e) => e?.type === "content_block_delta" && (e.delta as Record<string, unknown>)?.type === "thinking_delta"
  );
  if (thinkingDeltas.length > 0) {
    for (const td of thinkingDeltas) {
      const text = (td.delta as Record<string, unknown>).thinking as string;
      assert.ok(
        !text.toLowerCase().includes("[object object]"),
        `thinking_delta must not contain literal [object Object], got: ${text}`
      );
    }
  }
  // If no thinking_delta emitted (because guard skipped non-string reasoning),
  // that is also fine — absence is not a regression.
});

// Additional regression for Mistral/Haiku content-block arrays:
// Mistral Medium 3.5 sometimes emits serialized Anthropic content blocks
// (e.g. [{"type":"thinking","thinking":"..."},{"type":"text","text":"Hello"}])
// as raw text in delta.content. The translator must parse them and emit
// proper structured content_block_* events instead of raw JSON text.
test("serialized Anthropic content block array in delta.content is parsed, not emitted as raw JSON", () => {
  const state = createState();
  const raw = JSON.stringify([
    { type: "thinking", thinking: "let me think..." },
    { type: "text", text: "Hello, world!" },
  ]);
  const chunk = openaiToClaudeResponse(
    {
      id: "chatcmpl-6459-content-blocks",
      model: "mistral/mistral-medium-3-5",
      choices: [{ index: 0, delta: { content: raw }, finish_reason: null }],
    },
    state
  );
  const events = flatten([chunk]) as Array<Record<string, unknown>>;

  // Must NOT contain raw JSON anywhere in emitted deltas
  for (const e of events) {
    const delta = e.delta as Record<string, unknown> | undefined;
    if (delta && (delta.type === "text_delta" || delta.type === "thinking_delta")) {
      const text = (delta.text || delta.thinking || "") as string;
      assert.ok(
        !text.includes('[{"type":"thinking"'),
        `emitted delta must not contain raw JSON content blocks, got: ${text.substring(0, 200)}`
      );
      assert.ok(
        !text.includes('"type":"text"'),
        `emitted delta must not contain raw JSON content blocks, got: ${text.substring(0, 200)}`
      );
    }
  }

  // Must contain a thinking_delta with the thinking text
  const thinkingDeltas = events.filter(
    (e) => e?.type === "content_block_delta" && (e.delta as Record<string, unknown>)?.type === "thinking_delta"
  );
  const allThinking = thinkingDeltas
    .map(t => ((t.delta as Record<string, unknown>).thinking as string) || "")
    .join("");
  assert.ok(
    allThinking.includes("let me think..."),
    `expected thinking text, got: ${allThinking.substring(0, 200)}`
  );

  // Must contain a text_delta with the text
  const textDeltas = events.filter(
    (e) => e?.type === "content_block_delta" && (e.delta as Record<string, unknown>)?.type === "text_delta"
  );
  const allText = textDeltas.map(t => ((t.delta as Record<string, unknown>).text as string) || "").join("");
  assert.ok(allText.includes("Hello, world!"), `expected parsed text, got: ${allText.substring(0, 200)}`);
});

// The content block parser must also handle nested thinking arrays
// like [{"type":"thinking","thinking":[{"type":"text","text":"nested"}]}]
test("serialized content block with nested thinking array is flattened", () => {
  const state = createState();
  const raw = JSON.stringify([
    {
      type: "thinking",
      thinking: [
        { type: "text", text: "step one" },
        { type: "text", text: "step two" },
      ],
    },
  ]);
  const chunk = openaiToClaudeResponse(
    {
      id: "chatcmpl-6459-nested-thinking",
      model: "mistral/mistral-medium-3-5",
      choices: [{ index: 0, delta: { content: raw }, finish_reason: null }],
    },
    state
  );
  const events = flatten([chunk]) as Array<Record<string, unknown>>;
  const thinkingDeltas = events.filter(
    (e) => e?.type === "content_block_delta" && (e.delta as Record<string, unknown>)?.type === "thinking_delta"
  );
  const allThinking = thinkingDeltas
    .map(t => ((t.delta as Record<string, unknown>).thinking as string) || "")
    .join("");
  assert.ok(allThinking.includes("step one"), `expected nested thinking text, got: ${allThinking.substring(0, 200)}`);
  assert.ok(allThinking.includes("step two"), `expected nested thinking text step two, got: ${allThinking.substring(0, 200)}`);
  // No raw JSON
  for (const e of events) {
    const delta = e.delta as Record<string, unknown> | undefined;
    if (delta && (delta.type === "text_delta" || delta.type === "thinking_delta")) {
      const text = (delta.text || delta.thinking || "") as string;
      assert.ok(!text.includes('[{"type":"thinking"'), `raw JSON leaked: ${text.substring(0, 200)}`);
    }
  }
});
