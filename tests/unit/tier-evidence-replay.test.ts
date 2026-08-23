import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAUDE_PERFORMANCE_EVIDENCE,
  GPT56_MODEL_EVIDENCE,
  classifyArenaCodeQuartile,
  classifyArtificialAnalysis,
  classifyComparativeEvidence,
  classifyGpt56Model,
  validateClaudeTierEvidence,
  NIM_BENCHMARK_EVIDENCE,
  PROVIDER_CATALOG_SELECTION_EVIDENCE,
  validateProviderBenchmarkEvidence,
} from "../../src/lib/combos/tierEvidence";
import {
  DOCUMENTED_MODEL_EXCLUSIONS,
  getCanonicalComboManifest,
  validateCanonicalComboManifest,
} from "../../src/lib/combos/canonicalEconomicPools";

test("GPT-5.6 evidence is model-and-effort scoped", () => {
  assert.deepEqual(
    GPT56_MODEL_EVIDENCE.map((entry) => [entry.model, entry.effort]),
    [
      ["gpt-5.6-luna", "medium"],
      ["gpt-5.6-terra", "medium"],
      ["gpt-5.6-sol", "medium"],
    ]
  );
  assert.deepEqual(
    GPT56_MODEL_EVIDENCE.map((entry) => classifyComparativeEvidence(entry).tier),
    ["sonnet", "sonnet", "opus"]
  );
});

test("Artificial Analysis boundaries map to the four canonical tiers", () => {
  assert.deepEqual([30, 31, 50, 51, 60, 61].map(classifyArtificialAnalysis), [
    "haiku",
    "sonnet",
    "sonnet",
    "opus",
    "opus",
    "fable",
  ]);
});

test("Arena Code quartile boundaries map conservatively", () => {
  assert.deepEqual(
    [1, 25, 26, 50, 51, 75, 76, 100].map((rank) => classifyArenaCodeQuartile(rank, 100)),
    ["fable", "fable", "opus", "opus", "sonnet", "sonnet", "haiku", "haiku"]
  );
});

test("comparative conflicts use the lower tier and marked values reduce confidence", () => {
  const result = classifyComparativeEvidence({
    model: "conflict",
    effort: "high",
    artificialAnalysisIndex: 61,
    artificialAnalysisMarked: true,
    arenaCodeRank: 51,
    arenaCodeTotal: 100,
    source: ["fixture"],
  });
  assert.deepEqual(result, { tier: "sonnet", confidence: 0.6 });
  assert.equal(
    classifyComparativeEvidence({
      model: "official-only",
      effort: "medium",
      officialBenchmarkTier: "fable",
      source: ["fixture"],
    }).tier,
    "opus"
  );
});

test("GPT defaults use medium and explicit efforts classify independently", () => {
  assert.deepEqual(
    ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"].map((model) => classifyGpt56Model(model)),
    ["sonnet", "sonnet", "opus"]
  );
  assert.equal(classifyGpt56Model("gpt-5.6-sol", "high"), "opus");
  assert.equal(classifyGpt56Model("gpt-5.6-sol", "max"), "fable");
  assert.equal(classifyGpt56Model("ambiguous-gpt-5.6-sol"), "unranked");
});

test("reasoning variants classify independently without changing the base route", () => {
  const base = classifyComparativeEvidence({
    model: "same-route",
    effort: "medium",
    artificialAnalysisIndex: 50,
    source: ["fixture"],
  });
  const high = classifyComparativeEvidence({
    model: "same-route",
    effort: "high",
    artificialAnalysisIndex: 51,
    source: ["fixture"],
  });
  assert.equal(base.tier, "sonnet");
  assert.equal(high.tier, "opus");
});

test("route evidence uses only the canonical four-tier taxonomy", () => {
  const canonical = new Set(["haiku", "sonnet", "opus", "fable"]);
  assert.ok(
    PROVIDER_CATALOG_SELECTION_EVIDENCE.every((entry) => canonical.has(entry.intendedTier))
  );
  assert.equal(
    PROVIDER_CATALOG_SELECTION_EVIDENCE.some((entry) =>
      ["luna", "terra", "sol"].includes(entry.intendedTier)
    ),
    false
  );
});

