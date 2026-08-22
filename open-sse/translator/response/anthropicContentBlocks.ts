type JsonRecord = Record<string, unknown>;

export type DecodedAnthropicContentBlock =
  { type: "thinking"; text: string } | { type: "text"; text: string };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nestedText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;

  const parts: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return null;
    parts.push(item.text);
  }
  return parts.join("");
}

function parseStructuredValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("[") || trimmed.startsWith("{"))) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

/**
 * Decode Anthropic content blocks accidentally returned through an OpenAI
 * `delta.content` field. The value may already be structured or may be a JSON
 * serialization of the block array. Unsupported/mixed shapes return null so
 * callers can preserve them as ordinary content instead of dropping data.
 */
export function decodeAnthropicContentBlocks(
  value: unknown
): DecodedAnthropicContentBlock[] | null {
  const parsed = parseStructuredValue(value);
  const candidates = Array.isArray(parsed) ? parsed : isRecord(parsed) ? [parsed] : null;
  if (!candidates || candidates.length === 0) return null;

  const decoded: DecodedAnthropicContentBlock[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) return null;

    if (candidate.type === "text") {
      if (typeof candidate.text !== "string") return null;
      if (candidate.text) decoded.push({ type: "text", text: candidate.text });
      continue;
    }

    if (candidate.type === "thinking") {
      const text = nestedText(candidate.thinking);
      if (text === null) return null;
      if (text) decoded.push({ type: "thinking", text });
      continue;
    }

    return null;
  }

  return decoded.length > 0 ? decoded : null;
}

/** Convert a non-string OpenAI content delta without JS's `[object Object]` coercion. */
export function serializeOpenAIContentDelta(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
