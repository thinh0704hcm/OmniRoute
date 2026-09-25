import test from "node:test";
import assert from "node:assert/strict";

const { wrapChatCompletionJsonAsResponsesSse, maybeWrapForcedNonStreamingResponsesJson } =
  await import("../../open-sse/handlers/chatCore/responsesJsonToSse.ts");

function chatCompletion(content = "hi") {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  };
}

test("wraps non-streaming chat JSON as Responses SSE ending in response.completed", async () => {
  const response = wrapChatCompletionJsonAsResponsesSse(chatCompletion("hello"), {
    "X-OmniRoute-Cache": "MISS",
  });
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.get("X-OmniRoute-Cache"), "MISS");
  const sse = await response.text();
  assert.match(sse, /event: response\.created/);
  assert.match(sse, /event: response\.completed/);
  assert.match(sse, /hello/);
  assert.match(sse, /data: \[DONE\]/);
});

test("injection: returning JSON early for a 200 chat completion goes red", async () => {
  const response = wrapChatCompletionJsonAsResponsesSse(chatCompletion());
  assert.notEqual(response.headers.get("Content-Type"), "application/json");
});

test("maybeWrapForcedNonStreamingResponsesJson keeps JSON when the client did not ask for SSE", async () => {
  const response = maybeWrapForcedNonStreamingResponsesJson({
    clientRequestedResponsesStream: false,
    body: chatCompletion("plain"),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.headers.get("Content-Type"), "application/json");
  const payload = JSON.parse(await response.text());
  assert.equal(payload.choices[0].message.content, "plain");
});

test("maybeWrapForcedNonStreamingResponsesJson wraps JSON when the client asked for SSE", async () => {
  const response = maybeWrapForcedNonStreamingResponsesJson({
    clientRequestedResponsesStream: true,
    body: chatCompletion("stream-me"),
    headers: { "Content-Type": "application/json", "X-OmniRoute-Cache": "MISS" },
  });
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  const sse = await response.text();
  assert.match(sse, /event: response\.completed/);
  assert.match(sse, /stream-me/);
});

test("chatCore stamps clientRequestedResponsesStream before forcing stream:false", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const source = await readFile(
    join(import.meta.dirname, "../../open-sse/handlers/chatCore.ts"),
    "utf-8"
  );
  const stamp = source.indexOf("clientRequestedResponsesStream = true");
  const force = source.indexOf("(body as Record<string, unknown>).stream = false");
  const wrap = source.indexOf("maybeWrapForcedNonStreamingResponsesJson({");
  assert.ok(stamp !== -1, "must stamp the client-requested stream flag");
  assert.ok(force !== -1, "must still force stream:false for the web_search fallback");
  assert.ok(wrap !== -1, "must wrap the non-streaming JSON return");
  assert.ok(stamp < force, "stamp must happen before stream:false");
  assert.ok(wrap > force, "wrap must happen on the non-streaming return after the force");
});

function nativeResponsesCompletion() {
  // Shape of the forced-non-streaming completion native Responses upstreams
  // (e.g. opencode-go serving muse-spark) produce: a completed Response
  // object with `output: [...]` and no `choices`. Codex + web_search fallback
  // hits exactly this shape; returning it as application/json after the early
  // keepalive committed to SSE framed the success as type:error and Codex died
  // with "stream closed before response.completed" while the server logged 200.
  return {
    id: "resp_case",
    object: "response",
    created_at: 1790358998,
    completed_at: 1790359001,
    model: "opencode-go/muse-spark-1.3-contributor-high",
    status: "completed",
    background: false,
    error: null,
    output: [
      {
        id: "rs_case",
        type: "reasoning",
        status: "completed",
        encrypted_content: "ENCRYPTED_BLOB",
        summary: [],
      },
      {
        id: "msg_case",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "HI_OK", annotations: [], logprobs: [] }],
      },
    ],
    usage: {
      input_tokens: 13,
      output_tokens: 196,
      total_tokens: 209,
    },
  };
}

function parseSseEvents(sse) {
  const events = [];
  for (const frame of sse.split("\n\n")) {
    if (!frame.trim()) continue;
    if (frame.trim() === "data: [DONE]") {
      events.push({ event: "[DONE]", data: null });
      continue;
    }
    const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(eventLine, `every non-DONE frame must carry an event line: ${frame.slice(0, 80)}`);
    assert.ok(dataLine, `every event frame must carry a data line: ${frame.slice(0, 80)}`);
    events.push({
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length)),
    });
  }
  return events;
}

test("wraps native Responses-shaped JSON (no choices) as Responses SSE, not application/json", async () => {
  const { wrapChatCompletionJsonAsResponsesSse } =
    await import("../../open-sse/handlers/chatCore/responsesJsonToSse.ts");
  const response = wrapChatCompletionJsonAsResponsesSse(nativeResponsesCompletion(), {
    "X-OmniRoute-Cache": "MISS",
  });
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(response.headers.get("X-OmniRoute-Cache"), "MISS");
  const events = parseSseEvents(await response.text());
  const names = events.map((entry) => entry.event);
  assert.deepEqual(names, [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.output_item.done",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
    "[DONE]",
  ]);
  // Every data payload is discriminated by the same type as its event line,
  // and sequence numbers start at 0 and increase monotonically (live-wire parity).
  let previous = -1;
  for (const entry of events) {
    if (entry.event === "[DONE]") break;
    assert.equal(entry.data.type, entry.event);
    assert.ok(
      Number.isInteger(entry.data.sequence_number) && entry.data.sequence_number > previous,
      `sequence_number must increase monotonically: ${entry.data.sequence_number}`
    );
    previous = entry.data.sequence_number;
  }
  assert.equal(previous >= 0 && events[0].data.sequence_number, 0);
  // The answer and the encrypted reasoning round-trip verbatim.
  const delta = events.find((entry) => entry.event === "response.output_text.delta");
  assert.equal(delta.data.delta, "HI_OK");
  const completed = events.find((entry) => entry.event === "response.completed");
  assert.equal(completed.data.response.output.length, 2);
  assert.equal(completed.data.response.output[1].content[0].text, "HI_OK");
  assert.equal(completed.data.response.output[0].encrypted_content, "ENCRYPTED_BLOB");
});

test("maybeWrap keeps native Responses JSON as JSON when the client did not ask for SSE", async () => {
  const response = maybeWrapForcedNonStreamingResponsesJson({
    clientRequestedResponsesStream: false,
    body: nativeResponsesCompletion(),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.headers.get("Content-Type"), "application/json");
  const payload = JSON.parse(await response.text());
  assert.equal(payload.object, "response");
  assert.equal(payload.output.length, 2);
});

test("maybeWrap converts native Responses JSON to SSE when the client asked for SSE", async () => {
  const response = maybeWrapForcedNonStreamingResponsesJson({
    clientRequestedResponsesStream: true,
    body: nativeResponsesCompletion(),
    headers: { "Content-Type": "application/json" },
  });
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  const sse = await response.text();
  assert.match(sse, /event: response\.completed/);
  assert.match(sse, /HI_OK/);
  assert.match(sse, /ENCRYPTED_BLOB/);
  assert.match(sse, /data: \[DONE\]/);
  // Never an error frame for a successful completion.
  assert.doesNotMatch(sse, /"type":"error"/);
});
