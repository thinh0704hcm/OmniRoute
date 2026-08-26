/**
 * Canonical economic/performance combo manifest and reconciliation planner.
 *
 * This module is side-effect free. Persistence lives in the matching db domain module so tests,
 * deployment gates, and the operator CLI all consume one typed manifest and safety policy.
 */

import type { ClaudePerformanceTier, PricingStructure } from "./tierEvidence.ts";
import type { EconomicPool } from "./economicPoolDerivation.ts";

export const CANONICAL_COMBO_MANAGER = "canonical-economic-pools";
export const CANONICAL_COMBO_VERSION = 11;

const VISIBLE_CANONICAL_COMBOS = new Set([
  "pool-haiku-free",
  "pool-haiku-antigravity",
  "pool-sonnet-free",
  "pool-sonnet-antigravity",
  "pool-sonnet-credits",
  "pool-opus-free",
  "pool-opus-antigravity",
  "pool-opus-credits",
  "pool-opus-codex",
  "pool-fable-antigravity",
  "pool-fable-credits",
  "pool-fable-reserve-credits",
  "pool-fable-codex",
  "pool-haiku",
  "pool-sonnet",
  "pool-opus",
  "pool-fable",
]);

export type CanonicalComboStep =
  | {
      id: string;
      kind: "model";
      model: string;
      providerId?: string;
      connectionId?: string;
      weight: number;
    }
  | {
      id: string;
      kind: "combo-ref";
      comboName: string;
      label?: string;
      weight: number;
    };

type CompositeTier = {
  stepId: string;
  fallbackTier?: string;
};

type CanonicalComboConfig = Record<string, unknown> & {
  nestedComboMode: "execute";
  maxRetries: 0;
  performanceTier?: ClaudePerformanceTier;
  relativePerformanceBand?: ClaudePerformanceTier | "special";
  pricingStructure?: PricingStructure;
  economicPool?: EconomicPool;
  accessPolicy?: "open" | "explicit";
  fallbackForTier?: ClaudePerformanceTier;
  compositeTiers?: {
    defaultTier: string;
    tiers: Record<string, CompositeTier>;
  };
  /** Operator-controlled routing keeps the graph for a later opt-back-in. */
  manualRoutingOverride?: boolean;
};

export type CanonicalComboSpec = {
  name: string;
  strategy: "priority" | "reset-aware";
  models: CanonicalComboStep[];
  config: CanonicalComboConfig;
};

