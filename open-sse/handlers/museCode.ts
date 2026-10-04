/**
 * Muse Code compat surface — Meta's `muse` CLI pointed at OmniRoute.
 *
 * `muse` speaks the OpenAI Responses API at three root paths:
 *   GET  /muse-code/models  — model catalog (only id + metadata are read)
 *   POST /muse-code/search  — web_search backend (shape confirmed live: { results: [{ title, url, snippet }] })
 *   POST /responses         — inference (relayed to zen-backed Spark, see modelResolution)
 *
 * Session pinning: muse sends `prompt_cache_key: "tbh:main:<session-uuid>"`
 * per session. The uuid is extracted and bound to the workspace so two
 * checkouts of the same project never share one upstream conversation —
 * the same recipe the standalone muse-shim used (verified live 2026-10-04).
 */
import { randomUUID } from "node:crypto";

/** Upstream provider backing zen Spark traffic (OpenCode Go console). */
export const MUSE_CODE_UPSTREAM_PREFIX = "opencode-go";

/** Bare model ids `muse` sends that resolve to zen-backed Spark. */
export const MUSE_SPARK_MODEL_IDS: ReadonlySet<string> = new Set([
  "muse-spark-1.3",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2",
  "muse-spark-1.2-contributor",
  "muse-spark-1.1",
]);

const TBH_MAIN_RE = /^tbh:main:([0-9a-f-]{36})/i;
const WORKSPACE_RE = /Workspace root:\s*(\S+)/;

/** Short stable hash (routing tag, not crypto). */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * Derive a stable upstream session id for one (muse session, workspace).
 * Deterministic when prompt_cache_key parses; random fallback otherwise.
 */
export function deriveMuseCodeSessionId(body: unknown, rawText?: string): string {
  const rec =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const cacheKey = typeof rec.prompt_cache_key === "string" ? rec.prompt_cache_key : "nokey";
  let ws = "nows";
  const text = rawText ?? JSON.stringify(body ?? {});
  const m = WORKSPACE_RE.exec(text);
  if (m) ws = m[1];
  const u = TBH_MAIN_RE.exec(cacheKey);
  return `${u ? u[1] : randomUUID()}:${shortHash(ws)}`;
}

/** True when the request model is a bare zen-backed Spark id. */
export function isMuseSparkModel(model: unknown): boolean {
  return typeof model === "string" && MUSE_SPARK_MODEL_IDS.has(model);
}

/** Minimal registry-model view needed to build the `muse` catalog. */
export interface MuseCodeRegistryModel {
  id: string;
  name: string;
  supportsReasoning?: boolean;
  toolCalling?: boolean;
  supportsVision?: boolean;
  contextLength?: number;
}

export interface MuseCodeCatalogModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  metadata: Record<string, unknown>;
}

/**
 * Build the proprietary catalog `muse` reads at GET /muse-code/models.
 * Pure function over registry models — the route caches its output per process.
 */
export function buildMuseCodeCatalog(models: MuseCodeRegistryModel[]): MuseCodeCatalogModel[] {
  const created = Math.floor(Date.now() / 1000);
  return models.map((model) => {
    let family = "llama";
    if (model.id.includes("llama-4")) family = "llama-4";
    else if (model.id.includes("llama-3.3")) family = "llama-3.3";
    else if (model.id.includes("llama-3.2")) family = "llama-3.2";
    else if (model.id.includes("llama-3.1")) family = "llama-3.1";
    const modalities: string[] = ["text"];
    if (model.supportsVision) modalities.push("image");
    return {
      id: model.id,
      object: "model",
      created,
      owned_by: "meta",
      metadata: {
        name: model.name,
        family,
        reasoning: !!model.supportsReasoning,
        tool_call: !!model.toolCalling,
        modalities,
        limit: model.contextLength ?? 200_000,
        cost: model.id.includes("maverick") || model.id.includes("405b") ? 3 : 1,
        // Muse Spark compat: `muse` reads metadata["muse-code"] for Spark
        // ids (same contract the standalone shim served; confirmed live).
        ...(model.id.startsWith("muse-spark")
          ? {
              "muse-code": {
                release_date: "2026-09-01",
                is_hidden: false,
                limit: { context: 1_000_000, output: 32_768 },
              },
            }
          : {}),
      },
    };
  });
}

export interface MuseCodeSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Map gateway search results to the shape `muse` accepts (confirmed live). */
export function toMuseCodeSearchShape(results: Array<Record<string, unknown>> | undefined | null): {
  results: MuseCodeSearchResult[];
} {
  return {
    results: (results ?? []).map((it) => ({
      title: String(it.title ?? ""),
      url: String(it.url ?? ""),
      snippet: String(it.snippet ?? ""),
    })),
  };
}
