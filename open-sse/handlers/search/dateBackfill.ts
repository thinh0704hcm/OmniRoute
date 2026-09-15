import { parseAndValidateNonMetadataUrl } from "@/shared/network/outboundUrlGuard";
import type { SearchResult } from "../search.ts";
import { normalizePublishedAt } from "./publishedAt.ts";

const MAX_URLS = 5;
const PER_URL_MS = 3_000;
const FETCH_CONCURRENCY = 2;
const RANGE_BYTES = 16_384;

const META_PATTERNS = [
  /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
  /<meta[^>]+property=["']og:published_time["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:published_time["']/i,
  /<meta[^>]+name=["']date["'][^>]+content=["']([^"']+)["']/i,
  /<time[^>]+datetime=["']([^"']+)["']/i,
];

const JSONLD_PATTERN = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function extractJsonLdDate(html: string): string | null {
  JSONLD_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = JSONLD_PATTERN.exec(html)) !== null) {
    try {
      const parsed: unknown = JSON.parse(match[1]);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        if (candidate && typeof candidate === "object") {
          const record = candidate as Record<string, unknown>;
          for (const key of ["datePublished", "dateCreated", "uploadDate"]) {
            const normalized = normalizePublishedAt(record[key]);
            if (normalized) return normalized;
          }
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function extractMetaDate(html: string): string | null {
  for (const pattern of META_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(html);
    if (match?.[1]) {
      const normalized = normalizePublishedAt(match[1]);
      if (normalized) return normalized;
    }
  }
  return extractJsonLdDate(html);
}

async function fetchHead(url: string, signal: AbortSignal): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_URL_MS);
  const onAbort = () => controller.abort();
  if (signal.aborted) {
    clearTimeout(timer);
    return null;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${RANGE_BYTES}`, Accept: "text/html" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const text = await response.text();
    return extractMetaDate(text.slice(0, RANGE_BYTES * 2));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export async function backfillPublishedAt(
  results: SearchResult[],
  options: { signal?: AbortSignal } = {}
): Promise<SearchResult[]> {
  const signal = options.signal;
  if (signal?.aborted) return results;
  const targets = results
    .map((hit, index) => ({ hit, index }))
    .filter(({ hit }) => !hit.published_at && typeof hit.url === "string" && hit.url.length > 0)
    .slice(0, MAX_URLS);
  if (targets.length === 0) return results;

  const out = [...results];
  for (let start = 0; start < targets.length; start += FETCH_CONCURRENCY) {
    if (signal?.aborted) break;
    const batch = targets.slice(start, start + FETCH_CONCURRENCY);
    const filled = await Promise.all(
      batch.map(async ({ hit }) => {
        if (signal?.aborted) return null;
        try {
          parseAndValidateNonMetadataUrl(hit.url);
        } catch {
          return null;
        }
        return fetchHead(hit.url, signal ?? new AbortController().signal);
      })
    );
    batch.forEach(({ index }, i) => {
      if (filled[i]) out[index] = { ...out[index], published_at: filled[i] };
    });
  }
  return out;
}
