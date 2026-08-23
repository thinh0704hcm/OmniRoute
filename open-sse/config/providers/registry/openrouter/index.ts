import type { RegistryEntry } from "../../shared.ts";

export const openrouterProvider: RegistryEntry = {
  id: "openrouter",
  alias: "openrouter",
  format: "openai",
  executor: "default",
  baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  defaultContextLength: 128000,
  headers: {
    "HTTP-Referer": "https://endpoint-proxy.local",
    "X-Title": "Endpoint Proxy",
  },
  // OpenRouter multiplexes hundreds of independent upstream models behind one
  // connection/API key — without this flag, hasPerModelQuota() (accountFallback.ts)
  // falls through to connection-wide cooldown on any model-specific failure (e.g. a
  // 404 "No endpoints found" for one dead/renamed model), poisoning every OTHER
  // OpenRouter model on the same connection for the cooldown window and surfacing
  // that first model's stale error message on their unrelated requests.
  passthroughModels: true,
  models: [
    { id: "auto", name: "Auto (Best Available)" },
    { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning (Free)" },
    { id: "poolside/laguna-xs-2.1:free", name: "Laguna XS 2.1 (Free)" },
    { id: "thinkingmachines/inkling-small:free", name: "Inkling Small (Free)" },
    { id: "nvidia/nemotron-3-nano-30b-a3b:free", name: "Nemotron 3 Nano 30B (Free)" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra (Free)" },
    { id: "thinkingmachines/inkling:free", name: "Inkling (Free)" },
    { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1 (Free)" },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super (Free)" },
    { id: "z-ai/glm-5.2:free", name: "GLM 5.2 (Free)" },
    { id: "cohere/north-mini-code:free", name: "North Mini Code (Free)" },
  ],
};
