/**
 * Combo context-length computation + per-target diagnostics.
 *
 * Computes the effective context_window for a combo from canonical model
 * metadata, which already applies persisted overrides and source precedence.
 *
 * Only models that are registered in at least one data source (provider registry,
 * static specs, or synced capabilities) — or that carry a persisted resolved
 * limit — contribute to the aggregate, matching the catalog's semantics that
 * excludes unsourced models.
 *
 * `buildComboContextDiagnostics()` is the full surface: it returns the effective
 * value AND a per-target breakdown (with an `unknown_reason` for every target
 * that could not contribute), which `/api/combos/[id]` exposes so the dashboard
 * can explain WHY a combo's context window is what it is.
 * `computeComboContextLength()` is the thin value-only wrapper over it.
 */

import { resolveNestedComboTargets } from "@omniroute/open-sse/services/combo";
import { getCanonicalModelMetadata } from "@/lib/modelMetadataRegistry";
import { isPersistedResolvedLimitSource } from "@/lib/modelCapabilities";
import { getTokenLimit } from "@omniroute/open-sse/services/contextManager";
import { buildAliasMaps, getComboTargetModelId } from "@/app/api/v1/models/catalogProviderMaps";

export type ComboContextAggregation = "min" | "max";

type ComboLike = {
  models?: unknown[];
  context_length?: number;
  context_length_aggregation?: ComboContextAggregation;
  name?: string;
};

type ProviderNodeLike = { id?: unknown; prefix?: unknown; name?: unknown };

export interface ComboContextTargetDiagnostic {
  provider: string;
  model: string;
  context_length?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  context_source?: string;
  input_source?: string;
  output_source?: string;
  unknown_reason?: string;
}

export interface ComboContextDiagnostics {
  mode: ComboContextAggregation;
  source: "manual" | "aggregated" | "unknown";
  effective_context_length?: number;
  manual_context_length?: number;
  known_min?: number;
  known_max?: number;
  known_count: number;
  targets: ComboContextTargetDiagnostic[];
}

/* ─── helpers ───────────────────────────────────────────────── */

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Aggregate known (positively finite) values by mode; undefined when none. */
export function aggregateKnownNumbers(
  values: Array<number | null | undefined>,
  mode: ComboContextAggregation = "min"
): number | undefined {
  const known = values.filter(isPositiveFiniteNumber);
  if (known.length === 0) return undefined;
  return mode === "max" ? Math.max(...known) : Math.min(...known);
}

function publicPrefix(node: ProviderNodeLike): string | null {
  if (typeof node.prefix === "string" && node.prefix.trim()) return node.prefix.trim();
  if (typeof node.name !== "string") return null;
  return (
    node.name
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "") || null
  );
}

/* ─── public API ────────────────────────────────────────────── */