export type StoredCanonicalCombo = Record<string, unknown> & {
  id?: string;
  name: string;
  strategy?: string;
  models?: unknown[];
  config?: Record<string, unknown>;
  isHidden?: boolean;
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type ManagedCanonicalCombo = StoredCanonicalCombo & {
  id: string;
  strategy: "priority" | "reset-aware";
  models: CanonicalComboStep[];
  config: CanonicalComboConfig & {
    _managedBy: typeof CANONICAL_COMBO_MANAGER;
    _managedVersion: typeof CANONICAL_COMBO_VERSION;
  };
  schemaVersion: 2;
  isHidden: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type CanonicalComboOperation =
  | { action: "create"; name: string; combo: ManagedCanonicalCombo }
  | {
      action: "update";
      name: string;
      combo: ManagedCanonicalCombo;
      previousUpdatedAt: string;
    }
  | {
      action: "delete";
      name: string;
      combo: StoredCanonicalCombo & { id: string };
      previousUpdatedAt: string;
    };

export type CanonicalComboConflict = {
  name: string;
  action: "update" | "delete";
  reason: "requires --adopt";
};

export type CanonicalComboReconciliationPlan = {
  manager: typeof CANONICAL_COMBO_MANAGER;
  version: typeof CANONICAL_COMBO_VERSION;
  operations: CanonicalComboOperation[];
  conflicts: CanonicalComboConflict[];
  drift: boolean;
};

export type CanonicalComboManifest = {
  manager: typeof CANONICAL_COMBO_MANAGER;
  version: typeof CANONICAL_COMBO_VERSION;
  combos: CanonicalComboSpec[];
  obsoleteNames: string[];
};

const OBSOLETE_MANAGED_NAMES = Object.freeze([
  "pool-haiku-paid",
  "pool-sonnet-paid",
  "pool-sonnet-reserve-credits",
  "pool-opus-paid",
  "pool-fable-free",
  "pool-fable-paid",
  "pool-fable-premium",
]);

// Preview aliases remain forbidden unless the operator has identified the model and
// the mapping is recorded in tierEvidence.ts. Keep this exception exact and narrow.
const IDENTIFIED_PREVIEW_MODELS = new Set([
  "opencode-zen/x-preview-f-free",
  "opencode/x-preview-f-free",
]);

export const DOCUMENTED_MODEL_EXCLUSIONS = Object.freeze([
  "mistral/labs-leanstral-2603",
  "nara/laguna-s-2.1",
]);

const HAIKU_FREE_MODELS = Object.freeze([
  "opencode-zen/nemotron-3.5-lightning-free",
  // NIMStats leaders within NVIDIA's shared provider-wide 40 RPM pool.
  "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/openai/gpt-oss-20b",
  "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
  // Shared 10k-neuron daily Cloudflare pool, ordered by observed value.
  "cloudflare-ai/@cf/qwen/qwen3-30b-a3b-fp8",
  "cloudflare-ai/@cf/zai-org/glm-4.7-flash",
  "cloudflare-ai/@cf/openai/gpt-oss-20b",
  "llm7/gemini-3.1-flash-lite",
  "ollama-cloud/nemotron-3-nano:30b",
  "ollama-cloud/gpt-oss:20b",
  "ollama-cloud/gemma4:31b",
  "gemini/gemini-3.5-flash-lite",
  "gemini/gemini-3.1-flash-lite",
  "gemini/gemma-4-31b-it",
  "gemini/gemma-4-26b-a4b-it",
  "groq/qwen/qwen3.6-27b",
  "nous-research/stepfun/step-3.7-flash:free",
  "openrouter/nvidia/nemotron-3.5-lightning:free",
  "cloudflare-ai/@cf/google/gemma-4-26b-a4b-it",
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "nous-research/poolside/laguna-xs-2.1:free",
  "openrouter/poolside/laguna-xs-2.1:free",
  "openrouter/thinkingmachines/inkling-small:free",
  "openrouter/nvidia/nemotron-3-nano-30b-a3b:free",
  "groq/openai/gpt-oss-20b",
  // Recurring keyless routes with useful text fallback, but not yet promoted for tools.
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "gemini/gemini-2.5-flash-lite",
  "nara/stepfun-3.7-flash",
  // Provider-wide 1 RPM cap: retain as a late fallback only.
  "af/gpt-oss-20b",
]);

// LongCat 2.0 is promoted to the Sonnet band: the live :free route emitted a native
// tool call, and its published profile targets coding, repository edits, and agentic work.
const SONNET_FREE_MODELS = Object.freeze([
  // Six active accounts provide 200 requests/day each; live exact-output probe passed.
  "opencode-zen/nemotron-3-ultra-free",
  // Best benchmarked target in the independent non-Nemotron pool; live probe passed.
  // Operator-identified GLM-5.5 preview; probe passed, public benchmarks pending.
  "opencode-zen/x-preview-f-free",
  // Multimodal 1M-context fallback in the independent non-Nemotron pool.
  "opencode-zen/mimo-v2.5-free",
  "opencode-zen/hy3-free",
  "opencode-zen/laguna-s-2.1-free",
  "ollama-cloud/minimax-m3",
  "ollama-cloud/nemotron-3-ultra",
  "ollama-cloud/nemotron-3-super",
  "llm7/DeepSeek-V4-Flash-0731",
  "nous-research/meituan/longcat-2.0:free",
  "cloudflare-ai/@cf/openai/gpt-oss-120b",
  "cloudflare-ai/@cf/nvidia/nemotron-3-120b-a12b",
  // OpenRouter free routes share one rotating account allowance.
  "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/thinkingmachines/inkling:free",
  "openrouter/poolside/laguna-s-2.1:free",
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/z-ai/glm-5.2:free",
  "openrouter/cohere/north-mini-code:free",
  "groq/openai/gpt-oss-120b",
  // Hosted-tool specialists; capability metadata prevents caller-tool routing.
  "groq/groq/compound",
  "groq/groq/compound-mini",
  // Each route has a model-scoped quota across seven independent Gemini projects.
  "gemini/gemini-3.7-flash",
  "gemini/gemini-3.6-flash",
  "gemini/gemini-3.5-flash",
  "gemini/gemini-3-flash",
  // Highest-value quality targets in NVIDIA's shared provider-wide 40 RPM pool.
  "nvidia/thinkingmachines/inkling",
  "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/nvidia/nemotron-3-super-120b-a12b",
  "nous-research/tencent/hy3:free",
  "nous-research/upstage/solar-pro4:free",
  "nous-research/poolside/laguna-s-2.1:free",
  "command-code/stealth/ox-alpha",
  "command-code/poolside/laguna-s-2.1-free",
  "opencode/x-preview-f-free",
  "opencode/mimo-v2.5-free",
  "opencode/hy3-free",
  "opencode/laguna-s-2.1-free",
  "gemini/gemini-3-flash-preview",
  "mistral/devstral-latest",
  // Provider-wide 1 RPM cap: retain as a late high-quality fallback only.
  "af/mistral-large-latest",
]);

// Exact snapshot identities above the Sonnet ceiling. Keep these out of the
// Sonnet workhorse pool even when their access happens to be free.
const OPUS_FREE_MODELS = Object.freeze([
  "opencode-zen/muse-spark-1.2-contributor-free",
  "opencode/muse-spark-1.2-contributor-free",
  "nara/qwen-3.8-max-free",
]);

function modelStep(comboName: string, model: string, index: number): CanonicalComboStep {
  const slash = model.indexOf("/");
  const providerId = slash > 0 ? model.slice(0, slash) : undefined;
  return {
    id: `${comboName}-model-${index + 1}`,
    kind: "model",
    model,
    ...(providerId ? { providerId } : {}),
    weight: 0,
  };
}

function comboRefStep(id: string, comboName: string, label?: string): CanonicalComboStep {
  return {
    id,
    kind: "combo-ref",
    comboName,
    weight: 0,
    ...(label ? { label } : {}),
  };
}

function leafCombo(
  name: string,
  strategy: CanonicalComboSpec["strategy"],
  models: readonly string[],
  metadata: {
    performanceTier?: ClaudePerformanceTier;
    relativePerformanceBand?: ClaudePerformanceTier | "special";
    pricingStructure?: PricingStructure;
    economicPool?: EconomicPool;
    accessPolicy?: "open" | "explicit";
    fallbackForTier?: ClaudePerformanceTier;
  } = {}
): CanonicalComboSpec {
  return {
    name,
    strategy,
    models: models.map((model, index) => modelStep(name, model, index)),
    config: { nestedComboMode: "execute", maxRetries: 0, ...metadata },
  };
}

function parentCombo(
  name: string,
  tiers: Array<{ name: string; comboName: string }>,
  performanceTier?: ClaudePerformanceTier,
  relativePerformanceBand?: ClaudePerformanceTier | "special"
): CanonicalComboSpec {
  const models = tiers.map((tier) =>
    comboRefStep(`${name}-tier-${tier.name}`, tier.comboName, tier.name)
  );
  const tierConfig: Record<string, CompositeTier> = {};
  tiers.forEach((tier, index) => {
    tierConfig[tier.name] = {
      stepId: models[index].id,
      ...(tiers[index + 1] ? { fallbackTier: tiers[index + 1].name } : {}),
    };
  });
  return {
    name,
    strategy: "priority",
    models,
    config: {
      nestedComboMode: "execute",
      maxRetries: 0,
      ...(performanceTier ? { performanceTier } : {}),
      ...(relativePerformanceBand ? { relativePerformanceBand } : {}),
      compositeTiers: { defaultTier: tiers[0].name, tiers: tierConfig },
    },
  };
}

function aliasCombo(name: string, target: string): CanonicalComboSpec {
  return {
    name,
    strategy: "priority",
    models: [comboRefStep(`${name}-target`, target, target)],
    config: { nestedComboMode: "execute", maxRetries: 0 },
  };
}

const CANONICAL_COMBOS: CanonicalComboSpec[] = [
  leafCombo("pool-haiku-free", "reset-aware", HAIKU_FREE_MODELS, {
    performanceTier: "haiku",
    pricingStructure: "free",
    economicPool: "free",
  }),
  leafCombo("pool-haiku-antigravity", "reset-aware", ["antigravity/gemini-2.5-flash"], {
    performanceTier: "haiku",
    pricingStructure: "subscription",
    economicPool: "cheap_subscription",
  }),
  leafCombo("pool-luna-free", "reset-aware", SONNET_FREE_MODELS, {
    economicPool: "free",
    relativePerformanceBand: "sonnet",
  }),
  leafCombo(
    "pool-luna-antigravity",
    "reset-aware",
    ["antigravity/gemini-3.6-flash-medium", "antigravity/claude-sonnet-4-6"],
    { economicPool: "cheap_subscription", relativePerformanceBand: "sonnet" }
  ),
  leafCombo(
    "pool-luna-credits",
    "reset-aware",
    [
      "longcat/LongCat-2.0",
      "mistral/mistral-medium-latest",
      "mistral/mistral-large-latest",
      "mistral/zai-glm-5-2",
    ],
    { economicPool: "raw_credits", relativePerformanceBand: "sonnet" }
  ),
  leafCombo("pool-luna-codex", "priority", ["codex/gpt-5.6-luna"], {
    economicPool: "raw_credits",
    relativePerformanceBand: "sonnet",
  }),
  leafCombo("pool-sonnet-free", "reset-aware", SONNET_FREE_MODELS, {
    performanceTier: "sonnet",
    pricingStructure: "free",
    economicPool: "free",
  }),
  leafCombo(
    "pool-sonnet-antigravity",
    "reset-aware",
    ["antigravity/gemini-3.6-flash-medium", "antigravity/claude-sonnet-4-6"],
    {
      performanceTier: "sonnet",
      pricingStructure: "subscription",
      economicPool: "cheap_subscription",
    }
  ),
  leafCombo(
    "pool-sonnet-credits",
    "reset-aware",
    [
      "longcat/LongCat-2.0",
      "mistral/mistral-medium-latest",
      "mistral/mistral-large-latest",
      "mistral/zai-glm-5-2",
    ],
    {
      performanceTier: "sonnet",
      pricingStructure: "credits",
      economicPool: "raw_credits",
    }
  ),
  leafCombo("pool-opus-free", "reset-aware", OPUS_FREE_MODELS, {
    performanceTier: "opus",
    pricingStructure: "free",
    economicPool: "free",
  }),
  leafCombo(
    "pool-opus-antigravity",
    "reset-aware",
    ["antigravity/gemini-3.7-flash-high", "antigravity/claude-opus-4-6-thinking"],
    {
      performanceTier: "opus",
      pricingStructure: "subscription",
      economicPool: "expensive_subscription",
    }
  ),
  leafCombo("pool-opus-credits", "reset-aware", ["agentrouter/claude-opus-4-8"], {
    performanceTier: "opus",
    pricingStructure: "credits",
    economicPool: "raw_credits",
    accessPolicy: "explicit",
  }),
  leafCombo("pool-opus-codex", "priority", ["codex/gpt-5.6-sol"], {
    performanceTier: "opus",
    pricingStructure: "api",
    economicPool: "raw_credits",
  }),
  leafCombo(
    "pool-fable-antigravity",
    "reset-aware",
    ["antigravity/gemini-3.7-flash-high", "antigravity/claude-opus-4-6-thinking"],
    {
      relativePerformanceBand: "opus",
      fallbackForTier: "fable",
      pricingStructure: "subscription",
      economicPool: "expensive_subscription",
    }
  ),
  leafCombo("pool-fable-credits", "reset-aware", ["command-code/meta/muse-spark-1.2-contributor"], {
    relativePerformanceBand: "opus",
    fallbackForTier: "fable",
    pricingStructure: "credits",
    economicPool: "raw_credits",
  }),
  leafCombo(
    "pool-fable-reserve-credits",
    "reset-aware",
    ["agentrouter/gpt-5.6-sol", "agentrouter/claude-opus-5"],
    {
      relativePerformanceBand: "opus",
      fallbackForTier: "fable",
      pricingStructure: "credits",
      economicPool: "raw_credits",
      accessPolicy: "explicit",
    }
  ),
  leafCombo("pool-fable-codex", "priority", ["codex/gpt-5.6-sol-max"], {
    performanceTier: "fable",
    pricingStructure: "api",
    economicPool: "raw_credits",
  }),
  leafCombo("pool-sol-codex", "priority", ["codex/gpt-5.6-sol"], {
    economicPool: "raw_credits",
    relativePerformanceBand: "opus",
    accessPolicy: "explicit",
  }),
  leafCombo("pool-terra-codex", "priority", ["codex/gpt-5.6-terra"], {
    economicPool: "raw_credits",
  }),
  parentCombo(
    "pool-haiku",
    [
      { name: "free", comboName: "pool-haiku-free" },
      { name: "antigravity", comboName: "pool-haiku-antigravity" },
    ],
    "haiku"
  ),
  parentCombo(
    "pool-sonnet",
    [
      { name: "free", comboName: "pool-sonnet-free" },
      { name: "antigravity", comboName: "pool-sonnet-antigravity" },
      { name: "credits", comboName: "pool-sonnet-credits" },
    ],
    "sonnet"
  ),
  parentCombo(
    "pool-luna",
    [
      { name: "free", comboName: "pool-luna-free" },
      { name: "antigravity", comboName: "pool-luna-antigravity" },
      { name: "credits", comboName: "pool-luna-credits" },
      { name: "codex", comboName: "pool-luna-codex" },
    ],
    undefined,
    "sonnet"
  ),
  parentCombo(
    "pool-terra",
    [
      { name: "antigravity", comboName: "pool-sonnet-antigravity" },
      { name: "credits", comboName: "pool-sonnet-credits" },
      { name: "free", comboName: "pool-sonnet-free" },
      { name: "codex", comboName: "pool-terra-codex" },
    ],
    undefined,
    "sonnet"
  ),
  parentCombo(
    "pool-opus",
    [
      { name: "free", comboName: "pool-opus-free" },
      { name: "antigravity", comboName: "pool-opus-antigravity" },
      { name: "codex-workhorse", comboName: "pool-opus-codex" },
      { name: "reserve", comboName: "pool-opus-credits" },
    ],
    "opus"
  ),
  parentCombo(
    "pool-fable",
    [
      { name: "codex-fable", comboName: "pool-fable-codex" },
      { name: "antigravity-fallback", comboName: "pool-fable-antigravity" },
      { name: "credits-fallback", comboName: "pool-fable-credits" },
      { name: "reserve", comboName: "pool-fable-reserve-credits" },
    ],
    "fable"
  ),
  aliasCombo("gpt-5.4-mini", "pool-haiku"),
  aliasCombo("gpt-5.6-luna", "pool-luna"),
  aliasCombo("gpt-5.6-terra", "pool-terra"),
  {
    ...aliasCombo("gpt-5.6-sol", "pool-sol-codex"),
    config: { nestedComboMode: "execute", maxRetries: 0, accessPolicy: "explicit" },
  },
  aliasCombo("claude-haiku-4-5-20251001", "pool-haiku"),
  aliasCombo("claude-sonnet-4-6", "pool-sonnet"),
  aliasCombo("claude-opus-4-8", "pool-opus"),
  aliasCombo("claude-sonnet-5", "pool-sonnet"),
  aliasCombo("claude-opus-5", "pool-opus"),
  aliasCombo("claude-fable-5", "pool-fable"),
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function getReferencedComboNames(combo: CanonicalComboSpec): string[] {
  return combo.models
    .filter(
      (step): step is Extract<CanonicalComboStep, { kind: "combo-ref" }> =>
        step.kind === "combo-ref"
    )
    .map((step) => step.comboName);
}

export function getCanonicalComboManifest(): CanonicalComboManifest {
  return {
    manager: CANONICAL_COMBO_MANAGER,
    version: CANONICAL_COMBO_VERSION,
    combos: clone(CANONICAL_COMBOS),
    obsoleteNames: [...OBSOLETE_MANAGED_NAMES],
  };
}

export function validateCanonicalComboManifest(
  manifest: CanonicalComboManifest = getCanonicalComboManifest()
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const names = new Set<string>();
  for (const combo of manifest.combos) {
    if (!combo.name || names.has(combo.name)) {
      errors.push(`duplicate or empty combo name: ${String(combo.name)}`);
    }
    names.add(combo.name);
    if (combo.config.nestedComboMode !== "execute" || combo.config.maxRetries !== 0) {
      errors.push(`${combo.name} must use nestedComboMode=execute and maxRetries=0`);
    }
    for (const step of combo.models) {
      if (
        step.kind === "model" &&
        /x-preview/i.test(step.model) &&
        !IDENTIFIED_PREVIEW_MODELS.has(step.model)
      ) {
        errors.push(`${combo.name} contains forbidden x-preview model ${step.model}`);
      }
    }

    const composite = combo.config.compositeTiers;
    if (composite) {
      const stepIds = new Set(combo.models.map((step) => step.id));
      const tiers = composite.tiers;
      if (!tiers[composite.defaultTier]) {
        errors.push(`${combo.name} composite default tier is missing`);
      }
      for (const [tierName, tier] of Object.entries(tiers)) {
        if (!stepIds.has(tier.stepId)) {
          errors.push(`${combo.name} tier ${tierName} references missing step ${tier.stepId}`);
        }
        if (tier.fallbackTier && !tiers[tier.fallbackTier]) {
          errors.push(
            `${combo.name} tier ${tierName} references missing fallback ${tier.fallbackTier}`
          );
        }
      }
      let tier: string | undefined = composite.defaultTier;
      const seenTiers = new Set<string>();
      while (tier) {
        if (seenTiers.has(tier)) {
          errors.push(`${combo.name} composite tier cycle at ${tier}`);
          break;
        }
        seenTiers.add(tier);
        tier = tiers[tier]?.fallbackTier;
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byName = new Map(manifest.combos.map((combo) => [combo.name, combo]));
  function visit(name: string, path: string[]): void {
    if (visiting.has(name)) {
      errors.push(`combo reference cycle: ${[...path, name].join(" -> ")}`);
      return;
    }
    if (visited.has(name)) return;
    visiting.add(name);
    const combo = byName.get(name);
    if (combo) {
      for (const reference of getReferencedComboNames(combo)) {
        if (!byName.has(reference)) {
          errors.push(`${name} references missing combo ${reference}`);
          continue;
        }
        visit(reference, [...path, name]);
      }
    }
    visiting.delete(name);
    visited.add(name);
  }
  for (const name of names) visit(name, []);

  return { ok: errors.length === 0, errors };
}

function isOwned(combo: StoredCanonicalCombo): boolean {
  return (
    combo.config?._managedBy === CANONICAL_COMBO_MANAGER &&
    combo.config?.manualRoutingOverride !== true
  );
}

function mergeDesiredCombo(
  existing: StoredCanonicalCombo | null,
  spec: CanonicalComboSpec,
  now: string,
  sortOrder: number
): ManagedCanonicalCombo {
  const existingConfig = isRecord(existing?.config) ? existing.config : {};
  const config = {
    ...existingConfig,
    ...clone(spec.config),
    _managedBy: CANONICAL_COMBO_MANAGER,
    _managedVersion: CANONICAL_COMBO_VERSION,
  } as ManagedCanonicalCombo["config"];
  if (!spec.config.compositeTiers) delete config.compositeTiers;
  for (const key of [
    "performanceTier",
    "relativePerformanceBand",
    "pricingStructure",
    "economicPool",
    "accessPolicy",
    "fallbackForTier",
  ] as const) {
    if (!(key in spec.config)) delete config[key];
  }

  return {
    ...(existing || {}),
    id: existing?.id || `managed-${spec.name}`,
    name: spec.name,
    schemaVersion: 2,
    models: clone(spec.models),
    strategy: spec.strategy,
    config,
    isHidden: !VISIBLE_CANONICAL_COMBOS.has(spec.name),
    sortOrder: Number.isFinite(existing?.sortOrder) ? (existing?.sortOrder as number) : sortOrder,
    createdAt: existing?.createdAt || now,
    updatedAt: existing?.updatedAt || now,
  };
}

function comparable(combo: StoredCanonicalCombo | null): Record<string, unknown> | null {
  if (!combo) return null;
  const copy = clone(combo);
  delete copy.updatedAt;
  return copy;
}

export function planCanonicalComboReconciliation(
  existingCombos: StoredCanonicalCombo[],
  { adopt = false, now = new Date().toISOString() }: { adopt?: boolean; now?: string } = {}
): CanonicalComboReconciliationPlan {
  const manifest = getCanonicalComboManifest();
  const validation = validateCanonicalComboManifest(manifest);
  if (!validation.ok) {
    throw new Error(`Invalid canonical combo manifest: ${validation.errors.join("; ")}`);
  }

  const byName = new Map(existingCombos.map((combo) => [combo.name, combo]));
  const maxSortOrder = existingCombos.reduce(
    (maximum, combo) => Math.max(maximum, Number(combo.sortOrder) || 0),
    0
  );
  const operations: CanonicalComboOperation[] = [];
  const conflicts: CanonicalComboConflict[] = [];
  let nextSortOrder = maxSortOrder + 1;

  for (const spec of manifest.combos) {
    const existing = byName.get(spec.name) || null;
    // An operator may take a managed pool over temporarily. Preserve both its
    // hand-authored steps and its canonical graph, and resume reconciliation
    // only when the override is explicitly cleared.
    if (existing?.config?.manualRoutingOverride === true) continue;
    if (existing && !isOwned(existing) && !adopt) {
      const prospective = mergeDesiredCombo(existing, spec, now, nextSortOrder);
      if (!equalValue(comparable(existing), comparable(prospective))) {
        conflicts.push({ name: spec.name, action: "update", reason: "requires --adopt" });
      }
      continue;
    }

    const desired = mergeDesiredCombo(existing, spec, now, nextSortOrder);
    if (!existing) {
      operations.push({ action: "create", name: spec.name, combo: desired });
      nextSortOrder += 1;
      continue;
    }
    if (!equalValue(comparable(existing), comparable(desired))) {
      desired.updatedAt = now;
      operations.push({
        action: "update",
        name: spec.name,
        combo: desired,
        previousUpdatedAt: existing.updatedAt || "",
      });
    }
  }

  for (const name of manifest.obsoleteNames) {
    const existing = byName.get(name);
    if (!existing) continue;
    if (!isOwned(existing) && !adopt) {
      conflicts.push({ name, action: "delete", reason: "requires --adopt" });
      continue;
    }
    if (!existing.id) throw new Error(`Stored combo ${name} has no id`);
    operations.push({
      action: "delete",
      name,
      combo: existing as StoredCanonicalCombo & { id: string },
      previousUpdatedAt: existing.updatedAt || "",
    });
  }

  return {
    manager: manifest.manager,
    version: manifest.version,
    operations,
    conflicts,
    drift: operations.length > 0 || conflicts.length > 0,
  };
}
