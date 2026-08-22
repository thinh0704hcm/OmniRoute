type JsonRecord = Record<string, unknown>;

const TOOL_CALLS_MARKER = "<tool_calls:";
const STREAM_ARGUMENT_BUFFER_LIMIT = 256 * 1024;
const XML_ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeXmlEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(XML_ENTITY_RE, (entity) => {
    switch (entity) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default: {
        const numeric = /^&#(x[0-9a-fA-F]+|\d+);$/.exec(entity)?.[1];
        if (!numeric) return entity;
        const codePoint = numeric.startsWith("x")
          ? Number.parseInt(numeric.slice(1), 16)
          : Number.parseInt(numeric, 10);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
    }
  });
}

/**
 * Convert Tencent/Hunyuan's tagged XML argument wrapper into the JSON string
 * required by the OpenAI tool-call contract. Returns null for valid JSON and
 * unrelated/incomplete input so callers can preserve it exactly.
 */
export function normalizeXmlToolCallArgs(args: unknown): string | null {
  if (typeof args !== "string") return null;
  const trimmed = args.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return null;
    } catch {
      // Continue only if a tagged wrapper appears later in the value.
    }
  }

  const wrapperStart = trimmed.indexOf(TOOL_CALLS_MARKER);
  if (wrapperStart < 0) return null;
  const wrapper = trimmed.slice(wrapperStart);
  const tag = /^<tool_calls:([A-Za-z0-9_-]{1,64})>/.exec(wrapper)?.[1];
  if (!tag) return null;

  const bodyPattern = new RegExp(
    `^<tool_calls:${tag}>\\s*<tool_call:${tag}>([\\s\\S]*?)<tool_sep:${tag}>\\s*([\\s\\S]*?)</tool_call:${tag}>\\s*</tool_calls:${tag}>\\s*$`
  );
  const body = bodyPattern.exec(wrapper);
  if (!body || !decodeXmlEntities(body[1].trim())) return null;

  const argumentsObject = Object.create(null) as Record<string, string>;
  const pairPattern = new RegExp(
    `<arg_key:${tag}>([\\s\\S]*?)</arg_key:${tag}>\\s*<arg_value:${tag}>([\\s\\S]*?)</arg_value:${tag}>`,
    "g"
  );
  let pair: RegExpExecArray | null;
  while ((pair = pairPattern.exec(body[2])) !== null) {
    const key = decodeXmlEntities(pair[1].trim());
    if (!key) continue;
    argumentsObject[key] = decodeXmlEntities(pair[2].trim());
  }

  return Object.keys(argumentsObject).length > 0 ? JSON.stringify(argumentsObject) : null;
}

export function normalizeOpenAIBodyToolCallArgs(body: unknown): {
  changed: boolean;
  body: unknown;
} {
  if (!isRecord(body) || !Array.isArray(body.choices)) return { changed: false, body };

  let changed = false;
  const choices = body.choices.map((choice) => {
    if (
      !isRecord(choice) ||
      !isRecord(choice.message) ||
      !Array.isArray(choice.message.tool_calls)
    ) {
      return choice;
    }

    let messageChanged = false;
    const toolCalls = choice.message.tool_calls.map((toolCall) => {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) return toolCall;
      const normalized = normalizeXmlToolCallArgs(toolCall.function.arguments);
      if (normalized === null) return toolCall;
      changed = true;
      messageChanged = true;
      return {
        ...toolCall,
        function: { ...toolCall.function, arguments: normalized },
      };
    });

    if (!messageChanged) return choice;
    return {
      ...choice,
      message: { ...choice.message, tool_calls: toolCalls },
    };
  });

  return changed ? { changed: true, body: { ...body, choices } } : { changed: false, body };
}

type StreamBufferMode = "detecting" | "passthrough" | "xml";

interface StreamBufferState {
  mode: StreamBufferMode;
  buffer: string;
}

export interface BufferedToolCallArguments {
  key: string;
  arguments: string;
  normalized: boolean;
}

export interface ToolCallArgumentPushResult {
  arguments: string;
  changed: boolean;
}

/**
 * Request-local buffer for fragmented OpenAI tool arguments. Valid JSON begins
 * streaming immediately. Non-JSON fragments are held until they either reveal
 * the Tencent XML marker or reach the terminal drain, preventing partial XML
 * from leaking while preserving unrelated non-JSON arguments byte-for-byte.
 */
export class OpenAIToolCallArgumentStreamBuffer {
  private readonly states = new Map<string, StreamBufferState>();

  push(key: string, fragment: string): ToolCallArgumentPushResult {
    const prior = this.states.get(key);
    if (prior?.mode === "passthrough") return { arguments: fragment, changed: false };

    const combined = `${prior?.buffer ?? ""}${fragment}`;
    if (combined.includes(TOOL_CALLS_MARKER)) {
      this.states.set(key, { mode: "xml", buffer: combined });
      return { arguments: "", changed: true };
    }

    const trimmed = combined.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      this.states.set(key, { mode: "passthrough", buffer: "" });
      return { arguments: combined, changed: prior !== undefined };
    }

    if (combined.length > STREAM_ARGUMENT_BUFFER_LIMIT) {
      this.states.set(key, { mode: "passthrough", buffer: "" });
      return { arguments: combined, changed: prior !== undefined };
    }

    this.states.set(key, { mode: prior?.mode ?? "detecting", buffer: combined });
    return { arguments: "", changed: true };
  }

  drain(): BufferedToolCallArguments[] {
    const buffered: BufferedToolCallArguments[] = [];
    for (const [key, state] of this.states) {
      if (!state.buffer) continue;
      const normalized = normalizeXmlToolCallArgs(state.buffer);
      buffered.push({
        key,
        arguments: normalized ?? state.buffer,
        normalized: normalized !== null,
      });
    }
    this.states.clear();
    return buffered;
  }
}