test("managed route reconciliation covers 91 routes and two documented exclusions", () => {
  const manifest = getCanonicalComboManifest();
  const reviewed = new Set(PROVIDER_CATALOG_SELECTION_EVIDENCE.map((entry) => entry.routedModel));
  for (const combo of manifest.combos) {
    for (const step of combo.models) if (step.kind === "model") reviewed.add(step.model);
  }
  const managed = [...reviewed].filter((route) => !DOCUMENTED_MODEL_EXCLUSIONS.includes(route));
  assert.equal(managed.length, 91);
  assert.equal(DOCUMENTED_MODEL_EXCLUSIONS.length, 2);
  assert.ok(DOCUMENTED_MODEL_EXCLUSIONS.every((route) => reviewed.has(route)));
  assert.equal(
    [...reviewed].filter(
      (route) => !managed.includes(route) && !DOCUMENTED_MODEL_EXCLUSIONS.includes(route)
    ).length,
    0
  );
});

test("Claude uses four performance tiers with pricing pools as a separate axis", () => {
  assert.deepEqual(validateClaudeTierEvidence(), { ok: true, errors: [] });
  assert.deepEqual(
    CLAUDE_PERFORMANCE_EVIDENCE.map((entry) => entry.tier),
    ["haiku", "sonnet", "opus", "fable"]
  );
  assert.deepEqual(
    CLAUDE_PERFORMANCE_EVIDENCE.map((entry) => [entry.inputUsdPer1M, entry.outputUsdPer1M]),
    [
      [1, 5],
      [1.5, 7.5],
      [5, 25],
      [10, 50],
    ]
  );
  assert.equal(CLAUDE_PERFORMANCE_EVIDENCE[3].performanceScore, 1);
});

test("NIM benchmark evidence remains provider-scoped", () => {
  assert.deepEqual(validateProviderBenchmarkEvidence(), { ok: true, errors: [] });
  assert.equal(NIM_BENCHMARK_EVIDENCE[0].provider, "nvidia");
  assert.equal(NIM_BENCHMARK_EVIDENCE[0].model, "nemotron-3.5-lightning-30b-a3b");
  assert.equal(NIM_BENCHMARK_EVIDENCE[0].compositeScore, 73);
  assert.equal(NIM_BENCHMARK_EVIDENCE[2].model, "thinkingmachines/inkling");
  assert.equal(NIM_BENCHMARK_EVIDENCE[2].successRate, 1);
  assert.ok(NIM_BENCHMARK_EVIDENCE.every((entry) => entry.provider === "nvidia"));
});

test("NVIDIA NIM selections share one provider-wide 40 RPM quota pool", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "nvidia"
  );
  assert.deepEqual(
    entries.map((entry) => entry.model),
    [
      "nemotron-3.5-lightning-30b-a3b",
      "gpt-oss-20b",
      "thinkingmachines/inkling",
      "nemotron-3-ultra-550b-a55b",
      "nemotron-3-super-120b-a12b",
      "nemotron-3-nano-omni-30b-a3b-reasoning",
    ]
  );
  assert.ok(entries.every((entry) => entry.quotaPool === "nvidia-nim"));
  assert.ok(entries.every((entry) => entry.requestLimit?.startsWith("40 RPM provider-wide")));
});

test("Api.Airforce catalog selection remains distinct from benchmark evidence", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "api-airforce"
  );
  const entry = entries[0];
  assert.equal(entry?.model, "mistral-large-latest");
  assert.equal(entry?.routedModel, "af/mistral-large-latest");
  assert.equal(entry?.intendedTier, "sonnet");
  assert.equal(entry?.requestLimit, "1 RPM");
  assert.equal(entry?.probeStatus, "inconclusive");
});

test("AgentRouter is isolated as guaranteed one-time credit capacity", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "agentrouter"
  );
  assert.deepEqual(
    entries.map((entry) => entry.model),
    ["gpt-5.6-sol", "claude-opus-5", "claude-opus-4-8"]
  );
  assert.ok(entries.every((entry) => entry.access === "credits"));
  assert.ok(entries.every((entry) => entry.quotaPool === "agentrouter-one-time-credits"));
  assert.ok(entries.every((entry) => entry.requestLimit?.includes("one-time credit grant")));
  assert.deepEqual(
    entries.map((entry) => [entry.model, entry.inputUsdPer1M, entry.outputUsdPer1M]),
    [
      ["gpt-5.6-sol", 4, 20],
      ["claude-opus-5", 2, 10],
      ["claude-opus-4-8", 3, 15],
    ]
  );
});

