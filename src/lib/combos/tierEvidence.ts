/** Source-backed performance, price, and availability policy for managed pools. */

import {
  assignPerformanceBands,
  type ModelPerformanceEvidence,
  type PerformanceBand,
} from "./economicPoolDerivation.ts";

export type ClaudePerformanceTier = "haiku" | "sonnet" | "opus" | "fable";
export type PerformanceClassification = ClaudePerformanceTier | "unranked";
export type PricingStructure = "free" | "subscription" | "credits" | "api" | "unknown";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ComparativeBenchmarkEvidence = {
  model: string;
  effort: ReasoningEffort;
  artificialAnalysisIndex?: number;
  artificialAnalysisMarked?: boolean;
  arenaCodeRank?: number;
  arenaCodeTotal?: number;
  officialBenchmarkTier?: ClaudePerformanceTier;
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
  source: readonly string[];
};

export type ClaudeTierEvidence = {
  tier: ClaudePerformanceTier;
  model: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  performanceScore: number;
  pricingStructures: readonly PricingStructure[];
  source: string;
};

/** Provider-scoped benchmark evidence; scores must not be generalized to other hosts. */
export type ProviderBenchmarkEvidence = {
  provider: string;
  model: string;
  compositeScore: number;
  successRate: number;
  runs: number;
  source: string;
};

/** Catalog research used to nominate models for probing; it is not benchmark evidence. */
export type ProviderCatalogSelectionEvidence = {
  provider: string;
  model: string;
  routedModel: string;
  intendedTier: ClaudePerformanceTier;
  access: "free" | "subscription" | "credits" | "api";
  operationalStatus: "operational" | "degraded" | "unknown";
  requestLimit?: string;
  quotaPool?: string;
  inputUsdPer1M?: number;
  outputUsdPer1M?: number;
  probeStatus: "unprobed" | "passed" | "failed" | "inconclusive";
  rationale: string;
  validationNote?: string;
  source: string;
  observedAt: string;
};

/**
 * Api.Airforce free-catalog selection supplied from its live dashboard.
 * Mistral Large is selected for catalog-level general performance; the entry
 * deliberately remains unprobed and must not be treated as benchmark evidence.
 */
