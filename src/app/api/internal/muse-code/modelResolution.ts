/**
 * Model resolution for the Muse Code compat surface.
 *
 * Meta's `muse` CLI sends bare Spark ids (e.g. "muse-spark-1.3-contributor")
 * to POST /responses. Under OmniRoute's global model routing those bare ids
 * do not resolve to the zen-backed provider, so re-resolve them under the
 * `opencode-go/` prefix — the same prefer-a-provider pattern as
 * `resolveCodexWsModelInfo` / `resolveResponsesApiModel` for Codex.
 *
 * Only Spark ids are rewritten (see MUSE_SPARK_MODEL_IDS): bare Meta ids
 * such as llama-* pass through untouched, as do already-prefixed ids and
 * the "auto" routing keyword.
 */
import {
  isMuseSparkModel,
  MUSE_CODE_UPSTREAM_PREFIX,
} from "@omniroute/open-sse/handlers/museCode.ts";

export interface ResolvedModelInfo {
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

export type ModelResolver = (modelStr: string) => Promise<ResolvedModelInfo>;

/**
 * Resolve a Responses model id, preferring the zen-backed Spark provider
 * for bare Muse Spark ids.
 *
 * @param requestedModel the model id from the Responses API request body
 * @param resolve a getModelInfo-style resolver
 * @param isCombo optional predicate — when the bare id is a combo name, skip
 *        the rewrite so downstream combo routing resolves it.
 * @returns { model, changed } — model is the (possibly rewritten) id;
 *          changed=true means an opencode-go/ prefix was applied.
 */
export async function resolveMuseCodeApiModel(
  requestedModel: string,
  resolve: ModelResolver,
  isCombo?: (name: string) => Promise<boolean> | boolean
): Promise<{ model: string; changed: boolean }> {
  if (!requestedModel || requestedModel.includes("/")) {
    return { model: requestedModel, changed: false };
  }
  if (requestedModel === "auto") {
    return { model: requestedModel, changed: false };
  }
  if (!isMuseSparkModel(requestedModel)) {
    return { model: requestedModel, changed: false };
  }
  if (isCombo) {
    try {
      if (await isCombo(requestedModel)) return { model: requestedModel, changed: false };
    } catch {
      // combo lookup unavailable — fall through to normal resolution
    }
  }

  try {
    const resolved = await resolve(`${MUSE_CODE_UPSTREAM_PREFIX}/${requestedModel}`);
    if (resolved?.provider !== MUSE_CODE_UPSTREAM_PREFIX) {
      return { model: requestedModel, changed: false };
    }
    return {
      model: `${MUSE_CODE_UPSTREAM_PREFIX}/${resolved.model || requestedModel}`,
      changed: true,
    };
  } catch {
    return { model: requestedModel, changed: false };
  }
}