test("Cloudflare selections share the recurring daily neuron allocation", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "cloudflare-ai"
  );
  assert.deepEqual(
    entries.map((entry) => entry.model),
    [
      "@cf/qwen/qwen3-30b-a3b-fp8",
      "@cf/zai-org/glm-4.7-flash",
      "@cf/google/gemma-4-26b-a4b-it",
      "@cf/openai/gpt-oss-20b",
      "@cf/openai/gpt-oss-120b",
      "@cf/nvidia/nemotron-3-120b-a12b",
    ]
  );
  assert.ok(entries.every((entry) => entry.probeStatus === "passed"));
  assert.ok(entries.every((entry) => entry.quotaPool === "cloudflare-workers-ai-neurons"));
  assert.ok(entries.every((entry) => entry.requestLimit?.includes("10,000 neurons/day")));
});

test("Groq selections preserve per-model recurring limits and Compound constraints", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "groq"
  );
  assert.deepEqual(
    entries.map((entry) => entry.model),
    [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3.6-27b",
      "groq/compound",
      "groq/compound-mini",
    ]
  );
  assert.ok(entries.every((entry) => entry.quotaPool === `groq:${entry.model}`));
  assert.equal(entries[0]?.intendedTier, "sonnet");
  assert.ok(
    entries
      .filter((entry) => entry.model.startsWith("groq/compound"))
      .every((entry) => entry.validationNote?.includes("not caller-supplied"))
  );
});

test("Mistral monthly API credits stay separate from Vibe Code allowance", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "mistral"
  );
  const apiEntries = entries.filter((entry) => entry.access === "credits");
  assert.equal(apiEntries.length, 5);
  assert.ok(apiEntries.every((entry) => entry.quotaPool === "mistral-api-monthly-allowance"));
  assert.ok(apiEntries.every((entry) => entry.requestLimit?.includes("$10 shared monthly")));
  assert.ok(apiEntries.every((entry) => entry.validationNote?.includes("Vibe Code")));
  assert.equal(entries.find((entry) => entry.model === "labs-leanstral-2603")?.access, "free");
});

test("Gemini free quotas aggregate seven independent projects without counting API keys", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "gemini"
  );
  assert.equal(entries.length, 8);
  assert.ok(entries.every((entry) => entry.quotaPool === `gemini:${entry.model}:7-projects`));
  assert.ok(entries.every((entry) => entry.requestLimit?.includes("7 independent projects")));
  assert.ok(entries.every((entry) => entry.validationNote?.includes("not per API key")));
  assert.equal(
    entries
      .find((entry) => entry.model === "gemini-3.5-flash-lite")
      ?.validationNote?.includes("3500 RPD"),
    true
  );
  assert.equal(
    entries
      .find((entry) => entry.model === "gemini-3.7-flash")
      ?.validationNote?.includes("140 RPD"),
    true
  );
});

test("Nous imported models remain curated while quota topology is unverified", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "nous-research"
  );
  assert.deepEqual(
    entries.map((entry) => entry.model),
    [
      "poolside/laguna-xs-2.1:free",
      "stepfun/step-3.7-flash:free",
      "poolside/laguna-s-2.1:free",
      "tencent/hy3:free",
      "upstage/solar-pro4:free",
      "meituan/longcat-2.0:free",
    ]
  );
  assert.ok(
    entries.every((entry) => entry.quotaPool === "nous-research-quota-topology-unverified")
  );
  assert.ok(entries.every((entry) => entry.validationNote?.includes("do not aggregate")));
});

test("OpenRouter uses a compact live free catalog and one provisional shared quota", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "openrouter"
  );
  assert.equal(entries.length, 10);
  assert.ok(entries.every((entry) => entry.quotaPool === "openrouter-free-shared"));
  assert.ok(entries.every((entry) => entry.validationNote?.includes("endpoints rotate")));
  assert.equal(
    entries.some((entry) => entry.model === "openai/gpt-oss-20b:free"),
    false
  );
});