export const PROVIDER_CATALOG_SELECTION_EVIDENCE: readonly ProviderCatalogSelectionEvidence[] =
  Object.freeze([
    ...[
      ["nemotron-3-ultra-free", "sonnet", "nemotron", "Maximum-quality Nemotron target"],
      ["nemotron-3.5-lightning-free", "haiku", "nemotron", "Fast Nemotron economy target"],
      ["muse-spark-1.2-contributor-free", "sonnet", "non-nemotron", "Agentic value target"],
      ["x-preview-f-free", "sonnet", "non-nemotron", "Operator-identified GLM-5.5 preview"],
      ["mimo-v2.5-free", "sonnet", "non-nemotron", "Multimodal 1M-context fallback"],
      ["hy3-free", "sonnet", "non-nemotron", "Agentic fallback"],
      ["laguna-s-2.1-free", "sonnet", "non-nemotron", "Coding specialist"],
    ].map(([model, intendedTier, quotaPool, rationale]) => ({
      provider: "opencode",
      model,
      routedModel: `opencode/${model}`,
      intendedTier: intendedTier as "haiku" | "sonnet",
      access: "free" as const,
      operationalStatus: "operational" as const,
      requestLimit: "200 requests/day/connection; 1 active connection",
      quotaPool: `opencode:${quotaPool}`,
      probeStatus: "passed" as const,
      rationale,
      validationNote: "Same backend and catalog as OpenCode Zen; separate direct connection",
      source: "operator-supplied backend identity, quota, and model availability",
      observedAt: "2026-08-23",
    })),
    ...[
      ["gemini-2.5-flash", "haiku", "High-volume low-latency subscription backbone"],
      ["gemini-3.6-flash-medium", "sonnet", "Protocol-capable balanced quality target"],
      ["gemini-3.7-flash-high", "opus", "High-reasoning Gemini subscription target"],
    ].map(([model, intendedTier, rationale]) => ({
      provider: "antigravity",
      model,
      routedModel: `antigravity/${model}`,
      intendedTier: intendedTier as ClaudePerformanceTier,
      access: "subscription" as const,
      operationalStatus: "operational" as const,
      requestLimit: ">1,000 requests/account/day; 4 active accounts; >4,000 aggregate RPD floor",
      quotaPool: "antigravity-gemini",
      probeStatus: "passed" as const,
      rationale,
      validationNote: "Generous Gemini pool is independent from the scarce non-Gemini pool",
      source: "operator-supplied account quota and active connection count",
      observedAt: "2026-08-23",
    })),
    ...[
      ["claude-sonnet-4-6", "sonnet", "Scarce protocol-capable Sonnet quality fallback"],
      ["claude-opus-4-6-thinking", "opus", "Scarce highest-quality Claude fallback"],
    ].map(([model, intendedTier, rationale]) => ({
      provider: "antigravity",
      model,
      routedModel: `antigravity/${model}`,
      intendedTier: intendedTier as "sonnet" | "opus",
      access: "subscription" as const,
      operationalStatus: "operational" as const,
      requestLimit: "Scarce non-Gemini allowance; exact limit not supplied; 4 active accounts",
      quotaPool: "antigravity-non-gemini",
      probeStatus: "passed" as const,
      rationale,
      validationNote: "Keep behind Gemini targets; this pool is independent and scarce",
      source: "operator-supplied quota-pool topology and active connection count",
      observedAt: "2026-08-23",
    })),
    ...[
      ["stealth/ox-alpha", "Unscored 1M-context multimodal reasoning candidate"],
      ["poolside/laguna-s-2.1-free", "Free coding specialist with strong Laguna benchmarks"],
    ].map(([model, rationale]) => ({
      provider: "command-code",
      model,
      routedModel: `command-code/${model}`,
      intendedTier: "sonnet" as const,
      access: "free" as const,
      operationalStatus: "operational" as const,
      requestLimit: "Free model; request allowance and reset period not supplied",
      quotaPool: "command-code-free-topology-unverified",
      inputUsdPer1M: 0,
      outputUsdPer1M: 0,
      probeStatus: "unprobed" as const,
      rationale,
      validationNote:
        "Three connections observed; do not aggregate until account independence is confirmed",
      source: "operator-supplied Command Code model catalog",
      observedAt: "2026-08-23",
    })),
    ...[
      ["nvidia/nemotron-3.5-lightning:free", "haiku", "Fast 1M-context agentic fallback"],
      ["poolside/laguna-xs-2.1:free", "haiku", "Fast coding fallback"],
      ["thinkingmachines/inkling-small:free", "haiku", "Fast 262K-context reasoning fallback"],
      ["nvidia/nemotron-3-nano-30b-a3b:free", "haiku", "High-throughput reasoning fallback"],
      ["nvidia/nemotron-3-ultra-550b-a55b:free", "sonnet", "Highest-quality Nemotron route"],
      ["thinkingmachines/inkling:free", "sonnet", "Reliable independent-model fallback"],
      ["poolside/laguna-s-2.1:free", "sonnet", "Strong coding specialist"],
      ["nvidia/nemotron-3-super-120b-a12b:free", "sonnet", "Efficient agentic quality fallback"],
      ["z-ai/glm-5.2:free", "sonnet", "Long-context agentic coding fallback"],
      ["cohere/north-mini-code:free", "sonnet", "Dedicated code-model fallback"],
    ].map(([model, intendedTier, rationale]) => ({
      provider: "openrouter",
      model,
      routedModel: `openrouter/${model}`,
      intendedTier: intendedTier as "haiku" | "sonnet",
      access: "free" as const,
      operationalStatus: "operational" as const,
      requestLimit: "Shared free-model request allowance; exact account limit not supplied",
      quotaPool: "openrouter-free-shared",
      probeStatus: "unprobed" as const,
      rationale,
      validationNote: "Live zero-price catalog confirmed; re-probe because free endpoints rotate",
      source: "https://openrouter.ai/api/v1/models",
      observedAt: "2026-08-23",
    })),
    ...[
      ["poolside/laguna-xs-2.1:free", "haiku", "Fast coding fallback"],
      ["stepfun/step-3.7-flash:free", "haiku", "Fast vision-capable general fallback"],
      ["poolside/laguna-s-2.1:free", "sonnet", "Coding specialist with SWE-Bench Pro 59.4"],
      ["tencent/hy3:free", "sonnet", "Agentic fallback with reported Terminal-Bench 71.7"],
      ["upstage/solar-pro4:free", "sonnet", "High-quality general and coding fallback"],
      ["meituan/longcat-2.0:free", "sonnet", "Agentic coding and repository-work fallback"],
    ].map(([model, intendedTier, rationale]) => ({
      provider: "nous-research",
      model,
      routedModel: `nous-research/${model}`,
      intendedTier: intendedTier as "haiku" | "sonnet",
      access: "free" as const,
      operationalStatus: "operational" as const,
      requestLimit: "Runtime reports 50 quota units per connection; reset period not established",
      quotaPool: "nous-research-quota-topology-unverified",
      probeStatus: "unprobed" as const,
      rationale,
      validationNote:
        "Imported compatibility confirmed; do not aggregate two connections until account independence and reset period are verified",
      source: "operator-supplied imported model catalog plus OmniRoute runtime quota report",
      observedAt: "2026-08-23",
    })),
    ...[
      ["gemini-3.5-flash-lite", "haiku", 15, 250000, 500, "passed"],
      ["gemini-3.1-flash-lite", "haiku", 15, 250000, 500, "passed"],
      ["gemma-4-31b-it", "haiku", 30, 16000, 14400, "passed"],
      ["gemma-4-26b-a4b-it", "haiku", 30, 16000, 14400, "unprobed"],
      ["gemini-3.7-flash", "sonnet", 5, 250000, 20, "unprobed"],
      ["gemini-3.6-flash", "sonnet", 5, 250000, 20, "unprobed"],
      ["gemini-3.5-flash", "sonnet", 5, 250000, 20, "unprobed"],
      ["gemini-3-flash", "sonnet", 5, 250000, 20, "unprobed"],
    ].map(([model, intendedTier, rpm, tpm, rpd, probeStatus]) => ({
      provider: "gemini",
      model: model as string,
      routedModel: `gemini/${model}`,
      intendedTier: intendedTier as "haiku" | "sonnet",
      access: "free" as const,
      operationalStatus: "operational" as const,
      requestLimit: `${rpm} RPM; ${Number(tpm).toLocaleString("en-US")} TPM; ${Number(rpd).toLocaleString("en-US")} RPD per project; 7 independent projects`,
      quotaPool: `gemini:${model}:7-projects`,
      probeStatus: probeStatus as "passed" | "unprobed",
      rationale:
        intendedTier === "haiku"
          ? "Recurring high-volume or high-request-count direct Gemini capacity"
          : "Scarce newer-generation Flash capacity reserved for higher-value work",
      validationNote: `Aggregate ceiling across 7 projects: ${Number(rpm) * 7} RPM, ${Number(tpm) * 7} TPM, ${Number(rpd) * 7} RPD; quotas are per project, not per API key`,
      source:
        "operator-supplied AI Studio project limits plus official Gemini rate-limit documentation",
      observedAt: "2026-08-23",
    })),
    ...[
      ["mistral-small-latest", "haiku", 0.15, 0.6, "Best general-purpose monthly-credit value"],
      ["codestral-latest", "haiku", 0.3, 0.9, "Low-cost coding specialist"],
      ["mistral-medium-latest", "sonnet", 1.5, 7.5, "Highest-quality native Mistral target"],
      ["mistral-large-latest", "sonnet", 0.5, 1.5, "High-quality open-weight value target"],
      ["zai-glm-5-2", "sonnet", 1.4, 4.4, "Long-context agentic coding specialist"],
    ].map(([model, intendedTier, inputUsdPer1M, outputUsdPer1M, rationale]) => ({
      provider: "mistral",
      model: model as string,
      routedModel: `mistral/${model}`,
      intendedTier: intendedTier as "haiku" | "sonnet",
      access: "credits" as const,
      operationalStatus: "operational" as const,
      requestLimit: "$10 shared monthly API/Studio allowance; reset date is account-relative",
      quotaPool: "mistral-api-monthly-allowance",
      inputUsdPer1M: inputUsdPer1M as number,
      outputUsdPer1M: outputUsdPer1M as number,
      probeStatus: "unprobed" as const,
      rationale: rationale as string,
      validationNote: "Separate $10 Vibe Code allowance is not counted as API combo capacity",
      source: "operator-supplied Mistral subscription and pricing pages",
      observedAt: "2026-08-23",
    })),
    {
      provider: "mistral",
      model: "labs-leanstral-2603",
      routedModel: "mistral/labs-leanstral-2603",
      intendedTier: "haiku",
      access: "free",
      operationalStatus: "operational",
      quotaPool: "mistral-labs",
      probeStatus: "unprobed",
      rationale: "Free Lean 4 coding specialist; unsuitable as a general fallback",
      validationNote:
        "Cataloged for explicit use only and intentionally omitted from general pools",
      source: "operator-supplied Mistral pricing page",
      observedAt: "2026-08-23",
    },
    {
      provider: "groq",
      model: "openai/gpt-oss-120b",
      routedModel: "groq/openai/gpt-oss-120b",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "30 RPM; 1,000 RPD; 8,000 TPM; 200,000 TPD",
      quotaPool: "groq:openai/gpt-oss-120b",
      probeStatus: "unprobed",
      rationale: "Strongest direct Groq model: MMLU 90.0, GPQA Diamond 80.1, SWE-Bench 62.4",
      source: "Groq rate-limit documentation and OpenAI gpt-oss model card",
      observedAt: "2026-08-23",
    },
    ...[
      ["openai/gpt-oss-20b", "Open-weight economy reasoning and tool-use fallback"],
      ["qwen/qwen3.6-27b", "Parallel-tool-capable economy and coding fallback"],
    ].map(([model, rationale]) => ({
      provider: "groq",
      model,
      routedModel: `groq/${model}`,
      intendedTier: "haiku" as const,
      access: "free" as const,
      operationalStatus: "operational" as const,
      requestLimit: "30 RPM; 1,000 RPD; 8,000 TPM; 200,000 TPD",
      quotaPool: `groq:${model}`,
      probeStatus: "unprobed" as const,
      rationale,
      source: "Groq rate-limit and tool-use documentation",
      observedAt: "2026-08-23",
    })),
    ...[
      ["groq/compound", "Up to 10 hosted tool calls for complex research and analysis"],
      ["groq/compound-mini", "Single hosted tool call with about 3x lower average latency"],
    ].map(([model, rationale]) => ({
      provider: "groq",
      model,
      routedModel: `groq/${model}`,
      intendedTier: "sonnet" as const,
      access: "free" as const,
      operationalStatus: "operational" as const,
      requestLimit: "30 RPM; 250 RPD; 70,000 TPM; no published TPD limit",
      quotaPool: `groq:${model}`,
      probeStatus: "unprobed" as const,
      rationale,
      validationNote: "Supports Groq-hosted tools, not caller-supplied custom tools",
      source: "https://console.groq.com/docs/compound/systems",
      observedAt: "2026-08-23",
    })),
    {
      provider: "cloudflare-ai",
      model: "@cf/qwen/qwen3-30b-a3b-fp8",
      routedModel: "cloudflare-ai/@cf/qwen/qwen3-30b-a3b-fp8",
      intendedTier: "haiku",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "10,000 neurons/day; resets daily at 00:00 UTC",
      quotaPool: "cloudflare-workers-ai-neurons",
      inputUsdPer1M: 0.051,
      outputUsdPer1M: 0.335,
      probeStatus: "passed",
      rationale: "Best observed speed/value balance: 663 ms HAR probe and low neuron cost",
      source: "operator HAR probe plus Cloudflare Workers AI pricing documentation",
      observedAt: "2026-08-23",
    },
    {
      provider: "cloudflare-ai",
      model: "@cf/zai-org/glm-4.7-flash",
      routedModel: "cloudflare-ai/@cf/zai-org/glm-4.7-flash",
      intendedTier: "haiku",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "10,000 neurons/day; resets daily at 00:00 UTC",
      quotaPool: "cloudflare-workers-ai-neurons",
      inputUsdPer1M: 0.06,
      outputUsdPer1M: 0.4,
      probeStatus: "passed",
      rationale: "Low-cost reasoning fallback; HAR probe returned usable content",
      source: "operator HAR probe plus Cloudflare Workers AI pricing documentation",
      observedAt: "2026-08-23",
    },
    {
      provider: "cloudflare-ai",
      model: "@cf/google/gemma-4-26b-a4b-it",
      routedModel: "cloudflare-ai/@cf/google/gemma-4-26b-a4b-it",
      intendedTier: "haiku",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "10,000 neurons/day; resets daily at 00:00 UTC",
      quotaPool: "cloudflare-workers-ai-neurons",
      inputUsdPer1M: 0.1,
      outputUsdPer1M: 0.3,
      probeStatus: "passed",
      rationale: "Efficient multimodal-family fallback; 1,973 ms successful HAR probe",
      source: "operator HAR probe plus Cloudflare Workers AI pricing documentation",
      observedAt: "2026-08-23",
    },
    {
      provider: "cloudflare-ai",
      model: "@cf/openai/gpt-oss-20b",
      routedModel: "cloudflare-ai/@cf/openai/gpt-oss-20b",
      intendedTier: "haiku",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "10,000 neurons/day; resets daily at 00:00 UTC",
      quotaPool: "cloudflare-workers-ai-neurons",
      inputUsdPer1M: 0.2,
      outputUsdPer1M: 0.3,
      probeStatus: "passed",
      rationale: "Reliable reasoning fallback with moderate neuron cost; HAR probe passed",
      source: "operator HAR probe plus Cloudflare Workers AI pricing documentation",
      observedAt: "2026-08-23",
    },
    {
      provider: "cloudflare-ai",
      model: "@cf/openai/gpt-oss-120b",
      routedModel: "cloudflare-ai/@cf/openai/gpt-oss-120b",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "10,000 neurons/day; resets daily at 00:00 UTC",
      quotaPool: "cloudflare-workers-ai-neurons",
      inputUsdPer1M: 0.35,
      outputUsdPer1M: 0.75,
      probeStatus: "passed",
      rationale: "Best quality-per-neuron large-model candidate among successful HAR probes",
      source: "operator HAR probe plus Cloudflare Workers AI pricing documentation",
      observedAt: "2026-08-23",
    },
    {
      provider: "cloudflare-ai",
      model: "@cf/nvidia/nemotron-3-120b-a12b",
      routedModel: "cloudflare-ai/@cf/nvidia/nemotron-3-120b-a12b",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "10,000 neurons/day; resets daily at 00:00 UTC",
      quotaPool: "cloudflare-workers-ai-neurons",
      inputUsdPer1M: 0.5,
      outputUsdPer1M: 1.5,
      probeStatus: "passed",
      rationale:
        "Agentic quality fallback; successful 1,758 ms HAR probe despite higher neuron cost",
      source: "operator HAR probe plus Cloudflare Workers AI pricing documentation",
      observedAt: "2026-08-23",
    },
    {
      provider: "agentrouter",
      model: "gpt-5.6-sol",
      routedModel: "agentrouter/gpt-5.6-sol",
      intendedTier: "opus",
      access: "credits",
      operationalStatus: "operational",
      requestLimit: "Guaranteed access; one-time credit grant; grant size not recorded",
      quotaPool: "agentrouter-one-time-credits",
      inputUsdPer1M: 4,
      outputUsdPer1M: 20,
      probeStatus: "unprobed",
      rationale: "Reserve finite guaranteed frontier capacity for explicit highest-value work",
      source: "operator-supplied access and credit terms",
      observedAt: "2026-08-23",
    },
    ...[
      ["claude-opus-5", 2, 10],
      ["claude-opus-4-8", 3, 15],
    ].map(([model, inputUsdPer1M, outputUsdPer1M]) => ({
      provider: "agentrouter",
      model: model as string,
      routedModel: `agentrouter/${model}`,
      intendedTier: "opus" as const,
      access: "credits" as const,
      operationalStatus: "operational" as const,
      requestLimit: "Guaranteed access; one-time credit grant; grant size not recorded",
      quotaPool: "agentrouter-one-time-credits",
      inputUsdPer1M: inputUsdPer1M as number,
      outputUsdPer1M: outputUsdPer1M as number,
      probeStatus: "unprobed" as const,
      rationale: "Guaranteed Opus-class fallback funded by finite one-time credits",
      source: "operator-supplied access, billing, and credit terms",
      observedAt: "2026-08-23",
    })),
    {
      provider: "nvidia",
      model: "nemotron-3.5-lightning-30b-a3b",
      routedModel: "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
      intendedTier: "haiku",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "40 RPM provider-wide; no other quota reported",
      quotaPool: "nvidia-nim",
      probeStatus: "passed",
      rationale: "NIMStats leader: score 73, 96.7% success, and 113.6 tokens/s",
      source: "operator-supplied NIMStats leaderboard (720 runs, 16 models)",
      observedAt: "2026-08-23",
    },
    {
      provider: "nvidia",
      model: "gpt-oss-20b",
      routedModel: "nvidia/openai/gpt-oss-20b",
      intendedTier: "haiku",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "40 RPM provider-wide; no other quota reported",
      quotaPool: "nvidia-nim",
      probeStatus: "passed",
      rationale: "Reliable economy target: NIMStats score 68 and 100% success over 15 runs",
      source: "operator-supplied NIMStats leaderboard (720 runs, 16 models)",
      observedAt: "2026-08-23",
    },
    {
      provider: "nvidia",
      model: "thinkingmachines/inkling",
      routedModel: "nvidia/thinkingmachines/inkling",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "40 RPM provider-wide; no other quota reported",
      quotaPool: "nvidia-nim",
      probeStatus: "unprobed",
      rationale: "Most reliable Terra target: NIMStats score 70 and 100% success over 42 runs",
      validationNote: "Leaderboard evidence is strong; exact OmniRoute route remains unprobed",
      source: "operator-supplied NIMStats leaderboard (720 runs, 16 models)",
      observedAt: "2026-08-23",
    },
    {
      provider: "nvidia",
      model: "nemotron-3-ultra-550b-a55b",
      routedModel: "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "40 RPM provider-wide; no other quota reported",
      quotaPool: "nvidia-nim",
      probeStatus: "passed",
      rationale: "Best quality fallback: NIMStats score 70 and 93.3% success over 38 runs",
      source: "operator-supplied NIMStats leaderboard (720 runs, 16 models)",
      observedAt: "2026-08-23",
    },
    {
      provider: "nvidia",
      model: "nemotron-3-super-120b-a12b",
      routedModel: "nvidia/nvidia/nemotron-3-super-120b-a12b",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "40 RPM provider-wide; no other quota reported",
      quotaPool: "nvidia-nim",
      probeStatus: "passed",
      rationale: "Fast quality fallback: NIMStats score 69 and 96.7% success over 26 runs",
      source: "operator-supplied NIMStats leaderboard (720 runs, 16 models)",
      observedAt: "2026-08-23",
    },
    {
      provider: "nvidia",
      model: "nemotron-3-nano-omni-30b-a3b-reasoning",
      routedModel: "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      intendedTier: "haiku",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "40 RPM provider-wide; no other quota reported",
      quotaPool: "nvidia-nim",
      probeStatus: "passed",
      rationale: "Multimodal fallback: NIMStats score 65 and 86.7% success over 15 runs",
      source: "operator-supplied NIMStats leaderboard (720 runs, 16 models)",
      observedAt: "2026-08-23",
    },
    {
      provider: "api-airforce",
      model: "mistral-large-latest",
      routedModel: "af/mistral-large-latest",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "1 RPM",
      probeStatus: "inconclusive",
      rationale: "Highest-performance operational general-purpose model in the free catalog",
      source: "https://api.airforce/models",
      observedAt: "2026-08-23",
    },
    {
      provider: "llm7",
      model: "DeepSeek-V4-Flash-0731",
      routedModel: "llm7/DeepSeek-V4-Flash-0731",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      probeStatus: "passed",
      rationale: "Highest-performance general-purpose turbo model in the accessible catalog",
      source: "https://docs.llm7.io/models",
      observedAt: "2026-08-23",
    },
    {
      provider: "nara",
      model: "qwen-3.8-max-free",
      routedModel: "nara/qwen-3.8-max-free",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "unknown",
      probeStatus: "unprobed",
      rationale: "Highest-performance general-purpose free model in the researched Nara catalog",
      source: "https://router.bynara.id",
      observedAt: "2026-08-23",
    },
    {
      provider: "opencode-zen",
      model: "nemotron-3-ultra-free",
      routedModel: "opencode-zen/nemotron-3-ultra-free",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "200 requests/day/account; 6 active accounts observed; two quota pools",
      quotaPool: "nemotron",
      probeStatus: "passed",
      rationale: "Quality leader: 70.7 SWE-bench Verified, 89.0 LiveCodeBench, 87.0 GPQA",
      source:
        "https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3-Ultra-Technical-Report.pdf",
      observedAt: "2026-08-23",
    },
    {
      provider: "opencode-zen",
      model: "mimo-v2.5-free",
      routedModel: "opencode-zen/mimo-v2.5-free",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "200 requests/day/account; 6 active accounts observed; two quota pools",
      quotaPool: "non-nemotron",
      probeStatus: "passed",
      rationale:
        "Best evidenced independent-pool value: 1M context and native multimodal agent model",
      source: "https://mimo.mi.com/docs/en-US/news/latest/v2.5-open-sourced",
      observedAt: "2026-08-23",
    },
    {
      provider: "opencode-zen",
      model: "muse-spark-1.2-contributor-free",
      routedModel: "opencode-zen/muse-spark-1.2-contributor-free",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "200 requests/day/account; 6 active accounts observed; two quota pools",
      quotaPool: "non-nemotron",
      probeStatus: "passed",
      rationale: "Best non-Nemotron agentic value: Intelligence Index 54 and Terminal-Bench 82.9",
      source: "https://artificialanalysis.ai/models/muse-spark-1-2/",
      observedAt: "2026-08-23",
    },
    {
      provider: "opencode-zen",
      model: "x-preview-f-free",
      routedModel: "opencode-zen/x-preview-f-free",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "200 requests/day/account; 6 active accounts observed; two quota pools",
      quotaPool: "non-nemotron",
      probeStatus: "passed",
      rationale:
        "Operator-identified GLM-5.5 preview; retained below benchmarked models pending disclosure",
      source: "operator-supplied alias mapping: x-preview-f-free = GLM-5.5",
      observedAt: "2026-08-23",
    },
    {
      provider: "opencode-zen",
      model: "nemotron-3.5-lightning-free",
      routedModel: "opencode-zen/nemotron-3.5-lightning-free",
      intendedTier: "haiku",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "200 requests/day/account; 6 active accounts observed; two quota pools",
      quotaPool: "nemotron",
      probeStatus: "unprobed",
      rationale: "Fast Nemotron-pool economy target for agentic and long-context work",
      source: "https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b/modelcard",
      observedAt: "2026-08-23",
    },
    {
      provider: "opencode-zen",
      model: "hy3-free",
      routedModel: "opencode-zen/hy3-free",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "200 requests/day/account; 6 active accounts observed; two quota pools",
      quotaPool: "non-nemotron",
      probeStatus: "unprobed",
      rationale: "Agentic fallback with reported Terminal-Bench 71.7 and SWE Multilingual 75.8",
      source:
        "https://www.tencent.com/tencent-hunyuan-officially-releases-hy3-advancing-agent-capabilities-and-deeper-product-integration/",
      observedAt: "2026-08-23",
    },
    {
      provider: "opencode-zen",
      model: "laguna-s-2.1-free",
      routedModel: "opencode-zen/laguna-s-2.1-free",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "200 requests/day/account; 6 active accounts observed; two quota pools",
      quotaPool: "non-nemotron",
      probeStatus: "unprobed",
      rationale: "Coding specialist: SWE Multilingual 78.5 and SWE-Bench Pro 59.4",
      source: "https://huggingface.co/RedHatAI/Laguna-S-2.1",
      observedAt: "2026-08-23",
    },
    {
      provider: "llm7",
      model: "gemini-3.1-flash-lite",
      routedModel: "llm7/gemini-3.1-flash-lite",
      intendedTier: "haiku",
      access: "free",
      operationalStatus: "operational",
      probeStatus: "unprobed",
      rationale: "Turbo economy target with tools, vision, JSON, streaming, and 256K context",
      source: "https://docs.llm7.io/models",
      observedAt: "2026-08-23",
    },
    {
      provider: "nara",
      model: "stepfun-3.7-flash",
      routedModel: "nara/stepfun-3.7-flash",
      intendedTier: "haiku",
      access: "free",
      operationalStatus: "unknown",
      quotaPool: "nara-free",
      probeStatus: "unprobed",
      rationale: "Vision-capable economy fallback with 262K context",
      source: "https://router.bynara.id",
      observedAt: "2026-08-23",
    },
    {
      provider: "nara",
      model: "laguna-s-2.1",
      routedModel: "nara/laguna-s-2.1",
      intendedTier: "sonnet",
      access: "free",
      operationalStatus: "unknown",
      quotaPool: "nara-free",
      probeStatus: "unprobed",
      rationale: "Coding specialist sharing Nara's free pool",
      source: "https://huggingface.co/RedHatAI/Laguna-S-2.1",
      observedAt: "2026-08-23",
    },
    {
      provider: "api-airforce",
      model: "gpt-oss-20b",
      routedModel: "af/gpt-oss-20b",
      intendedTier: "haiku",
      access: "free",
      operationalStatus: "operational",
      requestLimit: "1 RPM provider-wide",
      probeStatus: "passed",
      rationale: "Economy reasoning/tools fallback; basic exact-output probe passed",
      source: "https://api.airforce/models",
      observedAt: "2026-08-23",
    },
    ...[
      ["nemotron-3-nano:30b", "haiku", "Fast economy reasoning and agentic target"],
      ["gpt-oss:20b", "haiku", "Economy open-weight reasoning and tool target"],
      ["gemma4:31b", "haiku", "Multimodal economy target"],
      ["minimax-m3", "sonnet", "Frontier coding and agentic target with 1M context"],
      ["nemotron-3-ultra", "sonnet", "Maximum-quality Nemotron target"],
      ["nemotron-3-super", "sonnet", "Efficient multi-agent fallback"],
    ].map(([model, intendedTier, rationale]) => ({
      provider: "ollama-cloud",
      model,
      routedModel: `ollama-cloud/${model}`,
      intendedTier: intendedTier as "haiku" | "sonnet",
      access: "free" as const,
      operationalStatus: "operational" as const,
      probeStatus: "passed" as const,
      rationale,
      validationNote:
        "Operator functional tests passed; automated exact-output probe returned a usable but non-exact response",
      source: "operator functional validation plus https://ollama.com/search?c=cloud",
      observedAt: "2026-08-23",
    })),
    {
      provider: "longcat",
      model: "LongCat-2.0",
      routedModel: "longcat/LongCat-2.0",
      intendedTier: "sonnet",
      access: "credits",
      operationalStatus: "degraded",
      requestLimit: "50M uncached tokens total; one-month promotion",
      quotaPool: "longcat-promotion",
      probeStatus: "passed",
      rationale: "Temporary direct-provider capacity reserved for higher-value agentic work",
      validationNote: "Remove or revalidate when the one-month promotion expires",
      source: "operator-supplied promotion terms",
      observedAt: "2026-08-23",
    },
  ]);

