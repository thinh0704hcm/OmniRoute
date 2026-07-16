/**
 * artificialAnalysisSync.ts — Artificial Analysis benchmark sync engine.
 *
 * Fetches LLM benchmark data from the Artificial Analysis API
 * (https://artificialanalysis.ai/api/v2/data/llms/models) and stores
 * normalised per-metric scores in the `model_intelligence` DB table under
 * source "artificial_analysis". The `aa-benchmark` combo routing strategy
 * ranks targets by these scores.
 *
 * Requires ARTIFICIAL_ANALYSIS_API_KEY (never committed — operator env only).
 * Opt out via Dashboard Feature Flags or AA_BENCHMARK_SYNC_ENABLED=false.
 *
 * Data by Artificial Analysis (https://artificialanalysis.ai/) — attribution
 * is required for use of their free API.
 */

import { isAaBenchmarkSyncEnabled } from "@/shared/utils/featureFlags";

import { backupDbFile } from "./db/backup";
import {
  bulkUpsertModelIntelligence,
  deleteExpiredIntelligence,
  deleteModelIntelligenceBySource,
  type ModelIntelligenceEntry,
} from "./db/modelIntelligence";

// ─── Types ───────────────────────────────────────────────

/**
 * A single model entry from the Artificial Analysis /data/llms/models endpoint.
 * Only the fields the sync consumes are modelled; extra fields are ignored.
 */
export interface AaModelEntry {
  /** AA model UUID. */
  id: string;
  /** Display name (e.g. "GPT-5.5 (Non-reasoning)"). */
  name: string;
  /** URL slug (e.g. "gpt-5-5-non-reasoning"). */
  slug: string;
  /** Benchmark indices; individual values may be null when not evaluated. */
  evaluations?: {
    artificial_analysis_intelligence_index?: number | null;
    artificial_analysis_coding_index?: number | null;
    artificial_analysis_math_index?: number | null;
  } | null;
  /** Median output speed in tokens/second. */
  median_output_tokens_per_second?: number | null;
}

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  /** Whether the sync completed successfully. */
  success: boolean;
  /** Number of model intelligence entries stored. */
  modelCount: number;
  /** Source identifier (always "artificial_analysis"). */
  source: string;
  /** Error message if sync failed. */
  error?: string;
}

/**
 * Current status of the Artificial Analysis sync subsystem.
 */
export interface SyncStatus {
  /** Whether sync is effectively enabled (feature flag + API key present). */
  enabled: boolean;
  /** ISO timestamp of last successful sync, or null. */
  lastSync: string | null;
  /** Number of entries stored in last successful sync. */
  lastSyncModelCount: number;
  /** ISO timestamp of next scheduled sync, or null. */
  nextSync: string | null;
  /** Configured sync interval in milliseconds. */
  intervalMs: number;
  /** Active data sources. */
  sources: string[];
}

// ─── Configuration ───────────────────────────────────────

const AA_API_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";

export const AA_SOURCE = "artificial_analysis";

/** Rankable metrics exposed to the aa-benchmark strategy's `aaMetric` config. */
export const AA_METRICS = ["intelligence", "coding", "math", "speed"] as const;

export type AaMetric = (typeof AA_METRICS)[number];

/** DB category for a metric — namespaced so it can never collide with task-fit categories. */
export function aaCategoryForMetric(metric: string): string {
  return `aa-${metric.toLowerCase()}`;
}

/**
 * OmniRoute model aliases: normalized AA key → known internal aliases.
 * Creates additional DB entries for each alias so that models are findable
 * under any name OmniRoute uses internally (same technique as arenaEloSync).
 */
const MODEL_ALIAS_MAP: Record<string, string[]> = {
  "gpt-5.5": ["gpt-5-5", "openai/gpt-5.5"],
  "claude-opus-4.6": ["claude-opus-4-6", "anthropic/claude-opus-4-6"],
  "claude-sonnet-4.5": ["claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"],
  "gemini-3-flash": ["google/gemini-3-flash", "gemini-flash"],
  "deepseek-r1": ["deepseek/deepseek-r1"],
  "kimi-k2-thinking": ["moonshot/kimi-k2", "kimi-k2"],
};

