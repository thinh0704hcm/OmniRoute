/**
 * Muse web_search response envelope.
 *
 * Reverse-engineered from the muse binary's web_search validator and
 * confirmed by live probes: the ONLY accepted shape is
 *
 *   { query, results: [{ url, title, snippet, page_last_modified }] }
 *
 * where page_last_modified is REQUIRED and must be a unix epoch SECONDS
 * number (ISO strings, null, and absent fields are all rejected with
 * "web_search result has an invalid field"), url is required, and unknown
 * keys are ignored. The top-level query key is harmless (kept — it matches
 * the binary's ClientWebSearchOutput{query,results} struct).
 *
 * Source dates come from the provider schema: published_at first, then
 * citation.retrieved_at, then now() — so the field is ALWAYS a number.
 */

export interface MuseSearchItem {
  url: string;
  title: string;
  snippet: string;
  /** Unix epoch seconds. Always numeric — never null, never a string. */
  page_last_modified: number;
}

export interface MuseSearchEnvelope {
  query: string;
  results: MuseSearchItem[];
}

interface ProviderSearchItem {
  url?: unknown;
  link?: unknown;
  title?: unknown;
  snippet?: unknown;
  published_at?: unknown;
  citation?: { retrieved_at?: unknown } | null;
}

export function toEpochSecs(v: unknown, fallback: number): number {
  // Some providers return a raw epoch (seconds, or millis); the provider
  // schema usually carries ISO strings, which Date.parse handles.
  if (typeof v === "number" && Number.isFinite(v)) {
    return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  }
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? Math.floor(t / 1000) : fallback;
}

export function toMuseSearchEnvelope(
  query: string,
  items: ProviderSearchItem[],
  maxResults = 5,
  nowSecs = Math.floor(Date.now() / 1000)
): MuseSearchEnvelope {
  const count = Math.min(Math.max(Math.floor(maxResults) || 5, 1), 10);
  return {
    query,
    results: (items ?? []).slice(0, count).map((it) => ({
      url: String(it.url ?? it.link ?? ""),
      title: String(it.title ?? ""),
      snippet: String(it.snippet ?? ""),
      page_last_modified: toEpochSecs(it.published_at ?? it?.citation?.retrieved_at, nowSecs),
    })),
  };
}