/** NIMStats measurements supplied for NVIDIA NIM only (720 runs, 16 models). */
export const NIM_BENCHMARK_EVIDENCE: readonly ProviderBenchmarkEvidence[] = Object.freeze([
  {
    provider: "nvidia",
    model: "nemotron-3.5-lightning-30b-a3b",
    compositeScore: 73,
    successRate: 0.967,
    runs: 15,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "gpt-oss-20b",
    compositeScore: 68,
    successRate: 1,
    runs: 15,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "thinkingmachines/inkling",
    compositeScore: 70,
    successRate: 1,
    runs: 42,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "nemotron-3-super-120b-a12b",
    compositeScore: 69,
    successRate: 0.967,
    runs: 26,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "nemotron-3-ultra-550b-a55b",
    compositeScore: 70,
    successRate: 0.933,
    runs: 38,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "nemotron-3-nano-omni-30b-a3b-reasoning",
    compositeScore: 65,
    successRate: 0.867,
    runs: 15,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "deepseek-v4-flash-0731",
    compositeScore: 53,
    successRate: 0.767,
    runs: 52,
    source: "NIMStats",
  },
  {
    provider: "nvidia",
    model: "glm-5.2",
    compositeScore: 10,
    successRate: 0,
    runs: 35,
    source: "NIMStats",
  },
]);

