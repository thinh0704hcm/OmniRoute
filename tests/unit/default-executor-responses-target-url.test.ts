import assert from "node:assert/strict";
import test from "node:test";

import { DefaultExecutor } from "../../open-sse/executors/default.ts";

// muse-code (Meta Muse) keeps its OAuth connection base at https://api.meta.ai/v1
// while every model in its registry declares targetFormat "openai-responses".
// PROVIDER_MODELS is keyed by the public alias ("mc"), so the default branch of
// buildUrl must alias the provider before the catalog lookup — otherwise the
// Responses-shaped body is POSTed to /chat/completions and Meta answers
// 400 "unknown parameter `input`" (live-verified against api.meta.ai).
test("DefaultExecutor routes responses-target models on custom-base connections to /responses", () => {
  const executor = new DefaultExecutor("muse-code");
  const credentials = {
    providerSpecificData: { baseUrl: "https://api.meta.ai/v1" },
  } as Parameters<DefaultExecutor["buildUrl"]>[3];

  const url = executor.buildUrl("muse-spark-1.3-contributor", false, 0, credentials);
  assert.equal(url, "https://api.meta.ai/v1/responses");
});

test("DefaultExecutor keeps the chat URL for models without a responses target", () => {
  const executor = new DefaultExecutor("muse-code");
  const credentials = {
    providerSpecificData: { baseUrl: "https://api.meta.ai/v1" },
  } as Parameters<DefaultExecutor["buildUrl"]>[3];

  const url = executor.buildUrl("totally-unknown-model", false, 0, credentials);
  assert.equal(url, "https://api.meta.ai/v1/chat/completions");
});
