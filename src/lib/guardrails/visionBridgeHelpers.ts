/**
 * Vision Bridge helper functions for image processing.
 */
import { fetchRemoteImage } from "@/shared/network/remoteImageFetch";
import { getRuntimePorts } from "@/lib/runtime/ports";
import { resolveSelfLoopBearer } from "@/shared/middleware/chatBodyAdmission";
import { getBestVisionModel, getFallbackModels, recordLatency } from "./visionBridgeRouter";
/**
 * Provider to environment variable mapping for API key resolution.
 */
const PROVIDER_API_KEY_MAP: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Resolve API key based on model provider (issue #2232).
 *
 * Priority:
 *   1. `explicitKey` argument (caller override)
 *   2. `VISION_BRIDGE_API_KEY` env var — operator-set, takes precedence over
 *      per-provider env vars. Used when the operator wants every vision-bridge
 *      call to go through a single OpenAI-compatible endpoint (e.g.,
 *      OmniRoute itself, OpenRouter, a Gemini-OpenAI-compat URL).
 *   3. Per-provider env var (`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`,
 *      `OPENAI_API_KEY`) based on the `provider/` prefix in the model id.
 *   4. `OPENAI_API_KEY` as final fallback when the prefix is unrecognized.
 *
 * @param model - Model identifier (e.g., "anthropic/claude-3-haiku", "openai/gpt-4o-mini")
 * @param explicitKey - Explicit API key passed as argument (takes precedence)
 * @returns Resolved API key string
 */
export function resolveProviderApiKey(model: string, explicitKey?: string): string {
  if (explicitKey) return explicitKey;
  const isAnthropic = model.startsWith("anthropic/");
  // VISION_BRIDGE_API_KEY only applies to the OpenAI-compatible branch — the
  // Anthropic branch keeps its dedicated key, since the wire format differs.
  if (!isAnthropic) {
    const bridgeKey = (process.env.VISION_BRIDGE_API_KEY || "").trim();
    if (bridgeKey) return bridgeKey;
  }
  const provider = model.includes("/") ? model.split("/")[0] : "";
  const envVar = PROVIDER_API_KEY_MAP[provider] || "OPENAI_API_KEY";
  return process.env[envVar] || "";
}

/**
 * Resolve the OpenAI-compatible base URL for non-Anthropic vision bridge calls
 * (issue #2232).
 *
 * Priority:
 *   1. `VISION_BRIDGE_BASE_URL` env var — operator-set, e.g. point this at
 *      OmniRoute's own `/v1` so the vision model can be any provider
 *      registered in OmniRoute (`google/gemini-2.0-flash`,
 *      `openrouter/...`, etc.) instead of being limited to OpenAI/Anthropic.
 *   2. `OPENAI_API_URL` env var (legacy)
 *   3. OmniRoute self-loop (`http://localhost:20128/v1`) — auto-detected when
 *      the model uses a known OmniRoute-internal provider (e.g. `kr/`, `if/`,
 *      `pol/`, `groq/`, etc.) instead of a direct OpenAI/Anthropic endpoint.
 *   4. `https://api.openai.com/v1` (fallback when the model is `openai/*` or
 *      unprefixed — works only when the operator actually has an OpenAI
 *      account and OPENAI_API_KEY set)
 *
 * @param model - Optional model identifier used to detect non-standard providers
 *                that require OmniRoute self-loop routing.
 */
export function resolveVisionBridgeBaseUrl(model?: string): string {
  const explicit = (process.env.VISION_BRIDGE_BASE_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const legacy = (process.env.OPENAI_API_URL || "").trim();
  if (legacy) return legacy.replace(/\/+$/, "");

  // When the model has a non-standard provider prefix (not openai/ or
  // anthropic/), it can only be resolved through OmniRoute's own router,
  // not through a direct OpenAI/Anthropic endpoint. Use the operator-configured
  // port via OMNIROUTE_PORT / PORT env vars, falling back to the default 20128.
  if (model && model.includes("/")) {
    const provider = model.split("/")[0].toLowerCase();
    if (provider !== "openai" && provider !== "anthropic") {
      const { port } = getRuntimePorts();
      return `http://localhost:${port}/v1`;
    }
  }

  return "https://api.openai.com/v1";
}

export interface ImagePart {
  messageIndex: number;
  partIndex: number;
  imageUrl: string;
  imageType: "image_url" | "image" | "url" | "input_image";
  /**
   * Which top-level request list this image lives in: `messages` (OpenAI chat
   * + Anthropic /v1/messages) or `input` (Responses API).
   */
  listKey: "messages" | "input";
  /**
   * Index path from the message's `content` array down to the image part.
   * `[2]` = messages[i].content[2]; `[1, 0]` = an image nested inside
   * messages[i].content[1].content[0] (e.g. an Anthropic `tool_result`).
   */
  path: number[];
}

export interface RequestMessage {
  role?: string;
  content?: string | RequestContentPart[];
}

export type RequestContentPart =
  | { type: "text"; text: string }
  | { type: "input_text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
    };

/**
 * Max recursion depth when scanning container blocks for nested images. Mirrors
 * the bounded recursion used by the combo capability filter's
 * `valueContainsImagePart` so the vision bridge sees every image the filter
 * would flag, without unbounded recursion on untrusted payloads.
 */
const MAX_IMAGE_NESTING_DEPTH = 8;

/**
 * Extract the image URL from a content part, covering every shape the combo
 * capability filter's `valueContainsImagePart` flags:
 *   - `image_url` / `input_image` keys as either `{ url }` objects or plain
 *     strings (OpenAI chat + Responses API)
 *   - Anthropic `source` blocks (`type: "url"` / `type: "base64"`, plus
 *     `source.media_type` starting with `image/`)
 *   - a bare `{ type: "image", url }` part
 * Returns `null` when the part carries no usable image URL.
 */
function extractImagePartUrl(part: Record<string, unknown>): string | null {
  for (const key of ["image_url", "input_image"]) {
    if (!(key in part)) {
      continue;
    }
    const value = part[key];
    if (typeof value === "string") {
      return value.length > 0 ? value : null;
    }
    if (value && typeof value === "object") {
      const url = (value as { url?: unknown }).url;
      if (typeof url === "string" && url.length > 0) {
        return url;
      }
    }
  }

  const source = part.source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    if (src.type === "url") {
      return typeof src.url === "string" && src.url.length > 0 ? src.url : null;
    }
    if (src.type === "base64" && typeof src.data === "string" && src.data.length > 0) {
      const mediaType =
        typeof src.media_type === "string" && src.media_type ? src.media_type : "image/png";
      return `data:${mediaType};base64,${src.data}`;
    }
    const mediaType = typeof src.media_type === "string" ? src.media_type.toLowerCase() : "";
    if (mediaType.startsWith("image/")) {
      if (typeof src.url === "string" && src.url.length > 0) {
        return src.url;
      }
      if (typeof src.data === "string" && src.data.length > 0) {
        return `data:${src.media_type};base64,${src.data}`;
      }
    }
  }

  if (typeof part.type === "string" && part.type === "image" && typeof part.url === "string") {
    return part.url.length > 0 ? part.url : null;
  }

  return null;
}

function classifyImageType(part: Record<string, unknown>): ImagePart["imageType"] {
  const type = typeof part.type === "string" ? part.type : "";
  if (type === "image") {
    const source = (part.source ?? {}) as { type?: unknown };
    return source.type === "url" ? "url" : "image";
  }
  if (type === "input_image") {
    return "input_image";
  }
  return "image_url";
}

interface ContentScanState {
  messageIndex: number;
  listKey: "messages" | "input";
  path: number[];
}

/**
 * Extract image parts from a messages array.
 * Supports OpenAI image_url format, base64 image format, and Anthropic-style
 * image source blocks with either `source.type: "base64"` or `source.type: "url"`.
 *
 * The URL-source branch mirrors the executor-level handling in
 * `open-sse/executors/commandCode.ts::extractImageUrl` — without it, a
 * Claude-Code-compatible client (e.g. Zoo Code) sending
 * `{ type: "image", source: { type: "url", url } }` was invisible to the
 * vision-bridge guardrail, so the image was silently dropped by a text-only
 * executor instead of being described.
 */
export function extractImageParts(messages: RequestMessage[]): ImagePart[] {
  const results: ImagePart[] = [];
  if (!Array.isArray(messages)) {
    return results;
  }
  scanMessageList(messages, "messages", results);
  return results;
}

/**
 * Extract image parts from a full request body, scanning BOTH top-level lists:
 * `messages` (OpenAI chat + Anthropic /v1/messages) and `input` (Responses API).
 * Recurses into container blocks whose `content` is an array (e.g. Anthropic
 * `tool_result.content`) so images nested inside tool results are detected —
 * previously they were invisible to the bridge while the combo capability
 * filter still flagged them, failing the request closed with "No target in
 * combo … has confirmed vision support".
 */
export function extractImagePartsFromBody(body: Record<string, unknown>): ImagePart[] {
  const results: ImagePart[] = [];
  if (!body || typeof body !== "object") {
    return results;
  }
  if (Array.isArray(body.messages)) {
    scanMessageList(body.messages, "messages", results);
  }
  if (Array.isArray(body.input)) {
    scanMessageList(body.input, "input", results);
  }
  return results;
}

function scanMessageList(
  list: unknown[],
  listKey: "messages" | "input",
  results: ImagePart[]
): void {
  for (let msgIdx = 0; msgIdx < list.length; msgIdx++) {
    const item = list[msgIdx];
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    scanContentArray(content, { messageIndex: msgIdx, listKey, path: [] }, results, 0);
  }
}

function scanContentArray(
  content: unknown[],
  state: ContentScanState,
  results: ImagePart[],
  depth: number
): void {
  if (depth > MAX_IMAGE_NESTING_DEPTH) {
    return;
  }
  for (let partIdx = 0; partIdx < content.length; partIdx++) {
    const part = content[partIdx];
    if (typeof part === "string") {
      // Raw data-URI content part — parity with the combo filter's
      // `typeof value === "string" && value.startsWith("data:image/")`.
      if (part.startsWith("data:image/")) {
        results.push({
          messageIndex: state.messageIndex,
          partIndex: partIdx,
          listKey: state.listKey,
          path: [...state.path, partIdx],
          imageUrl: part,
          imageType: "image_url",
        });
      }
      continue;
    }
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as Record<string, unknown>;
    const imageUrl = extractImagePartUrl(record);
    if (imageUrl !== null) {
      results.push({
        messageIndex: state.messageIndex,
        partIndex: partIdx,
        listKey: state.listKey,
        path: [...state.path, partIdx],
        imageUrl,
        imageType: classifyImageType(record),
      });
      continue;
    }
    const nested = record.content;
    if (Array.isArray(nested)) {
      scanContentArray(nested, { ...state, path: [...state.path, partIdx] }, results, depth + 1);
    }
  }
}

/**
 * Resolve image URL to data URI format for vision model.
 * - HTTP/HTTPS URLs: passed through as-is
 * - Data URIs: passed through as-is
 * - Base64 without media type: assumed PNG
 */
export function resolveImageAsDataUri(imageUrl: string): string {
  if (!imageUrl || typeof imageUrl !== "string") {
    throw new Error("Invalid image URL: must be a non-empty string");
  }

  // Already a data URI
  if (imageUrl.startsWith("data:")) {
    return imageUrl;
  }

  // HTTP/HTTPS URL - vision API will fetch it
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    return imageUrl;
  }

  // Assume it's a base64 string without prefix
  // Add PNG as default media type
  return `data:image/png;base64,${imageUrl}`;
}