test("Command Code includes only its two genuinely free models", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "command-code"
  );
  assert.deepEqual(
    entries.map((entry) => entry.model),
    ["stealth/ox-alpha", "poolside/laguna-s-2.1-free"]
  );
  assert.ok(entries.every((entry) => entry.access === "free"));
  assert.ok(entries.every((entry) => entry.inputUsdPer1M === 0));
  assert.ok(entries.every((entry) => entry.quotaPool === "command-code-free-topology-unverified"));
});

test("Antigravity separates generous Gemini quota from scarce non-Gemini quota", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "antigravity"
  );
  assert.equal(entries.length, 5);
  assert.ok(entries.every((entry) => entry.access === "subscription"));
  const gemini = entries.filter((entry) => entry.quotaPool === "antigravity-gemini");
  const nonGemini = entries.filter((entry) => entry.quotaPool === "antigravity-non-gemini");
  assert.equal(gemini.length, 3);
  assert.equal(nonGemini.length, 2);
  assert.ok(gemini.every((entry) => entry.requestLimit?.includes(">4,000 aggregate RPD floor")));
  assert.ok(nonGemini.every((entry) => entry.requestLimit?.includes("Scarce non-Gemini")));
});

test("OpenCode direct mirrors Zen models with one 200-RPD connection", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "opencode"
  );
  assert.equal(entries.length, 7);
  assert.ok(
    entries.every(
      (entry) => entry.requestLimit === "200 requests/day/connection; 1 active connection"
    )
  );
  assert.deepEqual([...new Set(entries.map((entry) => entry.quotaPool))].sort(), [
    "opencode:nemotron",
    "opencode:non-nemotron",
  ]);
  assert.ok(entries.every((entry) => entry.validationNote?.includes("Same backend")));
});

test("LLM7 turbo selection records its successfully probed route", () => {
  const entry = PROVIDER_CATALOG_SELECTION_EVIDENCE.find(
    (candidate) => candidate.provider === "llm7"
  );
  assert.equal(entry?.model, "DeepSeek-V4-Flash-0731");
  assert.equal(entry?.routedModel, "llm7/DeepSeek-V4-Flash-0731");
  assert.equal(entry?.intendedTier, "sonnet");
  assert.equal(entry?.access, "free");
  assert.equal(entry?.probeStatus, "passed");
});

test("Nara selection stays unprobed until the refreshed registry is loaded", () => {
  const entry = PROVIDER_CATALOG_SELECTION_EVIDENCE.find(
    (candidate) => candidate.provider === "nara"
  );
  assert.equal(entry?.model, "qwen-3.8-max-free");
  assert.equal(entry?.routedModel, "nara/qwen-3.8-max-free");
  assert.equal(entry?.intendedTier, "sonnet");
  assert.equal(entry?.probeStatus, "unprobed");
});

test("OpenCode Zen selection records its daily per-account quota", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "opencode-zen"
  );
  assert.deepEqual(
    entries.map((entry) => [entry.model, entry.quotaPool]),
    [
      ["nemotron-3-ultra-free", "nemotron"],
      ["mimo-v2.5-free", "non-nemotron"],
      ["muse-spark-1.2-contributor-free", "non-nemotron"],
      ["x-preview-f-free", "non-nemotron"],
      ["nemotron-3.5-lightning-free", "nemotron"],
      ["hy3-free", "non-nemotron"],
      ["laguna-s-2.1-free", "non-nemotron"],
    ]
  );
  assert.equal(
    entries.find((entry) => entry.model === "nemotron-3.5-lightning-free")?.intendedTier,
    "haiku"
  );
  assert.equal(entries.filter((entry) => entry.probeStatus === "passed").length, 4);
});

test("Ollama Cloud operator-validated candidates retain automated probe caveat", () => {
  const entries = PROVIDER_CATALOG_SELECTION_EVIDENCE.filter(
    (candidate) => candidate.provider === "ollama-cloud"
  );
  assert.equal(entries.length, 6);
  assert.ok(entries.every((entry) => entry.probeStatus === "passed"));
  assert.ok(entries.every((entry) => entry.validationNote?.includes("non-exact response")));
});

