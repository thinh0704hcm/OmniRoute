/**
 * #13033: when chatCore forces stream:false so a server-side web_search
 * fallback can run, the client that asked for Responses SSE still needs
 * `event: response.completed`. Reuse synthesizeOpenAiSseFromJson +
 * createResponsesApiTransformStream.
 *
 * Follow-up: the forced-non-streaming completion is not always Chat-shaped.
 * Native Responses upstreams (e.g. opencode-go serving muse-spark) return a
 * completed Response object (`output: [...]`, no `choices`), which
 * synthesizeOpenAiSseFromJson rejects with "" — the caller then fell back to
 * application/json AFTER the route's early keepalive had already committed to
 * HTTP 200 text/event-stream, so the keepalive wrapper framed the successful
 * answer as `data: {"type":"error",...}` and Codex failed with "stream closed
 * before response.completed" while the server logged 200. Responses-shaped
 * completions are now synthesized directly to Responses SSE (output items
 * round-trip verbatim, including encrypted reasoning), preserving the SSE
 * contract for stream:true Responses clients.
 */
import { createResponsesApiTransformStream } from "../../transformer/responsesTransformer.ts";
import { synthesizeOpenAiSseFromJson } from "../../utils/jsonToSse.ts";
import { buildNonStreamingJsonResponse } from "./nonStreamingJsonResponse.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyForwardHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "content-type" || lower === "content-length") continue;
    out[key] = value;
  }
  return out;
}

/**
 * True when the completion is a Responses API object (`output: [...]`) rather
 * than a Chat Completions object (`choices: [...]`). A payload carrying a
 * non-empty `choices` array keeps the legacy Chat synthesis path, even if it
 * also carries an `output` field, so existing behavior is unchanged.
 */
function isResponsesCompletion(completion: JsonRecord): boolean {
  if (Array.isArray(completion.choices) && completion.choices.length > 0) return false;
  return Array.isArray(completion.output);
}

function responsesSseEvent(type: string, data: JsonRecord): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function itemId(item: JsonRecord, outputIndex: number): string {
  return typeof item.id === "string" && item.id ? item.id : `item_${outputIndex}`;
}

function messageTextParts(item: JsonRecord): { part: JsonRecord; text: string }[] {
  const content = item.content;
  if (!Array.isArray(content)) return [];
  const parts: { part: JsonRecord; text: string }[] = [];
  for (const entry of content) {
    if (!isRecord(entry)) continue;
    if (entry.type !== "output_text") continue;
    if (typeof entry.text !== "string" || entry.text.length === 0) continue;
    parts.push({ part: entry, text: entry.text });
  }
  return parts;
}

function reasoningSummaryText(item: JsonRecord): string {
  const summary = item.summary;
  if (!Array.isArray(summary)) return "";
  let text = "";
  for (const entry of summary) {
    if (isRecord(entry) && entry.type === "summary_text" && typeof entry.text === "string") {
      text += entry.text;
    }
  }
  return text;
}

/**
 * Synthesize a complete Responses SSE stream (created → in_progress → output
 * items → completed → [DONE]) from a completed Response JSON object. Event
 * names, field shapes, and sequence numbering mirror
 * createResponsesApiTransformStream's live `emit`, so stream:true clients
 * (notably Codex, which requires response.completed) cannot distinguish this
 * from a real-time stream. Output items round-trip verbatim — including
 * encrypted-only reasoning, which has no Chat-SSE equivalent.
 */