async function fetchRemoteImageAsDataUri(imageUrl: string, signal: AbortSignal): Promise<string> {
  const remoteImage = await fetchRemoteImage(imageUrl, { signal });
  const mediaType = remoteImage.contentType.split(";")[0]?.trim() || "image/png";
  return `data:${mediaType};base64,${remoteImage.buffer.toString("base64")}`;
}

async function normalizeVisionImageInput(
  imageInput: string,
  isAnthropic: boolean,
  signal: AbortSignal
): Promise<string> {
  const normalizedImage = resolveImageAsDataUri(imageInput);

  if (
    isAnthropic &&
    (normalizedImage.startsWith("http://") || normalizedImage.startsWith("https://"))
  ) {
    return fetchRemoteImageAsDataUri(normalizedImage, signal);
  }

  return normalizedImage;
}

export interface VisionModelConfig {
  model: string;
  prompt: string;
  timeoutMs: number;
  maxImages: number;
}

/**
 * Call the vision model to get an image description.
 * Supports both OpenAI-compatible and Anthropic API formats.
 * Uses auto-routing to select the fastest available model.
 */
export async function callVisionModel(
  imageDataUri: string,
  config: VisionModelConfig,
  apiKey?: string,
  routerConfig?: Partial<import("./visionBridgeRouter").VisionBridgeRouterConfig>
): Promise<string> {
  // Auto-select the best vision model
  const modelToUse = await getBestVisionModel({
    fixedModel: config.model,
    ...routerConfig,
  });
  // (#8430) When no vision-capable provider has usable credentials on this
  // instance, surface a clear error instead of attempting a describe call that
  // would fail with an opaque auth/serde error upstream.
  if (!modelToUse) {
    throw new Error("No vision-capable provider connected, cannot process image request");
  }
  let lastError: Error | null = null;

  // Try primary model + fallbacks
  const modelsToTry = [modelToUse, ...(await getFallbackModels(modelToUse, routerConfig))];
  const maxAttempts = Math.min(modelsToTry.length, routerConfig?.maxFallbackAttempts ?? 3);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const currentModel = modelsToTry[attempt];
    const attemptStart = Date.now();
    try {
      const result = await callVisionModelSingle(
        imageDataUri,
        { ...config, model: currentModel },
        apiKey
      );
      recordLatency(currentModel, Date.now() - attemptStart, true);
      return result;
    } catch (error) {
      recordLatency(currentModel, Date.now() - attemptStart, false);
      lastError = error instanceof Error ? error : new Error(String(error));
      // Continue to next model on failure
    }
  }

  // All models failed
  throw lastError || new Error("All vision models failed");
}

