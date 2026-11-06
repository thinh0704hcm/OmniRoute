/**
 * POST /api/v1/muse-code/search — web search in the muse-native envelope.
 *
 * The muse binary only accepts { query, results: [{ url, title, snippet,
 * page_last_modified: <epoch seconds number> }] } (see envelope.ts). This
 * route executes a standard /v1/search internally — reusing auth, provider
 * failover, cache, and cost attribution — then reshapes the response.
 *
 * Replaces ~/.local/share/muse-shim/shim.mjs /muse-code/search. Request and
 * error shapes are shim-identical so the binary's behavior is unchanged.
 */

import { toMuseSearchEnvelope } from "./envelope.ts";
import * as log from "@/sse/utils/logger";
import { saveCallLog } from "@/lib/usageDb";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const DEFAULT_MAX_RESULTS = 5;
const INTERNAL_TIMEOUT_MS = 30_000;

export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function POST(request: Request) {
  const requestStartTime = Date.now();
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "web_search query must not be empty" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const q = String((rawBody as { query?: unknown })?.query ?? "");
  if (!q.trim()) {
    return new Response(JSON.stringify({ error: "web_search query must not be empty" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  const maxResults = Number((rawBody as { max_results?: unknown })?.max_results);
  const count = Number.isFinite(maxResults) ? maxResults : DEFAULT_MAX_RESULTS;

  // Internal execution via /v1/search: forward the caller's auth so quota and
  // cost attribute to their key. Never log headers or keys — query slice only.
  let upstream: any;
  try {
    const res = await fetch(new URL("/v1/search", request.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Forward exactly one auth header; never log it.
        ...(request.headers.get("authorization")
          ? { authorization: request.headers.get("authorization") as string }
          : {}),
      },
      body: JSON.stringify({ query: q, max_results: count }),
      signal: AbortSignal.timeout(INTERNAL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`search status ${res.status}`);
    upstream = await res.json();
  } catch (e: any) {
    log.warn("MUSE_SEARCH", `upstream failed q=${q.slice(0, 80)} err=${e?.message ?? e}`);
    return new Response(JSON.stringify({ error: "web_search failed" }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const envelope = toMuseSearchEnvelope(q, upstream.results ?? [], count);

  log.info(
    "MUSE_SEARCH",
    `q=${q.slice(0, 80)} n=${envelope.results.length} ms=${Date.now() - requestStartTime}`
  );
  saveCallLog({
    method: "POST",
    path: "/api/v1/muse-code/search",
    status: 200,
    requestType: "search",
    duration: Date.now() - requestStartTime,
    requestBody: { query: q.slice(0, 200), max_results: count },
    responseBody: { results_count: envelope.results.length },
  }).catch(() => {
    /* non-critical — logging must not block search response */
  });

  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