export function synthesizeResponsesSseFromJson(completion: JsonRecord): string {
  if (!isResponsesCompletion(completion)) return "";
  const items: unknown[] = Array.isArray(completion.output) ? completion.output : [];
  let seq = 0;
  const nextSeq = (): number => seq++;
  let out = "";

  const inProgressSnapshot: JsonRecord = {
    ...completion,
    status: "in_progress",
    output: [],
  };
  if (Object.hasOwn(inProgressSnapshot, "completed_at")) {
    // JSON.stringify drops undefined values, so the key disappears from the
    // created/in_progress snapshots without a `delete` (which will not
    // type-check against this record shape).
    inProgressSnapshot.completed_at = undefined;
  }
  out += responsesSseEvent("response.created", {
    type: "response.created",
    sequence_number: nextSeq(),
    response: inProgressSnapshot,
  });
  out += responsesSseEvent("response.in_progress", {
    type: "response.in_progress",
    sequence_number: nextSeq(),
    response: inProgressSnapshot,
  });

  items.forEach((rawItem, outputIndex) => {
    if (!isRecord(rawItem)) return;
    const item = rawItem;
    const id = itemId(item, outputIndex);
    out += responsesSseEvent("response.output_item.added", {
      type: "response.output_item.added",
      sequence_number: nextSeq(),
      output_index: outputIndex,
      item,
    });

    if (item.type === "message") {
      let contentIndex = 0;
      for (const { part, text } of messageTextParts(item)) {
        out += responsesSseEvent("response.content_part.added", {
          type: "response.content_part.added",
          sequence_number: nextSeq(),
          item_id: id,
          output_index: outputIndex,
          content_index: contentIndex,
          part: { type: "output_text", annotations: [], logprobs: [], text: "" },
        });
        out += responsesSseEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          sequence_number: nextSeq(),
          item_id: id,
          output_index: outputIndex,
          content_index: contentIndex,
          delta: text,
          logprobs: [],
        });
        out += responsesSseEvent("response.output_text.done", {
          type: "response.output_text.done",
          sequence_number: nextSeq(),
          item_id: id,
          output_index: outputIndex,
          content_index: contentIndex,
          text,
          logprobs: [],
        });
        out += responsesSseEvent("response.content_part.done", {
          type: "response.content_part.done",
          sequence_number: nextSeq(),
          item_id: id,
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
        contentIndex += 1;
      }
    } else if (item.type === "reasoning") {
      const summaryText = reasoningSummaryText(item);
      if (summaryText) {
        out += responsesSseEvent("response.reasoning_summary_part.added", {
          type: "response.reasoning_summary_part.added",
          sequence_number: nextSeq(),
          item_id: id,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        });
        out += responsesSseEvent("response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          sequence_number: nextSeq(),
          item_id: id,
          output_index: outputIndex,
          summary_index: 0,
          delta: summaryText,
        });
        out += responsesSseEvent("response.reasoning_summary_text.done", {
          type: "response.reasoning_summary_text.done",
          sequence_number: nextSeq(),
          item_id: id,
          output_index: outputIndex,
          summary_index: 0,
          text: summaryText,
        });
        out += responsesSseEvent("response.reasoning_summary_part.done", {
          type: "response.reasoning_summary_part.done",
          sequence_number: nextSeq(),
          item_id: id,
          output_index: outputIndex,
          summary_index: 0,
          part: { type: "summary_text", text: summaryText },
        });
      }
    } else if (item.type === "function_call") {
      const args = typeof item.arguments === "string" ? item.arguments : "";
      if (args) {
        out += responsesSseEvent("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          sequence_number: nextSeq(),
          item_id: id,
          output_index: outputIndex,
          delta: args,
        });
        out += responsesSseEvent("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          sequence_number: nextSeq(),
          item_id: id,
          output_index: outputIndex,
          arguments: args,
        });
      }
    } else if (item.type === "custom_tool_call") {
      const input = typeof item.input === "string" ? item.input : "";
      if (input) {
        out += responsesSseEvent("response.custom_tool_call_input.delta", {
          type: "response.custom_tool_call_input.delta",
          sequence_number: nextSeq(),
          item_id: id,
          output_index: outputIndex,
          delta: input,
        });
        out += responsesSseEvent("response.custom_tool_call_input.done", {
          type: "response.custom_tool_call_input.done",
          sequence_number: nextSeq(),
          item_id: id,
          output_index: outputIndex,
          input,
        });
      }
    }

    out += responsesSseEvent("response.output_item.done", {
      type: "response.output_item.done",
      sequence_number: nextSeq(),
      output_index: outputIndex,
      item,
    });
  });

  out += responsesSseEvent("response.completed", {
    type: "response.completed",
    sequence_number: nextSeq(),
    response: completion,
  });
  out += "data: [DONE]\n\n";
  return out;
}

export function wrapChatCompletionJsonAsResponsesSse(
  completion: Record<string, unknown>,
  headers?: Record<string, string>
): Response {
  if (isResponsesCompletion(completion)) {
    const directSse = synthesizeResponsesSseFromJson(completion);
    if (directSse) {
      return new Response(directSse, {
        status: 200,
        headers: {
          ...copyForwardHeaders(headers),
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...copyForwardHeaders(headers),
      },
    });
  }
  const rawSse = synthesizeOpenAiSseFromJson(JSON.stringify(completion));
  if (!rawSse) {
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...copyForwardHeaders(headers),
      },
    });
  }
  const encoder = new TextEncoder();
  const inputStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(rawSse));
      controller.close();
    },
  });
  const outputStream = inputStream.pipeThrough(createResponsesApiTransformStream());
  return new Response(outputStream, {
    status: 200,
    headers: {
      ...copyForwardHeaders(headers),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function maybeWrapForcedNonStreamingResponsesJson(args: {
  clientRequestedResponsesStream: boolean;
  body: unknown;
  headers: Record<string, string>;
}): Response {
  const { clientRequestedResponsesStream, body, headers } = args;
  if (!clientRequestedResponsesStream || !body || typeof body !== "object" || Array.isArray(body)) {
    return buildNonStreamingJsonResponse(body, headers);
  }
  return wrapChatCompletionJsonAsResponsesSse(body as Record<string, unknown>, headers);
}