/**
 * Unwrap the detailed-log/diagnostics envelope that some OmniRoute paths attach
 * to provider responses (`{ _streamed, _format, summary: {...} }`). Returns the
 * inner `summary` object when present, otherwise the value unchanged.
 */
function unwrapVisionSummary(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.summary && typeof record.summary === "object") {
      return record.summary;
    }
  }
  return value;
}

/**
 * Parse a vision-bridge response body that may be:
 *   1. Plain JSON (`{ choices: [...] }` / `{ content: [...] }`)
 *   2. An SSE stream of `data: {...}` lines (forceStream providers, or
 *      OmniRoute's self-loop when the `stream` default kicks in)
 *   3. The `{ _streamed, _format, summary }` diagnostics envelope
 *
 * For SSE input, aggregates `delta.content` / `delta.reasoning_content`
 * (OpenAI-compatible) and `delta.text` (Anthropic-style `content_block_delta`)
 * across all chunks into a single chat.completion-shaped object. Returns `null`
 * when the body yields nothing usable.
 */
function parseSseVisionBody(rawBody: string): unknown {
  const trimmed = String(rawBody || "").trim();
  if (!trimmed) return null;

  // Direct JSON (normal non-stream response).
  try {
    return unwrapVisionSummary(JSON.parse(trimmed));
  } catch {
    // Fall through to SSE aggregation.
  }

  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const anthropicTextParts: string[] = [];
  let sawChoices = false;

  for (const line of trimmed.split(/\r?\n/)) {
    const lineTrimmed = line.trim();
    if (!lineTrimmed.startsWith("data:")) continue;
    const payload = lineTrimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;

    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue; // Ignore malformed lines and keep scanning.
    }
    if (!chunk || typeof chunk !== "object") continue;

    const unwrapped = unwrapVisionSummary(chunk) as Record<string, unknown>;

    // Error-only SSE chunk (`data: {"error":{...}}` with no choices) — surface
    // the upstream message instead of a generic "empty or invalid response".
    if (unwrapped.error != null && !Array.isArray(unwrapped.choices)) {
      const err = unwrapped.error;
      let message = "";
      if (typeof err === "string") {
        message = err;
      } else if (typeof err === "object" && !Array.isArray(err)) {
        message = (err as { message?: unknown }).message
          ? String((err as { message?: unknown }).message)
          : JSON.stringify(err);
      } else {
        message = String(err);
      }
      throw new Error(`Vision API error: ${message}`);
    }

    const choice = (unwrapped.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (choice) sawChoices = true;

    const delta = choice?.delta as Record<string, unknown> | undefined;
    if (typeof delta?.content === "string" && delta.content.length > 0) {
      contentParts.push(delta.content);
    }
    if (typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      reasoningParts.push(delta.reasoning_content);
    }

    // Some providers put a full message (not a delta) in the final chunk.
    const message = choice?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === "string" && message.content.length > 0) {
      contentParts.push(message.content);
    }
    if (typeof message?.reasoning_content === "string" && message.reasoning_content.length > 0) {
      reasoningParts.push(message.reasoning_content);
    }

    // Anthropic-style streaming: `content_block_delta` with `delta.text`.
    if (Array.isArray(unwrapped.content)) {
      for (const block of unwrapped.content as Array<Record<string, unknown>>) {
        if (typeof block?.text === "string" && block.text.length > 0) {
          anthropicTextParts.push(block.text);
        }
      }
    }
  }

  if (
    contentParts.length === 0 &&
    reasoningParts.length === 0 &&
    anthropicTextParts.length === 0 &&
    !sawChoices
  ) {
    return null;
  }

  const content = contentParts.join("").trim();
  const reasoning = reasoningParts.join("").trim();
  const anthropicText = anthropicTextParts.join("").trim();

  if (anthropicText && !content) {
    return { content: [{ type: "text", text: anthropicText }] };
  }

  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  return { choices: [{ message }] };
}

