import type { RegistryEntry } from "../../shared.ts";

export const nous_researchProvider: RegistryEntry = {
  id: "nous-research",
  alias: "nous",
  format: "openai",
  executor: "default",
  baseUrl: "https://inference-api.nousresearch.com/v1/chat/completions",
  authType: "apikey",
  authHeader: "bearer",
  models: [
    { id: "Hermes-4-405B", name: "Hermes 4 7B (Nous Research)" },
    { id: "Hermes-4-70B", name: "Hermes 4 70B (Nous Research)" },
    { id: "poolside/laguna-s-2.1:free", name: "Poolside Laguna S 2.1" },
    { id: "poolside/laguna-xs-2.1:free", name: "Poolside Laguna XS 2.1" },
    { id: "tencent/hy3:free", name: "Tencent HY3" },
    { id: "stepfun/step-3.7-flash:free", name: "StepFun Step 3.7 Flash" },
    { id: "upstage/solar-pro4:free", name: "Upstage Solar Pro 4" },
    { id: "meituan/longcat-2.0:free", name: "Meituan LongCat 2.0" },
  ],
};
