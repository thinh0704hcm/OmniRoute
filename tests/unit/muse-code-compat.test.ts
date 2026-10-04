/**
 * Muse Code compat surface: model resolution, session pinning, catalog,
 * and search-shape mapping.
 *
 * Covers `open-sse/handlers/museCode.ts` plus
 * `src/app/api/internal/muse-code/modelResolution.ts`:
 * - bare Spark ids rewrite to opencode-go/ only when genuinely registered
 * - combos, "auto", prefixed ids, and non-Spark ids pass through
 * - session id binds the muse session uuid to the workspace
 * - error bodies carry no stack traces
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMuseCodeCatalog,
  deriveMuseCodeSessionId,
  isMuseSparkModel,
  MUSE_CODE_UPSTREAM_PREFIX,
  shortHash,
  toMuseCodeSearchShape,
} from "../../open-sse/handlers/museCode.ts";
import { resolveMuseCodeApiModel } from "../src/app/api/internal/muse-code/modelResolution.ts";
import { errorResponse } from "../../open-sse/utils/error.ts";
import { HTTP_STATUS } from "../../open-sse/config/constants.ts";

test("isMuseSparkModel matches bare Spark ids only", () => {
  assert.equal(isMuseSparkModel("muse-spark-1.3-contributor"), true);
  assert.equal(isMuseSparkModel("muse-spark-1.3"), true);
  assert.equal(isMuseSparkModel("muse-spark-1.1"), true);
  assert.equal(isMuseSparkModel("opencode-go/muse-spark-1.3-contributor"), false);
  assert.equal(isMuseSparkModel("llama-4-maverick"), false);
  assert.equal(isMuseSparkModel("auto"), false);
  assert.equal(isMuseSparkModel(undefined), false);
  assert.equal(isMuseSparkModel(42), false);
});

test("resolveMuseCodeApiModel rewrites bare Spark ids to opencode-go/", async () => {
  const resolve = async (id: string) =>
    id === "opencode-go/muse-spark-1.3-contributor"
      ? { provider: "opencode-go", model: "muse-spark-1.3-contributor" }
      : { provider: "other", model: id };
  const out = await resolveMuseCodeApiModel("muse-spark-1.3-contributor", resolve);
  assert.deepEqual(out, {
    model: "opencode-go/muse-spark-1.3-contributor",
    changed: true,
  });
});

test("resolveMuseCodeApiModel passes through combos, auto, prefixed, and unknown ids", async () => {
  const resolve = async (id: string) => ({ provider: "nara", model: id });
  assert.deepEqual(await resolveMuseCodeApiModel("paid-premium", resolve, async () => true), {
    model: "paid-premium",
    changed: false,
  });
  assert.deepEqual(await resolveMuseCodeApiModel("auto", resolve), {
    model: "auto",
    changed: false,
  });
  assert.deepEqual(await resolveMuseCodeApiModel("nara/muse-spark-1.3-contributor", resolve), {
    model: "nara/muse-spark-1.3-contributor",
    changed: false,
  });
  assert.deepEqual(await resolveMuseCodeApiModel("llama-4-maverick", resolve), {
    model: "llama-4-maverick",
    changed: false,
  });
});

test("resolveMuseCodeApiModel does not rewrite when opencode-go is unregistered", async () => {
  const resolve = async () => ({ provider: "nara", model: "muse-spark-1.3-contributor" });
  const out = await resolveMuseCodeApiModel("muse-spark-1.3-contributor", resolve);
  assert.deepEqual(out, { model: "muse-spark-1.3-contributor", changed: false });
});

test("resolveMuseCodeApiModel fails closed on resolver errors", async () => {
  const resolve = async (_id: string): Promise<{ provider?: string; model?: string }> => {
    throw new Error("db down");
  };
  const out = await resolveMuseCodeApiModel("muse-spark-1.3-contributor", resolve);
  assert.deepEqual(out, { model: "muse-spark-1.3-contributor", changed: false });
});

test("deriveMuseCodeSessionId binds session uuid to workspace deterministically", () => {
  const body = {
    prompt_cache_key: "tbh:main:12345678-1234-1234-1234-1234567890ab",
    input: [{ content: [{ text: "Workspace root: /home/u/proj" }] }],
  };
  const a = deriveMuseCodeSessionId(body, JSON.stringify(body));
  const b = deriveMuseCodeSessionId(body, JSON.stringify(body));
  assert.equal(a, b);
  assert.ok(a.startsWith("12345678-1234-1234-1234-1234567890ab:"));
  const other = deriveMuseCodeSessionId(
    { ...body, input: [{ content: [{ text: "Workspace root: /home/u/other" }] }] },
    JSON.stringify({ ...body, ws: "/home/u/other" }).replace("/home/u/proj", "/home/u/other")
  );
  assert.notEqual(a, other);
});

test("deriveMuseCodeSessionId falls back without a parseable cache key", () => {
  const a = deriveMuseCodeSessionId({}, "{}");
  const b = deriveMuseCodeSessionId({}, "{}");
  assert.match(a, /^[0-9a-f-]{36}:[0-9a-f]+$/);
  assert.notEqual(a, b);
});

test("shortHash is stable", () => {
  assert.equal(shortHash("/home/u/proj"), shortHash("/home/u/proj"));
  assert.notEqual(shortHash("/a"), shortHash("/b"));
});

test("buildMuseCodeCatalog advertises Spark ids with muse-code metadata", () => {
  const catalog = buildMuseCodeCatalog([
    {
      id: "muse-spark-1.3-contributor",
      name: "Muse Spark 1.3 Contributor",
      supportsReasoning: true,
      toolCalling: true,
      supportsVision: true,
      contextLength: 1048576,
    },
    {
      id: "llama-4-maverick",
      name: "Llama 4 Maverick",
      supportsReasoning: true,
      toolCalling: true,
      supportsVision: true,
    },
  ]);
  assert.equal(catalog.length, 2);
  const spark = catalog.find((m) => m.id === "muse-spark-1.3-contributor")!;
  assert.equal(spark.object, "model");
  assert.deepEqual(spark.metadata["muse-code"], {
    release_date: "2026-09-01",
    is_hidden: false,
    limit: { context: 1_000_000, output: 32_768 },
  });
  const llama = catalog.find((m) => m.id === "llama-4-maverick")!;
  assert.equal("muse-code" in llama.metadata, false);
  assert.equal(llama.metadata.family, "llama-4");
});

test("toMuseCodeSearchShape keeps title/url/snippet as strings", () => {
  const out = toMuseCodeSearchShape([
    { title: "T", url: "https://x", snippet: "S", score: 1, extra: true },
    { title: null, url: undefined, snippet: 5 },
  ]);
  assert.deepEqual(out, {
    results: [
      { title: "T", url: "https://x", snippet: "S" },
      { title: "", url: "", snippet: "5" },
    ],
  });
  assert.deepEqual(toMuseCodeSearchShape(null), { results: [] });
});

test("muse-code error bodies leak no stack traces", async () => {
  for (const res of [
    errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body"),
    errorResponse(HTTP_STATUS.BAD_GATEWAY, "web_search failed"),
  ]) {
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes("at /"), JSON.stringify(body).slice(0, 200));
  }
});

test("upstream prefix constant matches the zen Go provider", () => {
  assert.equal(MUSE_CODE_UPSTREAM_PREFIX, "opencode-go");
});