/**
 * Read a vision-model HTTP response body tolerantly: try `json()` first, then
 * fall back to text/SSE parsing. Some OpenAI-compatible backends (including
 * OmniRoute's own self-loop and forceStream providers) reply with a `data:`
 * SSE stream even for `stream: false`, which makes `response.json()` throw
 * `Unexpected token 'd'`.
 */
async function readVisionResponseBody(response: Response): Promise<unknown> {
  try {
    // JSON path — also unwrap the { _streamed, summary } diagnostics envelope
    // that some OmniRoute capture paths attach to provider responses.
    return unwrapVisionSummary(await response.json());
  } catch {
    // Not JSON — attempt SSE / envelope parsing from the raw text.
  }

  let rawText = "";
  try {
    if (typeof (response as Response & { text?: unknown }).text === "function") {
      rawText = await response.text();
    }
  } catch {
    rawText = "";
  }

  const parsed = parseSseVisionBody(rawText);
  if (parsed === null) {
    throw new Error("Vision API returned empty or invalid response");
  }
  return parsed;
}

/**
 * Extract the description text from an OpenAI-compatible vision response.
 * Falls back to `reasoning_content` when `content` is empty — reasoning models
 * (e.g. xiaomi/mimo-v2.5) can exhaust `max_tokens` on chain-of-thought and
 * return `content: null` with a complete analysis in `reasoning_content`.
 */
