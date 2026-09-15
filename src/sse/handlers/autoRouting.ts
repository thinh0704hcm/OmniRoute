import { buildErrorBody, errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import type { AutoVariant } from "@omniroute/open-sse/services/autoCombo/autoPrefix.ts";
import {
  AUTO_TEMPLATE_VARIANTS,
  resolveBuiltinAutoRoute,
} from "@omniroute/open-sse/services/autoCombo/builtinCatalog.ts";
import type {
  AutoCategory,
  AutoTier,
} from "@omniroute/open-sse/services/autoCombo/suffixComposition.ts";
import type { ModelFamily } from "@omniroute/open-sse/services/autoCombo/modelFamily.ts";
import { getCachedSettings } from "@/lib/db/readCache";
import * as log from "../utils/logger";

export type AutoRoutingState = {
  model: string;
  variant?: AutoVariant;
  spec?: { category?: AutoCategory; tier?: AutoTier; family?: ModelFamily };
  isAutoRouting: boolean;
  recognizedBuiltInAuto: boolean;
  response: Response | null;
};

function classifyAutoModel(
  model: string
): Pick<AutoRoutingState, "variant" | "spec" | "recognizedBuiltInAuto"> {
  const route = resolveBuiltinAutoRoute(model);
  return {
    recognizedBuiltInAuto: route.recognized,
    ...(route.variant ? { variant: route.variant } : {}),
    ...(route.spec ? { spec: route.spec } : {}),
  };
}

const BUILTIN_AUTO_TARGET_TIMEOUT_MS = 60_000;
const BUILTIN_AUTO_MAX_GLOBAL_ATTEMPTS = 6;
const BUILTIN_AUTO_COMBO_TIMEOUT_MS = 300_000;

type VirtualAutoComboShape = {
  models?: unknown[];
  config?: Record<string, unknown>;
};

export function rejectEmptyVirtualAutoCombo(combo: VirtualAutoComboShape): Response | null {
  if (Array.isArray(combo.models) && combo.models.length > 0) return null;
  return new Response(
    JSON.stringify(
      buildErrorBody(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        "No eligible model is available for this auto routing request.",
        undefined,
        { code: "auto_candidate_pool_empty", type: "server_error" }
      )
    ),
    { status: HTTP_STATUS.SERVICE_UNAVAILABLE, headers: { "Content-Type": "application/json" } }
  );
}

export function hardenBuiltinAutoCombo<T extends VirtualAutoComboShape>(combo: T): T {
  const configuredTargetTimeout = Number(combo.config?.targetTimeoutMs);
  const configuredMaxAttempts = Number(combo.config?.maxGlobalAttempts);
  const configuredComboTimeout = Number(combo.config?.comboTimeoutMs);
  return {
    ...combo,
    config: {
      ...combo.config,
      targetTimeoutMs:
        Number.isFinite(configuredTargetTimeout) && configuredTargetTimeout > 0
          ? Math.min(configuredTargetTimeout, BUILTIN_AUTO_TARGET_TIMEOUT_MS)
          : BUILTIN_AUTO_TARGET_TIMEOUT_MS,
      maxGlobalAttempts:
        Number.isFinite(configuredMaxAttempts) && configuredMaxAttempts > 0
          ? Math.min(Math.floor(configuredMaxAttempts), BUILTIN_AUTO_MAX_GLOBAL_ATTEMPTS)
          : BUILTIN_AUTO_MAX_GLOBAL_ATTEMPTS,
      comboTimeoutMs:
        Number.isFinite(configuredComboTimeout) && configuredComboTimeout > 0
          ? Math.min(configuredComboTimeout, BUILTIN_AUTO_COMBO_TIMEOUT_MS)
          : BUILTIN_AUTO_COMBO_TIMEOUT_MS,
    },
  };
}

async function applyAutoPrefix(
  model: string,
  state: Pick<AutoRoutingState, "variant" | "spec">,
  settings: Record<string, unknown>
): Promise<Pick<AutoRoutingState, "variant" | "spec">> {
  if (Object.prototype.hasOwnProperty.call(AUTO_TEMPLATE_VARIANTS, model)) {
    log.info("AUTO", `Zero-config routing variant: ${state.variant || "default"} (model=${model})`);
    return state;
  }
  try {
    const { parseAutoPrefix } =
      await import("@omniroute/open-sse/services/autoCombo/autoPrefix.ts");
    const parsed = parseAutoPrefix(model);
    if (!parsed.valid) {
      if (!state.spec) log.warn("AUTO", `Invalid auto prefix format: ${model}`);
      return state;
    }

    const variant = Object.prototype.hasOwnProperty.call(AUTO_TEMPLATE_VARIANTS, model)
      ? state.variant
      : parsed.variant;
    const defaultVariant =
      model === "auto" && variant === undefined
        ? (settings.autoRoutingDefaultVariant as AutoVariant | undefined)
        : undefined;
    const resolvedVariant = variant ?? defaultVariant;
    log.info(
      "AUTO",
      `Zero-config routing variant: ${resolvedVariant || "default"} (model=${model})`
    );
    return { variant: resolvedVariant, spec: state.spec };
  } catch (err) {
    log.error("AUTO", "Failed to load auto-prefix parser", { err });
    return state;
  }
}

export async function resolveAutoRoutingState(model: string): Promise<AutoRoutingState> {
  const isAutoRouting = model === "auto" || model.startsWith("auto/");
  const classified = classifyAutoModel(model);

  if (!isAutoRouting) {
    return { model, ...classified, isAutoRouting, response: null };
  }

  const settings = await getCachedSettings().catch(() => ({}) as Record<string, unknown>);
  if (settings?.autoRoutingEnabled === false) {
    return {
      model,
      ...classified,
      isAutoRouting,
      response: errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        "Auto routing is disabled. Enable it in Settings > Routing."
      ),
    };
  }

  const resolved = await applyAutoPrefix(model, classified, settings);
  return { model, ...classified, ...resolved, isAutoRouting, response: null };
}

export async function createVirtualAutoCombo(
  state: AutoRoutingState,
  combo: any,
  apiKeyId?: string
): Promise<any | Response> {
  if (!state.isAutoRouting || combo !== null) return combo;
  if (!state.recognizedBuiltInAuto) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Model '${state.model}' is not a valid combo or provider. Unknown built-in auto combo.`
    );
  }

  try {
    const { createVirtualAutoCombo: createVirtual } =
      await import("@omniroute/open-sse/services/autoCombo/virtualFactory.ts");
    // #7819 (Level 2): scope candidate exclusions to this API key + the
    // requested auto channel (e.g. "auto/best-coding"). Omitted for any
    // caller that doesn't pass apiKeyId — routing stays unfiltered.
    const virtualCombo = hardenBuiltinAutoCombo(
      await createVirtual(state.variant, state.spec, apiKeyId, state.model)
    );
    virtualCombo.name = state.model;
    virtualCombo.id = state.model;
    const emptyPoolResponse = rejectEmptyVirtualAutoCombo(virtualCombo);
    if (emptyPoolResponse) return emptyPoolResponse;
    log.info(
      "AUTO",
      `Virtual auto-combo created: ${virtualCombo.name} (${virtualCombo.candidatePool?.length || 0} candidates)`
    );
    return virtualCombo;
  } catch (err) {
    log.error("AUTO", "Failed to create virtual auto-combo", { err });
    return null;
  }
}
