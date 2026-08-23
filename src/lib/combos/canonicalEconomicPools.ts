/**
 * Canonical economic/performance combo manifest and reconciliation planner.
 *
 * This module is side-effect free. Persistence lives in the matching db domain module so tests,
 * deployment gates, and the operator CLI all consume one typed manifest and safety policy.
 */

import type { ClaudePerformanceTier, PricingStructure } from "./tierEvidence";

export const CANONICAL_COMBO_MANAGER = "canonical-economic-pools";
export const CANONICAL_COMBO_VERSION = 4;

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
  accessPolicy?: "open" | "explicit";
  compositeTiers?: {
    defaultTier: string;
    tiers: Record<string, CompositeTier>;
  };
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
  "pool-opus-free",
  "pool-opus-paid",
  "pool-fable-free",
  "pool-fable-paid",
]);

const HAIKU_FREE_MODELS = Object.freeze([
  "gemini/gemini-3.5-flash-lite",
  "groq/qwen/qwen3.6-27b",
  "nous-research/stepfun/step-3.7-flash:free",
  "openrouter/nvidia/nemotron-3.5-lightning:free",
  "cloudflare-ai/@cf/google/gemma-4-26b-a4b-it",
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "groq/openai/gpt-oss-120b",
  "nous-research/poolside/laguna-xs-2.1:free",
  "openrouter/poolside/laguna-xs-2.1:free",
  "groq/openai/gpt-oss-20b",
  "openrouter/openai/gpt-oss-20b:free",
  // Recurring keyless routes with useful text fallback, but not yet promoted for tools.
  "opencode/nemotron-3-ultra-free",
  "opencode/nemotron-3.5-lightning-free",
  "gemini/gemini-2.5-flash-lite",
]);

// LongCat 2.0 is promoted to the Sonnet band: the live :free route emitted a native
// tool call, and its published profile targets coding, repository edits, and agentic work.
const SONNET_FREE_MODELS = Object.freeze([
  "nous-research/meituan/longcat-2.0:free",
  "nvidia/z-ai/glm-5.2",
  "nvidia/nvidia/nemotron-3-super-120b-a12b",
  "nous-research/tencent/hy3:free",
  "nous-research/upstage/solar-pro4:free",
  "nous-research/poolside/laguna-s-2.1:free",
  "opencode/mimo-v2.5-free",
  "cloudflare-ai/@cf/qwen/qwen2.5-coder-32b-instruct",
  "gemini/gemini-3-flash-preview",
  "mistral/devstral-latest",
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
    accessPolicy?: "open" | "explicit";
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
  }),
  leafCombo("pool-haiku-antigravity", "reset-aware", ["antigravity/gemini-2.5-flash"], {
    performanceTier: "haiku",
    pricingStructure: "subscription",
  }),
  leafCombo("pool-luna-free", "reset-aware", HAIKU_FREE_MODELS),
  leafCombo("pool-luna-antigravity", "reset-aware", ["antigravity/gemini-2.5-flash"]),
  leafCombo("pool-luna-credits", "reset-aware", ["command-code/poolside/laguna-s-2.1-free"]),
  leafCombo("pool-luna-codex", "priority", ["codex/gpt-5.6-luna"]),
  leafCombo("pool-sonnet-free", "reset-aware", SONNET_FREE_MODELS, {
    performanceTier: "sonnet",
    pricingStructure: "free",
  }),
  leafCombo(
    "pool-sonnet-antigravity",
    "reset-aware",
    ["antigravity/gemini-3.6-flash-medium", "antigravity/claude-sonnet-4-6"],
    { performanceTier: "sonnet", pricingStructure: "subscription" }
  ),
  leafCombo("pool-sonnet-credits", "reset-aware", ["command-code/poolside/laguna-s-2.1-free"], {
    performanceTier: "sonnet",
    pricingStructure: "credits",
  }),
  leafCombo(
    "pool-opus-antigravity",
    "reset-aware",
    ["antigravity/gemini-3.7-flash-tiered", "antigravity/claude-opus-4-6-thinking"],
    { performanceTier: "opus", pricingStructure: "subscription" }
  ),
  leafCombo("pool-opus-credits", "reset-aware", ["agentrouter/claude-opus-5"], {
    performanceTier: "opus",
    pricingStructure: "credits",
  }),
  leafCombo("pool-opus-codex", "priority", ["codex/gpt-5.6-luna"], {
    performanceTier: "opus",
    pricingStructure: "api",
  }),
  leafCombo(
    "pool-fable-antigravity",
    "reset-aware",
    ["antigravity/gemini-3.7-flash-tiered", "antigravity/claude-opus-4-6-thinking"],
    { performanceTier: "fable", pricingStructure: "subscription" }
  ),
  leafCombo(
    "pool-fable-credits",
    "reset-aware",
    ["agentrouter/claude-opus-5", "command-code/meta/muse-spark-1.2-contributor"],
    { performanceTier: "fable", pricingStructure: "credits" }
  ),
  leafCombo("pool-fable-codex", "priority", ["codex/gpt-5.6-terra"], {
    performanceTier: "fable",
    pricingStructure: "api",
  }),
  leafCombo("pool-fable-premium", "priority", ["codex/gpt-5.6-sol"], {
    relativePerformanceBand: "special",
    pricingStructure: "api",
    accessPolicy: "explicit",
  }),
  leafCombo("pool-sol-codex", "priority", ["codex/gpt-5.6-sol"], { accessPolicy: "explicit" }),
  leafCombo("pool-terra-codex", "priority", ["codex/gpt-5.6-terra"]),
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
  parentCombo("pool-luna", [
    { name: "free", comboName: "pool-luna-free" },
    { name: "antigravity", comboName: "pool-luna-antigravity" },
    { name: "credits", comboName: "pool-luna-credits" },
    { name: "codex", comboName: "pool-luna-codex" },
  ]),
  parentCombo(
    "pool-terra",
    [
      { name: "antigravity", comboName: "pool-sonnet-antigravity" },
      { name: "credits", comboName: "pool-sonnet-credits" },
      { name: "free", comboName: "pool-sonnet-free" },
      { name: "codex", comboName: "pool-terra-codex" },
    ],
    undefined,
    "fable"
  ),
  parentCombo(
    "pool-opus",
    [
      { name: "antigravity", comboName: "pool-opus-antigravity" },
      { name: "credits", comboName: "pool-opus-credits" },
      { name: "codex", comboName: "pool-opus-codex" },
    ],
    "opus"
  ),
  parentCombo(
    "pool-fable",
    [
      { name: "antigravity", comboName: "pool-fable-antigravity" },
      { name: "credits", comboName: "pool-fable-credits" },
      { name: "codex", comboName: "pool-fable-codex" },
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
      if (step.kind === "model" && /x-preview/i.test(step.model)) {
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
  return combo.config?._managedBy === CANONICAL_COMBO_MANAGER;
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

  return {
    ...(existing || {}),
    id: existing?.id || `managed-${spec.name}`,
    name: spec.name,
    schemaVersion: 2,
    models: clone(spec.models),
    strategy: spec.strategy,
    config,
    isHidden: Boolean(existing?.isHidden),
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