function extractOpenAICompatibleContent(data: unknown): string {
  const record = data as {
    choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }>;
    error?: { message?: string };
  } | null;

  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Vision API returned invalid response");
  }

  if (record.error) {
    throw new Error(`Vision API error: ${record.error.message || JSON.stringify(record.error)}`);
  }

  const message = record.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content.trim() : "";
  if (content) return content;

  const reasoning =
    typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
  if (reasoning) return reasoning;

  throw new Error("Vision API returned empty or invalid response");
}

/**
 * Internal function to call a single vision model.
 */
async function callVisionModelSingle(
  imageDataUri: string,
  config: VisionModelConfig,
  apiKey?: string
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

  // Resolve API key based on provider
  const resolvedApiKey = resolveProviderApiKey(config.model, apiKey);

  // Detect provider from model identifier
  const isAnthropic = config.model.startsWith("anthropic/");

  try {
    // Extract model name from provider/model format
    const modelName = config.model.includes("/") ? config.model.split("/")[1] : config.model;
    const normalizedImageInput = await normalizeVisionImageInput(
      imageDataUri,
      isAnthropic,
      controller.signal
    );

    let response: Response;

    if (isAnthropic) {
      // Anthropic API path
      const anthropicBaseUrl = process.env.ANTHROPIC_API_URL || "https://api.anthropic.com";

      // Parse data URI to extract media type and base64 data
      const matches = normalizedImageInput.match(/^data:([^;]+);base64,(.+)$/);
      let mediaType = "image/png";
      let base64Data = normalizedImageInput;

      if (matches) {
        mediaType = matches[1];
        base64Data = matches[2];
      }

      response = await fetch(`${anthropicBaseUrl}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "x-api-key": resolvedApiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: modelName,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data: base64Data,
                  },
                },
                {
                  type: "text",
                  text: config.prompt,
                },
              ],
            },
          ],
          max_tokens: 300,
        }),
      });
    } else {
      // OpenAI-compatible path (default) — issue #2232: honor
      // VISION_BRIDGE_BASE_URL so the vision-bridge call can be routed through
      // OmniRoute itself or any other OpenAI-compatible endpoint instead of
      // hardcoded api.openai.com.
      const baseUrl = resolveVisionBridgeBaseUrl(config.model);

      // When routing through the OmniRoute self-loop (non-standard provider),
      // keep the full provider-prefixed model ID so OmniRoute can resolve the
      // correct provider backend. Only strip the prefix for direct OpenAI calls.
      const useFullModelId =
        baseUrl.startsWith("http://localhost") &&
        config.model.includes("/") &&
        !config.model.startsWith("openai/");
      const requestModel = useFullModelId ? config.model : modelName;

      // Build headers with optional recursion guard for self-loop calls.
      // When routing through OmniRoute's own API, omit the vision-bridge
      // guardrail on the sub-request to prevent infinite recursion.
      // Use sk_omniroute as fallback for self-loop if no API key is resolved.
      const selfLoopApiKey = resolvedApiKey || "sk_omniroute";
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        // Explicit JSON opt-in: without `Accept: application/json` OmniRoute's
        // self-loop defaults to SSE (resolveStreamFlag's legacy default) and the
        // describe call would receive a `data:` stream that response.json() can't
        // parse (`Unexpected token 'd'`), failing the whole vision-bridge
        // describe path. Pair with `stream: false` below.
        Accept: "application/json",
        Authorization: `Bearer ${selfLoopApiKey}`,
      };
      if (useFullModelId) {
        headers["x-omniroute-disabled-guardrails"] = "vision-bridge";
        // Internal self-loop sub-request: the parent request already holds the
        // single heavyweight admission lease (`CHAT_MAX_HEAVY_IN_FLIGHT=1`), so a
        // large base64-image describe body would be rejected with 503
        // `chat_admission_busy` before it is described. The route only honors
        // this header for trusted self-loop credentials (the local
        // `sk_omniroute` sentinel OR the operator-configured env key), so
        // external clients cannot use it to bypass admission.
        headers["x-omniroute-admission-bypass"] = "internal";
        // The admission bypass honors the env key when set (REQUIRE_API_KEY=true
        // deployments) and the `sk_omniroute` sentinel otherwise. Force the same
        // resolved credential so the bypass holds even when a real vision key is
        // configured for the vision model's provider.
        headers["Authorization"] = `Bearer ${resolveSelfLoopBearer()}`;
      }

      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify({
          model: requestModel,
          // Explicit non-stream: OmniRoute's resolveStreamFlag otherwise defaults
          // an absent `stream` to true for OpenAI-format self-loop calls, which
          // turns the describe response into an SSE stream (the root cause of
          // the "is not valid JSON" failure observed with cmd/xiaomi/mimo-v2.5).
          stream: false,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: normalizedImageInput,
                    detail: "low",
                  },
                },
                { type: "text", text: config.prompt },
              ],
            },
          ],
          max_tokens: 300,
        }),
      });
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Vision API error ${response.status}: ${errorText}`);
    }

    const data = await readVisionResponseBody(response);

    if (isAnthropic) {
      // Anthropic response format: { content: [{ type: "text", text: "..." }] }
      const anthropicData = data as {
        content?: Array<{ type?: string; text?: string }>;
        error?: { message?: string };
      };

      if (anthropicData.error) {
        throw new Error(
          `Vision API error: ${anthropicData.error.message || JSON.stringify(anthropicData.error)}`
        );
      }

      const textContent = anthropicData.content?.find((c) => c.type === "text");
      const content = textContent?.text;
      if (!content || typeof content !== "string") {
        throw new Error("Vision API returned empty or invalid response");
      }

      return content.trim();
    } else {
      // OpenAI-compatible response format. Falls back to reasoning_content when
      // content is null — reasoning models (e.g. xiaomi/mimo-v2.5) can exhaust
      // max_tokens on chain-of-thought and return content: null with the full
      // analysis in reasoning_content.
      return extractOpenAICompatibleContent(data);
    }
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Vision model call timed out");
    }

    throw error;
  }
}