test("LongCat promotion is first-class expendable credit capacity", () => {
  const entry = PROVIDER_CATALOG_SELECTION_EVIDENCE.find(
    (candidate) => candidate.provider === "longcat"
  );
  assert.equal(entry?.requestLimit, "50M uncached tokens total; one-month promotion");
  assert.equal(entry?.probeStatus, "passed");
  const combos = new Map(getCanonicalComboManifest().combos.map((combo) => [combo.name, combo]));
  assert.equal(combos.get("pool-sonnet-credits")?.models[0]?.model, "longcat/LongCat-2.0");
  assert.equal(
    combos.get("pool-sonnet-free")?.models.some((step) => step.model === "longcat/LongCat-2.0"),
    false
  );
});

test("canonical performance pools carry an explicit economic classification", () => {
  const combos = new Map(getCanonicalComboManifest().combos.map((combo) => [combo.name, combo]));
  assert.equal(combos.get("pool-haiku-free")?.config.economicPool, "free");
  assert.equal(combos.get("pool-luna-antigravity")?.config.economicPool, "cheap_subscription");
  assert.equal(combos.get("pool-sol-codex")?.config.economicPool, "raw_credits");
  assert.deepEqual(
    combos
      .get("pool-luna-credits")
      ?.models.slice(0, 2)
      .map((step) => step.model),
    ["longcat/LongCat-2.0", "mistral/mistral-medium-latest"]
  );
  assert.deepEqual(
    combos.get("pool-opus-credits")?.models.map((step) => step.model),
    ["agentrouter/claude-opus-4-8"]
  );
  assert.equal(
    combos.get("pool-fable-credits")?.models[0]?.model,
    "command-code/meta/muse-spark-1.2-contributor"
  );
});

