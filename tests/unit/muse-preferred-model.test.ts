/**
 * withMusePreferredModel: bare muse-spark-* ids remap to the executable
 * opencode-go/ combo when it resolves; everything else passes through.
 * (Positive rewrite path is covered live at nonprod-verify; here we pin the
 * guards, which must never misroute other clients' models.)
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupTempDataDir } from "../_setup/tempDataDir.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-muse-preferred-model-"));
process.env.DATA_DIR = dataDir;
after(async () => await cleanupTempDataDir(dataDir));

const { withMusePreferredModel } = await import("../../src/app/api/v1/responses/route.ts");

function postRequest(body: unknown) {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("non-muse model passes through untouched", async () => {
  const body = { model: "openai/gpt-4o", input: "hello" };
  const result = await withMusePreferredModel(postRequest(body), body);
  assert.equal(result.body, body);
});

test("slashed model id is never rewritten", async () => {
  const body = { model: "opencode-go/muse-spark-1.3-contributor", input: "hello" };
  const result = await withMusePreferredModel(postRequest(body), body);
  assert.equal(result.body, body);
});

test("non-object body passes through unrewritten", async () => {
  const request = postRequest([1, 2, 3]);
  const result = await withMusePreferredModel(request, null);
  assert.deepEqual(result.body, [1, 2, 3]);
});

test("bare muse-spark id rewrites to opencode-go route (bare id is unroutable)", async () => {
  // No combos seeded in temp DATA_DIR and none named for muse exists in prod
  // either (verified live); the bare id can only fail downstream, so rewrite.
  const body = { model: "muse-spark-1.3-contributor", input: "hello" };
  const result = await withMusePreferredModel(postRequest(body), body);
  assert.deepEqual(result.body, {
    model: "opencode-go/muse-spark-1.3-contributor",
    input: "hello",
  });
});
