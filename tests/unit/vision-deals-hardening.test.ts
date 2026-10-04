import assert from "node:assert/strict";
import test from "node:test";

import { VisionBridgeGuardrail } from "../../src/lib/guardrails/visionBridge.ts";
import { callVisionModel } from "../../src/lib/guardrails/visionBridgeHelpers.ts";

function imagePayload(model: string, count: number): Record<string, unknown> {
  return {
    model,
    messages: [
      {
        role: "user",
        content: Array.from({ length: count }, (_, index) => ({
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${Buffer.from(`image-${index}`).toString("base64")}`,
          },
        })),
      },
    ],
  };
}

test("auto/best-vision bypasses the bridge and keeps native image routing", async () => {
  let visionCalls = 0;
  const guardrail = new VisionBridgeGuardrail({
    deps: {
      getSettings: async () => ({ modalityBridgeVisionMode: "describe" }),
      callVisionModel: async () => {
        visionCalls++;
        return "unexpected description";
      },
    },
  });
  const payload = imagePayload("auto/best-vision", 1);
  const result = await guardrail.preCall(payload, { model: "auto/best-vision" });

  assert.equal(result.modifiedPayload, undefined);
  assert.equal(visionCalls, 0);
});

test("vision bridge starts no more than two image descriptions concurrently", async () => {
  let active = 0;
  let peak = 0;
  const guardrail = new VisionBridgeGuardrail({
    deps: {
      getSettings: async () => ({
        modalityBridgeVisionMode: "describe",
        modalityBridgeCacheEnabled: false,
        modalityBridgeVisionMaxImages: 4,
      }),
      callVisionModel: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return "description";
      },
      hasUsableCredentials: async () => true,
    },
  });

  const result = await guardrail.preCall(imagePayload("some/text-only-model", 4), {
    model: "some/text-only-model",
  });
  assert.equal(result.meta?.imagesProcessed, 4);
  assert.equal(peak, 2);
});

test("vision self-calls reject nested auto routes before network dispatch", async () => {
  await assert.rejects(
    callVisionModel(
      "data:image/png;base64,aW1hZ2U=",
      {
        model: "auto/best-vision",
        prompt: "Describe",
        timeoutMs: 1_000,
        maxImages: 1,
      },
      undefined,
      undefined,
      { hasUsableCredentials: async () => true }
    ),
    /concrete vision model/
  );
});