export interface RequestBody {
  model?: string;
  messages?: RequestMessage[];
  input?: unknown;
  [key: string]: unknown;
}

/**
 * Replace image content parts with text descriptions.
 * Concatenates descriptions with labels: "[Image 1]: ..."
 *
 * Scans both `messages` (OpenAI chat + Anthropic) and `input` (Responses API)
 * lists, recursing into container blocks (e.g. Anthropic `tool_result.content`)
 * so nested images are replaced at the same spot they were extracted from.
 * Replacement order follows the extraction order so descriptions line up.
 */
export function replaceImageParts(
  body: RequestBody,
  // #4012: a `null` entry means the describe call failed for that image — keep
  // the original image part instead of dropping it / stubbing "(unavailable)".
  descriptions: (string | null)[]
): RequestBody {
  if (!descriptions || descriptions.length === 0) {
    return body;
  }

  const result = structuredClone(body) as RequestBody;

  const counter = { index: 0 };

  if (Array.isArray(result.messages)) {
    replaceListImages(result.messages, "messages", descriptions, counter);
  }
  if (Array.isArray(result.input)) {
    replaceListImages(result.input as unknown[], "input", descriptions, counter);
  }

  return result;
}

function replaceListImages(
  list: unknown[],
  listKey: "messages" | "input",
  descriptions: (string | null)[],
  counter: { index: number }
): void {
  for (const item of list) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    replaceContentArray(content, listKey, descriptions, counter, 0);
  }
}

function replaceContentArray(
  content: unknown[],
  listKey: "messages" | "input",
  descriptions: (string | null)[],
  counter: { index: number },
  depth: number
): void {
  if (depth > MAX_IMAGE_NESTING_DEPTH) {
    return;
  }
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (typeof part === "string") {
      if (part.startsWith("data:image/")) {
        const description = descriptions[counter.index];
        counter.index++;
        if (description != null) {
          content[i] = buildTextReplacement(listKey, description);
        }
      }
      continue;
    }
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (extractImagePartUrl(record) !== null) {
      const description = descriptions[counter.index];
      counter.index++;
      if (description != null) {
        content[i] = buildTextReplacement(listKey, description);
      }
      continue;
    }
    const nested = record.content;
    if (Array.isArray(nested)) {
      replaceContentArray(nested, listKey, descriptions, counter, depth + 1);
    }
  }
}

function buildTextReplacement(
  listKey: "messages" | "input",
  description: string
): RequestContentPart {
  if (listKey === "input") {
    return { type: "input_text", text: description };
  }
  return { type: "text", text: description };
}
