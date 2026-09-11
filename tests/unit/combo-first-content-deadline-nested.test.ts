/**
 * tests/unit/combo-first-content-deadline-nested.test.ts
 *
 * Reproduces the production pool shape end to end: an OUTER priority combo whose
 * targets are combo-refs (pool-sonnet -> pool-sonnet-free), with the
 * first-content budget declared on the CHILD, which is where the individual
 * models are dispatched.
 *
 * This is the shape the live pools use, and the reason a budget set on the wrong
 * combo does nothing: the outer never peeks a combo-ref unit (executeComboRefUnit
 * returns the child's response as-is), so only the child's own dispatch is
 * bounded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-first-content-nested-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "first-content-nested-secret";

const { handleComboChat } = await import("../../open-sse/services/combo.ts");

function recordingLog() {
  const warns: string[] = [];
  return {
    warns,
    log: {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (...args: unknown[]) => {
        warns.push(args.map((a) => String(a)).join(" "));
      },
    },
  };
}

/** 200 + SSE open forever: a role-only delta, then silence. */
function stalledSse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"id":"x","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
        )
      );
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("nested: the child's first-content budget bounds a stalled target", async () => {
  const { warns, log } = recordingLog();
  const child = {
    name: "child-free-pool",
    strategy: "reset-aware",
    models: ["openai/stalled-model"],
    config: { maxRetries: 0, retryDelayMs: 0, firstContentTimeoutMs: 300 },
  };
  const outer = {
    name: "outer-priority-pool",
    strategy: "priority",
    models: [{ kind: "combo-ref", comboName: "child-free-pool" }],
    config: { maxRetries: 0, retryDelayMs: 0, nestedComboMode: "execute" },
  };

  const started = Date.now();
  const res = await handleComboChat({
    body: { stream: true, messages: [{ role: "user", content: "Q" }] },
    combo: outer,
    handleSingleModel: async () => stalledSse(),
    log,
    settings: {},
    allCombos: [outer, child],
  });
  const elapsed = Date.now() - started;

  assert.ok(
    elapsed < 5_000,
    `the nested stalled target must be abandoned at the child's 300ms budget, took ${elapsed}ms`
  );
  assert.ok(
    warns.some((w) => /first-content deadline/.test(w)),
    `expected a first-content deadline rejection in the child, saw: ${JSON.stringify(warns.slice(0, 5))}`
  );
  assert.notEqual(res.status, 200, "an exhausted nested pool must not report success");
});

test("nested: a budget on the OUTER is inert for combo-ref targets", async () => {
  const { warns, log } = recordingLog();
  const child = {
    name: "child-no-budget",
    strategy: "reset-aware",
    models: ["openai/stalled-model"],
    config: { maxRetries: 0, retryDelayMs: 0 },
  };
  const outer = {
    name: "outer-with-budget",
    strategy: "priority",
    models: [{ kind: "combo-ref", comboName: "child-no-budget" }],
    config: {
      maxRetries: 0,
      retryDelayMs: 0,
      nestedComboMode: "execute",
      firstContentTimeoutMs: 300,
    },
  };

  let settled = false;
  const pending = handleComboChat({
    body: { stream: true, messages: [{ role: "user", content: "Q" }] },
    combo: outer,
    handleSingleModel: async () => stalledSse(),
    log,
    settings: {},
    allCombos: [outer, child],
  }).then((r) => {
    settled = true;
    return r;
  });

  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(
    settled,
    false,
    "an outer budget cannot bound a combo-ref target — only the child's dispatch is peeked"
  );
  void warns;
  void pending;
});
