import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

useDecollidedMigrationsDir();
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-failure-"));
process.env.DATA_DIR = testDataDir;
process.env.NODE_ENV = "test";

const core = await import("../../src/lib/db/core.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const artifactWriter = await import("../../src/lib/usage/callLogArtifactWriter.ts");

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test.after(async () => {
  await artifactWriter.closeCallLogArtifactWriter();
  core.resetDbInstance();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

test("failed summary insert removes its artifact and still schedules orphan rotation", async () => {
  const db = core.getDbInstance();
  db.exec(`
    CREATE TRIGGER reject_call_log_insert
    BEFORE INSERT ON call_logs
    BEGIN
      SELECT RAISE(FAIL, 'forced call-log insert failure');
    END;
  `);

  const orphanPath = path.join(testDataDir, "call_logs", "2026-08-10", "orphan.json");
  fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
  fs.writeFileSync(orphanPath, "{}");
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(orphanPath, old, old);

  await callLogs.saveCallLog({
    id: "forced-insert-failure",
    timestamp: "2026-08-22T12:34:56.789Z",
    status: 503,
    model: "test-model",
    provider: "test-provider",
    requestBody: { should: "be-cleaned" },
    error: "forced",
  });

  const rowCount = db
    .prepare("SELECT COUNT(*) AS count FROM call_logs WHERE id = ?")
    .get("forced-insert-failure") as { count: number };
  assert.equal(rowCount.count, 0);

  const failedArtifactDir = path.join(testDataDir, "call_logs", "2026-08-22");
  assert.equal(fs.existsSync(failedArtifactDir), false);
  assert.equal(await waitUntil(() => !fs.existsSync(orphanPath)), true);
});