/** Intelligence entry expiration: 7 days after sync. */
const EXPIRY_DAYS = 7;

const parsedInterval = parseInt(process.env.ARTIFICIAL_ANALYSIS_SYNC_INTERVAL || "86400", 10);
const SYNC_INTERVAL_MS =
  Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval * 1000 : 86400 * 1000;

// ─── Periodic sync state ─────────────────────────────────

let syncTimer: ReturnType<typeof setInterval> | null = null;
let lastSyncTime: string | null = null;
let lastSyncModelCount = 0;
let activeSyncIntervalMs = SYNC_INTERVAL_MS;
let firstSyncDone = false;
let syncInProgress = false;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getApiKey(): string {
  return process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim() || "";
}

function getEffectiveAaSyncEnabled(): boolean {
  try {
    return isAaBenchmarkSyncEnabled();
  } catch (error) {
    console.warn(
      `[AA_SYNC] Failed to resolve AA_BENCHMARK_SYNC_ENABLED feature flag: ${getErrorMessage(error)}`
    );
    return process.env.AA_BENCHMARK_SYNC_ENABLED !== "false";
  }
}

// ─── Model name normalization ────────────────────────────

/**
 * Compute the DB lookup keys an AA model should be stored under.
 *
 * Emits (deduplicated): the lowercased slug, the lowercased display name, and
 * a cleaned name variant with parentheticals stripped and spaces dashed —
 * e.g. "Claude Sonnet 4.5 (Extended Thinking)" → "claude-sonnet-4.5" — which
 * is the form OmniRoute model ids most often take.
 *
 * @param entry - The AA model entry.
 * @returns Unique lookup keys for this model.
 */
export function normalizeAaModelKeys(entry: AaModelEntry): string[] {
  const keys = new Set<string>();
  const slug = (entry.slug || "").trim().toLowerCase();
  if (slug) keys.add(slug);

  const name = (entry.name || "").trim().toLowerCase();
  if (name) {
    keys.add(name);
    const cleaned = name
      .replace(/\([^)]*\)/g, " ")
      .trim()
      .replace(/\s+/g, "-");
    if (cleaned) keys.add(cleaned);
  }

  return [...keys];
}

// ─── Core: Fetch ─────────────────────────────────────────

/**
 * Fetch the LLM model list from the Artificial Analysis API.
 *
 * @param apiKey - API key override (defaults to ARTIFICIAL_ANALYSIS_API_KEY).
 * @returns The models from the response `data` envelope.
 * @throws On HTTP errors, invalid JSON, or a malformed envelope.
 */