export function validateProviderBenchmarkEvidence(
  entries: readonly ProviderBenchmarkEvidence[] = NIM_BENCHMARK_EVIDENCE
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const entry of entries) {
    if (!entry.provider || !entry.model || entry.source !== "NIMStats") {
      errors.push(`${entry.provider}/${entry.model} has invalid scope metadata`);
    }
    if (
      entry.compositeScore < 0 ||
      entry.successRate < 0 ||
      entry.successRate > 1 ||
      entry.runs <= 0
    ) {
      errors.push(`${entry.provider}/${entry.model} has invalid benchmark values`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Anthropic's four performance bands, with pricing kept as a separate pool axis. */
export const CLAUDE_PERFORMANCE_EVIDENCE: readonly ClaudeTierEvidence[] = Object.freeze([
  {
    tier: "haiku",
    model: "claude-haiku-4-5",
    inputUsdPer1M: 1,
    outputUsdPer1M: 5,
    performanceScore: 0.78,
    pricingStructures: ["free", "subscription"],
    source: "https://www.anthropic.com/claude/haiku",
  },
  {
    tier: "sonnet",
    model: "claude-sonnet-4-6",
    inputUsdPer1M: 1.5,
    outputUsdPer1M: 7.5,
    performanceScore: 0.86,
    pricingStructures: ["free", "subscription", "credits"],
    source: "https://www.anthropic.com/claude/sonnet",
  },
  {
    tier: "opus",
    model: "claude-opus-4-8",
    inputUsdPer1M: 5,
    outputUsdPer1M: 25,
    performanceScore: 0.94,
    pricingStructures: ["subscription", "credits", "api"],
    source: "https://www.anthropic.com/claude/opus",
  },
  {
    tier: "fable",
    model: "claude-fable-5",
    inputUsdPer1M: 10,
    outputUsdPer1M: 50,
    performanceScore: 1,
    pricingStructures: ["subscription", "credits", "api"],
    source: "https://www.anthropic.com/claude/fable",
  },
]);

export function validateClaudeTierEvidence(
  entries: readonly ClaudeTierEvidence[] = CLAUDE_PERFORMANCE_EVIDENCE
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const expected: ClaudePerformanceTier[] = ["haiku", "sonnet", "opus", "fable"];
  if (entries.length !== expected.length) {
    errors.push(`expected ${expected.length} Claude tiers, received ${entries.length}`);
  }
  entries.forEach((entry, index) => {
    if (entry.tier !== expected[index]) errors.push(`Claude tier order mismatch at ${index}`);
    if (!entry.source.startsWith("https://")) errors.push(`${entry.tier} source is not HTTPS`);
    if (entry.inputUsdPer1M < 0 || entry.outputUsdPer1M < 0) {
      errors.push(`${entry.tier} has negative pricing`);
    }
    if (entry.performanceScore <= 0 || entry.pricingStructures.length === 0) {
      errors.push(`${entry.tier} has invalid performance or pricing metadata`);
    }
    for (const structure of entry.pricingStructures) {
      if (!["free", "subscription", "credits", "api", "unknown"].includes(structure)) {
        errors.push(`${entry.tier} has unknown pricing structure ${structure}`);
      }
    }
  });
  return { ok: errors.length === 0, errors };
}

const PERFORMANCE_TIER_ORDER: readonly ClaudePerformanceTier[] = [
  "haiku",
  "sonnet",
  "opus",
  "fable",
];

export function classifyArtificialAnalysis(index: number): ClaudePerformanceTier {
  if (index <= 30) return "haiku";
  if (index <= 50) return "sonnet";
  if (index <= 60) return "opus";
  return "fable";
}

export function classifyArenaCodeQuartile(rank: number, total: number): PerformanceClassification {
  if (
    !Number.isInteger(rank) ||
    !Number.isInteger(total) ||
    rank < 1 ||
    total < 1 ||
    rank > total
  ) {
    return "unranked";
  }
  const percentile = (rank - 1) / total;
  if (percentile < 0.25) return "fable";
  if (percentile < 0.5) return "opus";
  if (percentile < 0.75) return "sonnet";
  return "haiku";
}

function lowerTier(
  left: ClaudePerformanceTier,
  right: ClaudePerformanceTier
): ClaudePerformanceTier {
  return PERFORMANCE_TIER_ORDER[
    Math.min(PERFORMANCE_TIER_ORDER.indexOf(left), PERFORMANCE_TIER_ORDER.indexOf(right))
  ];
}

export function classifyComparativeEvidence(evidence: ComparativeBenchmarkEvidence): {
  tier: PerformanceClassification;
  confidence: number;
} {
  const tiers: ClaudePerformanceTier[] = [];
  if (evidence.artificialAnalysisIndex !== undefined) {
    tiers.push(classifyArtificialAnalysis(evidence.artificialAnalysisIndex));
  }
  const arenaTier =
    evidence.arenaCodeRank !== undefined && evidence.arenaCodeTotal !== undefined
      ? classifyArenaCodeQuartile(evidence.arenaCodeRank, evidence.arenaCodeTotal)
      : "unranked";
  if (arenaTier !== "unranked") tiers.push(arenaTier);
  if (evidence.officialBenchmarkTier) {
    tiers.push(lowerTier(evidence.officialBenchmarkTier, "opus"));
  }
  if (tiers.length === 0) return { tier: "unranked", confidence: 0 };
  return {
    tier: tiers.reduce(lowerTier),
    confidence: evidence.artificialAnalysisMarked ? 0.6 : 1,
  };
}

/** Model-and-effort evidence. Family labels are identity/pricing labels, never tiers. */
export const ARTIFICIAL_ANALYSIS_SNAPSHOT: readonly ComparativeBenchmarkEvidence[] = Object.freeze([
  ...[
    ["gpt-5.6-luna", "low", 34],
    ["gpt-5.6-luna", "medium", 39],
    ["gpt-5.6-luna", "high", 47],
    ["gpt-5.6-luna", "xhigh", 50],
    ["gpt-5.6-luna", "max", 52],
    ["gpt-5.6-terra", "low", 41],
    ["gpt-5.6-terra", "medium", 47],
    ["gpt-5.6-terra", "high", 50],
    ["gpt-5.6-terra", "xhigh", 53],
    ["gpt-5.6-terra", "max", 57],
    ["gpt-5.6-sol", "low", 51],
    ["gpt-5.6-sol", "medium", 56],
    ["gpt-5.6-sol", "high", 57],
    ["gpt-5.6-sol", "xhigh", 59],
    ["gpt-5.6-sol", "max", 61],
    ["claude-opus-5", "low", 52],
    ["claude-opus-5", "medium", 59],
    ["claude-opus-5", "high", 61],
    ["claude-opus-5", "xhigh", 63],
    ["claude-opus-5", "max", 63],
    ["gemini-3.7-flash", "low", 51],
    ["gemini-3.7-flash", "medium", 53],
    ["gemini-3.7-flash", "high", 56],
  ].map(([model, effort, artificialAnalysisIndex]) => ({
    model: model as string,
    effort: effort as ReasoningEffort,
    artificialAnalysisIndex: artificialAnalysisIndex as number,
    source: ["Artificial Analysis snapshot supplied 2026-08-23"],
  })),
  {
    model: "claude-sonnet-4-6",
    effort: "low",
    artificialAnalysisIndex: 35,
    artificialAnalysisMarked: true,
    source: ["Artificial Analysis snapshot supplied 2026-08-23"],
  },
]);

export const GPT56_MODEL_EVIDENCE: readonly ComparativeBenchmarkEvidence[] = Object.freeze([
  {
    model: "gpt-5.6-luna",
    effort: "medium",
    artificialAnalysisIndex: 39,
    inputUsdPer1M: 0.2,
    outputUsdPer1M: 1.2,
    source: ["Artificial Analysis", "OpenAI pricing"],
  },
  {
    model: "gpt-5.6-terra",
    effort: "medium",
    artificialAnalysisIndex: 47,
    inputUsdPer1M: 2,
    outputUsdPer1M: 12,
    source: ["Artificial Analysis", "OpenAI model documentation"],
  },
  {
    model: "gpt-5.6-sol",
    effort: "medium",
    artificialAnalysisIndex: 56,
    inputUsdPer1M: 5,
    outputUsdPer1M: 30,
    source: ["Artificial Analysis", "OpenAI model documentation"],
  },
]);

export function classifyGpt56Model(
  model: string,
  effort?: ReasoningEffort
): PerformanceClassification {
  const normalizedModel = model.replace(/^(?:codex|agentrouter)\//, "");
  const effectiveEffort = effort ?? "medium";
  const evidence = ARTIFICIAL_ANALYSIS_SNAPSHOT.find(
    (entry) => entry.model === normalizedModel && entry.effort === effectiveEffort
  );
  return evidence ? classifyComparativeEvidence(evidence).tier : "unranked";
}

/**
 * The small, checked-in seed used before an external benchmark catalog is
 * available.  It is intentionally model-scoped; tier-level pricing metadata
 * must never be treated as evidence for every provider/model variant.
 */
const SEEDED_MODEL_BENCHMARKS: readonly ModelPerformanceEvidence[] = Object.freeze([
  ...GPT56_MODEL_EVIDENCE.map((entry) => ({
    model: entry.model,
    benchmarkScore: ({ haiku: 0.3, sonnet: 0.55, opus: 0.78, fable: 1 } as const)[
      classifyComparativeEvidence(entry).tier as ClaudePerformanceTier
    ],
    benchmarkConfidence: classifyComparativeEvidence(entry).confidence,
  })),
  ...CLAUDE_PERFORMANCE_EVIDENCE.map((entry) => ({
    model: entry.model,
    benchmarkScore: entry.performanceScore,
    benchmarkConfidence: 0.5,
  })),
  ...NIM_BENCHMARK_EVIDENCE.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    benchmarkScore: Math.min(1, entry.compositeScore / 100),
    benchmarkConfidence: Math.min(1, entry.runs / 50),
  })),
]);

const SEEDED_MODEL_BANDS = assignPerformanceBands(
  SEEDED_MODEL_BENCHMARKS.map((entry) => ({
    model: entry.model,
    score: entry.benchmarkScore ?? 0.5,
    confidence: entry.benchmarkConfidence,
    source: "seeded-evidence",
  }))
);

function modelMatches(candidate: string, requested: string): boolean {
  const left = candidate.toLowerCase();
  const right = requested.toLowerCase();
  return left === right || right.endsWith(`/${left}`) || right.includes(left);
}

/** Return model-scoped benchmark evidence for runtime performance-first routing. */
export function getSeededModelPerformanceEvidence(
  provider: string,
  model: string
): ModelPerformanceEvidence | null {
  const entry = SEEDED_MODEL_BENCHMARKS.find(
    (candidate) =>
      modelMatches(candidate.model, model) &&
      (!candidate.provider || candidate.provider.toLowerCase() === provider.toLowerCase())
  );
  if (!entry) return null;
  const band: PerformanceBand = SEEDED_MODEL_BANDS.get(entry.model) ?? "economy";
  return { ...entry, band };
}