export function buildComboContextDiagnostics(
  combo: ComboLike,
  allCombos: ComboLike[],
  providerNodes: ProviderNodeLike[] = []
): ComboContextDiagnostics {
  const mode: ComboContextAggregation = combo.context_length_aggregation === "max" ? "max" : "min";
  const maps = buildAliasMaps();
  const nodePrefixes = new Map<string, string>();
  for (const node of providerNodes) {
    if (typeof node.id !== "string") continue;
    const prefix = publicPrefix(node);
    if (prefix) nodePrefixes.set(node.id, prefix);
  }

  const targets = resolveNestedComboTargets(
    combo as Parameters<typeof resolveNestedComboTargets>[0],
    allCombos as Parameters<typeof resolveNestedComboTargets>[1]
  ).map((target): ComboContextTargetDiagnostic => {
    // Strip the provider/alias prefix off `modelStr` BEFORE the canonical
    // lookup. resolveNestedComboTargets() returns modelStr in "provider/model"
    // form (e.g. "glm/glm-5.2"), but getCanonicalModelMetadata()'s alias lookup
    // is keyed by the BARE registry id — passing the qualified string straight
    // through only matched the ~47 models with a curated "provider/model"
    // MODEL_SPECS alias, silently excluding the other ~1,650 registry-only
    // models from the aggregate below. Reusing the catalog's own
    // getComboTargetModelId() keeps this in lockstep with
    // getComboTargetCatalogMetadata().
    const resolved = getComboTargetModelId(maps, target);
    if (!resolved) {
      return {
        provider: "unknown",
        model: typeof target.modelStr === "string" ? target.modelStr : "unknown",
        unknown_reason: "target-unresolved",
      };
    }

    const canonical = getCanonicalModelMetadata({
      provider: resolved.providerId,
      model: resolved.modelId,
    });
    const publicProvider =
      nodePrefixes.get(resolved.providerId) ||
      maps.providerIdToAlias[resolved.providerId] ||
      resolved.providerId;
    if (!canonical) {
      return {
        provider: publicProvider,
        model: resolved.modelId,
        unknown_reason: "metadata-unresolved",
      };
    }

    // Source check — only count models that exist in at least one known data
    // source, OR that carry a persisted resolved limit (an operator override
    // still counts even when the model is absent from every catalog source).
    const knownSource = canonical.metadata.source;
    const hasRecognizedMetadata =
      knownSource.providerRegistry || knownSource.staticSpec || knownSource.syncedCapability;
    const hasPersistedLimit =
      (isPositiveFiniteNumber(canonical.limits.contextWindow) &&
        isPersistedResolvedLimitSource(canonical.limits.contextWindowSource)) ||
      (isPositiveFiniteNumber(canonical.limits.maxInputTokens) &&
        isPersistedResolvedLimitSource(canonical.limits.maxInputTokensSource)) ||
      (isPositiveFiniteNumber(canonical.limits.maxOutputTokens) &&
        isPersistedResolvedLimitSource(canonical.limits.maxOutputTokensSource));
    if (!hasRecognizedMetadata && !hasPersistedLimit) {
      return {
        provider: publicProvider,
        model: canonical.model || resolved.modelId,
        unknown_reason: "metadata-source-unknown",
      };
    }

    const providerId = canonical.provider || resolved.providerId;
    const modelId = canonical.model || resolved.modelId;

    // Canonical metadata first, then the contextManager token-limit table as an
    // authoritative fallback for models whose registry entry carries no
    // contextWindow.
    const contextLength = isPositiveFiniteNumber(canonical.limits.contextWindow)
      ? canonical.limits.contextWindow
      : (() => {
          const fallback = getTokenLimit(providerId, modelId);
          return isPositiveFiniteNumber(fallback) ? fallback : undefined;
        })();

    return {
      provider: nodePrefixes.get(canonical.provider || "") || publicProvider,
      model: modelId,
      ...(contextLength ? { context_length: contextLength } : {}),
      ...(isPositiveFiniteNumber(canonical.limits.maxInputTokens)
        ? { max_input_tokens: canonical.limits.maxInputTokens }
        : {}),
      ...(isPositiveFiniteNumber(canonical.limits.maxOutputTokens)
        ? { max_output_tokens: canonical.limits.maxOutputTokens }
        : {}),
      ...(contextLength
        ? { context_source: canonical.limits.contextWindowSource || "authoritative-fallback" }
        : { unknown_reason: "context-limit-unknown" }),
      ...(isPositiveFiniteNumber(canonical.limits.maxInputTokens) &&
      canonical.limits.maxInputTokensSource
        ? { input_source: canonical.limits.maxInputTokensSource }
        : {}),
      ...(isPositiveFiniteNumber(canonical.limits.maxOutputTokens) &&
      canonical.limits.maxOutputTokensSource
        ? { output_source: canonical.limits.maxOutputTokensSource }
        : {}),
    };
  });

  const contexts = targets.map((target) => target.context_length);
  const knownCount = contexts.filter(isPositiveFiniteNumber).length;
  const manual = isPositiveFiniteNumber(combo.context_length) ? combo.context_length : undefined;
  const effective = manual ?? aggregateKnownNumbers(contexts, mode);
  return {
    mode,
    source: manual ? "manual" : effective ? "aggregated" : "unknown",
    ...(effective ? { effective_context_length: effective } : {}),
    ...(manual ? { manual_context_length: manual } : {}),
    ...(knownCount > 0 ? { known_min: aggregateKnownNumbers(contexts, "min") } : {}),
    ...(knownCount > 0 ? { known_max: aggregateKnownNumbers(contexts, "max") } : {}),
    known_count: knownCount,
    targets,
  };
}

/**
 * Compute the effective context-length for a combo.
 *
 * Resolution order:
 * 1. Explicit `context_length` on the combo record itself (manual override).
 * 2. Aggregate (min by default, max when `context_length_aggregation === "max"`)
 *    of member-model effective context windows from canonical metadata.
 *
 * Returns `undefined` when no known context window can be determined.
 */
export function computeComboContextLength(
  combo: ComboLike,
  allCombos: ComboLike[]
): number | undefined {
  return buildComboContextDiagnostics(combo, allCombos).effective_context_length;
}
