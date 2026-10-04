/**
 * POST /api/v1/muse-code/search — web_search backend for Meta's `muse` CLI.
 * (served at /muse-code/search via rewrite.)
 *
 * Delegates to the full /v1/search pipeline (policy, failover, cache,
 * cost logging) and narrows the response to the shape `muse` accepts:
 * `{ results: [{ title, url, snippet }] }` (confirmed live 2026-10-04).
 * Error responses pass through unchanged so clients see real statuses.
 */
import { POST as v1SearchPost } from "../../search/route.ts";
import { toMuseCodeSearchShape } from "@omniroute/open-sse/handlers/museCode.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { z } from "zod";
import {
  formatValidationMessage,
  isValidationFailure,
  validateBody,
} from "@/shared/validation/helpers";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

const museCodeSearchSchema = z.object({
  query: z.string().min(1).max(2000),
  max_results: z.number().int().min(1).max(10).optional(),
});

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }
  // `muse` sends extra fields (request_id, iteration_index, ...); strip them.
  const validation = validateBody(museCodeSearchSchema.passthrough(), rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, formatValidationMessage(validation.error));
  }
  const query = validation.data.query.trim();
  if (!query) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "web_search query must not be empty");
  }

  const upstream = await v1SearchPost(
    new Request("http://localhost/api/v1/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: request.headers.get("authorization") ?? "",
      },
      body: JSON.stringify({
        query,
        max_results: validation.data.max_results ?? 5,
        search_type: "general",
      }),
    }) as any
  );
  if (upstream.status !== 200) return upstream;
  const data = await upstream.json().catch(() => null);
  if (!data || !Array.isArray(data.results)) {
    return errorResponse(HTTP_STATUS.BAD_GATEWAY, "web_search failed");
  }
  return new Response(JSON.stringify(toMuseCodeSearchShape(data.results)), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