export async function fetchAaModels(apiKey?: string): Promise<AaModelEntry[]> {
  const key = apiKey ?? getApiKey();
  const response = await fetch(AA_API_URL, {
    headers: { "x-api-key": key },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    throw new Error(
      `Artificial Analysis API fetch failed [${response.status}]: ${response.statusText}`
    );
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Artificial Analysis API returned invalid JSON (${text.slice(0, 100)}...)`);
  }
  const data = (parsed as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new Error("Artificial Analysis API response has no data array");
  }
  return data as AaModelEntry[];
}

// ─── Core: Transform ─────────────────────────────────────

function getMetricValue(entry: AaModelEntry, metric: AaMetric): number | null {
  const raw =
    metric === "speed"
      ? entry.median_output_tokens_per_second
      : metric === "intelligence"
        ? entry.evaluations?.artificial_analysis_intelligence_index
        : metric === "coding"
          ? entry.evaluations?.artificial_analysis_coding_index
          : entry.evaluations?.artificial_analysis_math_index;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * Transform raw AA models into model intelligence entries.
 *
 * For each metric, values are min-max normalized to [0,1] across the models
 * that have that metric (single-model / zero-range metrics score 1). The raw
 * index value is preserved in `eloRaw`. Each model is stored under all its
 * normalized keys plus known OmniRoute aliases; when several AA variants
 * collide on the same key × category, the highest-scoring one wins.
 *
 * @param models - Raw AA model entries.
 * @returns Entries ready for DB upsert.
 */
export function transformToModelIntelligence(
  models: AaModelEntry[]
): Array<Omit<ModelIntelligenceEntry, "syncedAt">> {
  const expiresAt = new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const byKey = new Map<string, Omit<ModelIntelligenceEntry, "syncedAt">>();

  for (const metric of AA_METRICS) {
    const withValue = models
      .map((entry) => ({ entry, value: getMetricValue(entry, metric) }))
      .filter((m): m is { entry: AaModelEntry; value: number } => m.value !== null);
    if (withValue.length === 0) continue;

    const values = withValue.map((m) => m.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const category = aaCategoryForMetric(metric);

    for (const { entry, value } of withValue) {
      const score = range > 0 ? Math.round(((value - min) / range) * 10000) / 10000 : 1;
      const modelKeys = normalizeAaModelKeys(entry);
      const allKeys = new Set(modelKeys);
      for (const key of modelKeys) {
        for (const alias of MODEL_ALIAS_MAP[key] ?? []) allKeys.add(alias.toLowerCase());
      }

      for (const model of allKeys) {
        const mapKey = `${model} ${category}`;
        const existing = byKey.get(mapKey);
        if (existing && (existing.eloRaw ?? -Infinity) >= value) continue;
        byKey.set(mapKey, {
          model,
          category,
          source: AA_SOURCE,
          score,
          eloRaw: value,
          confidence: null,
          expiresAt,
        });
      }
    }
  }

  return [...byKey.values()];
}

// ─── Main sync function ──────────────────────────────────

/**
 * Fetch, transform, and store Artificial Analysis benchmark data.
 *
 * Pipeline: delete expired → fetch models → transform → bulk upsert.
 * All errors are caught and reported in the result — sync is never fatal.
 *
 * @param dryRun - If true, fetches and transforms but does not write to DB.
 * @returns Sync result with entry count and success status.
 */
export async function syncArtificialAnalysis(dryRun = false): Promise<SyncResult> {
  if (syncInProgress) {
    return {
      success: false,
      modelCount: 0,
      source: AA_SOURCE,
      error: "Sync already in progress",
    };
  }
  if (!getApiKey()) {
    return {
      success: false,
      modelCount: 0,
      source: AA_SOURCE,
      error: "ARTIFICIAL_ANALYSIS_API_KEY not configured",
    };
  }
  syncInProgress = true;
  try {
    if (!firstSyncDone && !dryRun) {
      backupDbFile("pre-artificial-analysis-sync");
      firstSyncDone = true;
    }

    if (!dryRun) {
      try {
        deleteExpiredIntelligence(AA_SOURCE);
      } catch (err) {
        console.warn(`[AA_SYNC] Failed to delete expired intelligence: ${getErrorMessage(err)}`);
      }
    }

    const models = await fetchAaModels();
    const entries = transformToModelIntelligence(models);

    if (!dryRun && entries.length > 0) {
      try {
        bulkUpsertModelIntelligence(entries);
      } catch (err) {
        const message = getErrorMessage(err);
        console.warn(`[AA_SYNC] Failed to bulk upsert intelligence: ${message}`);
        return { success: false, modelCount: 0, source: AA_SOURCE, error: message };
      }
    }

    if (!dryRun) {
      lastSyncTime = new Date().toISOString();
      lastSyncModelCount = entries.length;
    }

    const countLabel = dryRun ? "would sync" : "synced";
    console.log(
      `[AA_SYNC] ${countLabel} ${entries.length} model intelligence entries from Artificial Analysis`
    );

    return { success: true, modelCount: entries.length, source: AA_SOURCE };
  } catch (err) {
    const message = getErrorMessage(err);
    console.warn("[AA_SYNC] Sync failed:", message);
    return { success: false, modelCount: 0, source: AA_SOURCE, error: message };
  } finally {
    syncInProgress = false;
  }
}

// ─── Clear synced data ───────────────────────────────────

/**
 * Clear all synced Artificial Analysis intelligence data.
 */
export function clearSyncedAaIntelligence(): void {
  const deleted = deleteModelIntelligenceBySource(AA_SOURCE);
  console.log(`[AA_SYNC] Cleared ${deleted} artificial_analysis intelligence entries`);
}

// ─── Periodic sync ───────────────────────────────────────

function startPeriodicSync(intervalMs?: number): void {
  if (syncTimer) return; // Already running

  const interval = intervalMs ?? SYNC_INTERVAL_MS;
  activeSyncIntervalMs = interval;
  console.log(`[AA_SYNC] Starting periodic sync every ${interval / 1000}s`);

  // Initial sync (non-blocking)
  syncArtificialAnalysis()
    .then((result) => {
      if (result.success) {
        console.log(`[AA_SYNC] Initial sync complete: ${result.modelCount} entries`);
      }
    })
    .catch((err) => {
      console.warn("[AA_SYNC] Initial sync error:", getErrorMessage(err));
    });

  syncTimer = setInterval(() => {
    syncArtificialAnalysis()
      .then((result) => {
        if (result.success) {
          console.log(`[AA_SYNC] Periodic sync complete: ${result.modelCount} entries`);
        }
      })
      .catch((err) => {
        console.warn("[AA_SYNC] Periodic sync error:", getErrorMessage(err));
      });
  }, interval);

  // Prevent the timer from keeping the process alive
  if (syncTimer && typeof syncTimer === "object" && "unref" in syncTimer) {
    (syncTimer as { unref?: () => void }).unref?.();
  }
}

/**
 * Stop periodic Artificial Analysis sync and clean up the timer.
 */
export function stopArtificialAnalysisSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    console.log("[AA_SYNC] Periodic sync stopped");
  }
}

/**
 * Get the current Artificial Analysis sync status.
 */
export function getArtificialAnalysisSyncStatus(): SyncStatus {
  const enabled = getEffectiveAaSyncEnabled() && Boolean(getApiKey());
  return {
    enabled,
    lastSync: lastSyncTime,
    lastSyncModelCount,
    nextSync:
      syncTimer && lastSyncTime
        ? new Date(new Date(lastSyncTime).getTime() + activeSyncIntervalMs).toISOString()
        : null,
    intervalMs: activeSyncIntervalMs,
    sources: [AA_SOURCE],
  };
}

// ─── Init (called from server-init.ts) ───────────────────

/**
 * Initialize Artificial Analysis sync if enabled and configured.
 *
 * Requires the AA_BENCHMARK_SYNC_ENABLED feature flag (default: true) AND
 * a non-empty ARTIFICIAL_ANALYSIS_API_KEY. Without the key the sync is a
 * logged no-op, so the flag's on-by-default is harmless. Never fatal.
 */
export async function initArtificialAnalysisSync(): Promise<boolean> {
  if (!getEffectiveAaSyncEnabled()) {
    console.log(
      "[AA_SYNC] Disabled by the effective AA_BENCHMARK_SYNC_ENABLED feature flag. Enable it from Dashboard Feature Flags, unset the env var, or set it to true to enable."
    );
    return false;
  }
  if (!getApiKey()) {
    console.log(
      "[AA_SYNC] ARTIFICIAL_ANALYSIS_API_KEY is not configured — Artificial Analysis benchmark sync is off. The aa-benchmark strategy will keep original target order until scores are synced."
    );
    return false;
  }
  startPeriodicSync();
  return true;
}