test("canonical pools map GPT-5.6 aliases to performance-specific pools", () => {
  const validation = validateCanonicalComboManifest();
  assert.equal(validation.ok, true, validation.errors.join("; "));
  const combos = new Map(getCanonicalComboManifest().combos.map((combo) => [combo.name, combo]));
  for (const [alias, target] of [
    ["gpt-5.6-luna", "pool-luna"],
    ["gpt-5.6-terra", "pool-terra"],
    ["gpt-5.6-sol", "pool-sol-codex"],
  ] as const) {
    assert.equal(combos.get(alias)?.models[0]?.kind, "combo-ref");
    assert.equal((combos.get(alias)?.models[0] as { comboName: string }).comboName, target);
  }
  for (const [alias, tier] of [
    ["claude-haiku-4-5-20251001", "haiku"],
    ["claude-sonnet-5", "sonnet"],
    ["claude-opus-5", "opus"],
    ["claude-fable-5", "fable"],
  ] as const) {
    const target = (combos.get(alias)?.models[0] as { comboName: string }).comboName;
    assert.equal(combos.get(target)?.config.performanceTier, tier);
  }
  assert.equal(combos.get("gpt-5.6-sol")?.config.accessPolicy, "explicit");
  assert.equal(combos.get("pool-sol-codex")?.config.accessPolicy, "explicit");
  assert.equal(combos.get("pool-terra")?.config.relativePerformanceBand, "sonnet");
  assert.equal(combos.get("pool-luna")?.config.relativePerformanceBand, "sonnet");
  for (const leaf of ["pool-fable-antigravity", "pool-fable-credits"]) {
    assert.equal(combos.get(leaf)?.config.relativePerformanceBand, "opus");
    assert.equal(combos.get(leaf)?.config.fallbackForTier, "fable");
  }
  assert.equal(combos.get("pool-fable-codex")?.config.performanceTier, "fable");
  assert.equal(combos.get("pool-fable-codex")?.config.relativePerformanceBand, undefined);
  assert.equal(combos.get("pool-fable-codex")?.config.fallbackForTier, undefined);
  const terra = combos.get("pool-terra");
  assert.deepEqual(
    terra?.models.map((step) => (step as { label?: string }).label),
    ["antigravity", "credits", "free", "codex"]
  );
  const sonnetFree = combos.get("pool-sonnet-free");
  assert.equal(sonnetFree?.models[0]?.model, "opencode-zen/nemotron-3-ultra-free");
  assert.equal(sonnetFree?.models[1]?.model, "opencode-zen/x-preview-f-free");
  assert.equal(sonnetFree?.models[2]?.model, "opencode-zen/mimo-v2.5-free");
  assert.equal(sonnetFree?.models[3]?.model, "opencode-zen/hy3-free");
  assert.equal(
    sonnetFree?.models.some(
      (step) => step.kind === "model" && step.model === "nvidia/thinkingmachines/inkling"
    ),
    true
  );
  assert.equal(
    sonnetFree?.models.some(
      (step) => step.kind === "model" && step.model === "cloudflare-ai/@cf/openai/gpt-oss-120b"
    ),
    true
  );
  assert.equal(
    sonnetFree?.models.some(
      (step) => step.kind === "model" && step.model === "groq/openai/gpt-oss-120b"
    ),
    true
  );
  assert.equal(
    sonnetFree?.models.some(
      (step) =>
        step.kind === "model" && step.model === "cloudflare-ai/@cf/qwen/qwen2.5-coder-32b-instruct"
    ),
    false
  );
  assert.equal(
    sonnetFree?.models.some(
      (step) => step.kind === "model" && step.model === "llm7/DeepSeek-V4-Flash-0731"
    ),
    true
  );
  assert.equal(
    sonnetFree?.models.some(
      (step) => step.kind === "model" && step.model === "nara/qwen-3.8-max-free"
    ),
    false
  );
  const opusFree = combos.get("pool-opus-free");
  assert.deepEqual(
    opusFree?.models.map((step) => step.model),
    [
      "opencode-zen/muse-spark-1.2-contributor-free",
      "opencode/muse-spark-1.2-contributor-free",
      "nara/qwen-3.8-max-free",
    ]
  );
  assert.equal(
    sonnetFree?.models.some(
      (step) => step.kind === "model" && step.model === "nous-research/meituan/longcat-2.0:free"
    ),
    true
  );
  assert.equal(
    sonnetFree?.models.some(
      (step) => step.kind === "model" && step.model === "nvidia/nvidia/nemotron-3-super-120b-a12b"
    ),
    true
  );
  assert.equal(
    sonnetFree?.models.some(
      (step) => step.kind === "model" && step.model === "nvidia/nvidia/nemotron-3-ultra-550b-a55b"
    ),
    true
  );
  assert.equal(
    sonnetFree?.models.some(
      (step) => step.kind === "model" && step.model === "nvidia/z-ai/glm-5.2"
    ),
    false
  );
  const haikuFree = combos.get("pool-haiku-free");
  assert.equal(haikuFree?.models[0]?.model, "opencode-zen/nemotron-3.5-lightning-free");
  assert.deepEqual(
    haikuFree?.models.slice(1, 4).map((step) => step.model),
    [
      "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b",
      "nvidia/openai/gpt-oss-20b",
      "nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    ]
  );
  assert.deepEqual(
    haikuFree?.models.slice(4, 7).map((step) => step.model),
    [
      "cloudflare-ai/@cf/qwen/qwen3-30b-a3b-fp8",
      "cloudflare-ai/@cf/zai-org/glm-4.7-flash",
      "cloudflare-ai/@cf/openai/gpt-oss-20b",
    ]
  );
  assert.equal(haikuFree?.models[7]?.model, "llm7/gemini-3.1-flash-lite");
  assert.deepEqual(
    haikuFree?.models.slice(8, 11).map((step) => step.model),
    ["ollama-cloud/nemotron-3-nano:30b", "ollama-cloud/gpt-oss:20b", "ollama-cloud/gemma4:31b"]
  );
  assert.ok(
    sonnetFree?.models.some(
      (step) => step.kind === "model" && step.model === "ollama-cloud/minimax-m3"
    )
  );
  assert.equal(
    haikuFree?.models.some(
      (step) => step.kind === "model" && step.model === "nous-research/meituan/longcat-2.0:free"
    ),
    false
  );
});
