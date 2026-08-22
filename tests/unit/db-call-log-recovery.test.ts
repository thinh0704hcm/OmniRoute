import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.ts";
import { recoverCallLogsFromArtifacts } from "../../src/lib/db/callLogRecovery.ts";
import { buildArtifactRelativePath } from "../../src/lib/usage/callLogArtifacts.ts";
import { parseRecoveryArgs } from "../../scripts/ops/recover-call-logs.mjs";

function createDb() {
  const raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE call_logs (
      id TEXT PRIMARY KEY, timestamp TEXT NOT NULL, method TEXT, path TEXT, status INTEGER,
      model TEXT, requested_model TEXT, provider TEXT, account TEXT, connection_id TEXT,
      duration INTEGER, tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER,
      tokens_cache_creation INTEGER, tokens_reasoning INTEGER, tokens_compressed INTEGER,
      reasoning_source TEXT, reasoning_chars INTEGER, cache_source TEXT, request_type TEXT,
      source_format TEXT, target_format TEXT, api_key_id TEXT, api_key_name TEXT,
      combo_name TEXT, combo_step_id TEXT, combo_execution_key TEXT, error_summary TEXT,
      detail_state TEXT, artifact_relpath TEXT, artifact_size_bytes INTEGER,
      artifact_sha256 TEXT, has_request_body INTEGER, has_response_body INTEGER,
      has_pipeline_details INTEGER, request_summary TEXT, correlation_id TEXT,
      model_pinned INTEGER, session_tag TEXT, response_id TEXT, error_type TEXT
    );
  `);
  return { raw, db: createBetterSqliteAdapter(raw) };
}

function artifact(id: string, timestamp: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 5,
    summary: {
      id,
      timestamp,
      method: "POST",
      path: "/v1/responses",
      status: 503,
      model: "gpt-5.6-luna",
      requestedModel: "gpt-5.6-luna",
      provider: "github",
      account: "test-account",
      connectionId: "connection-1",
      duration: 123,
      tokens: {
        in: 10,
        out: 20,
        cacheRead: null,
        cacheWrite: null,
        reasoning: 2,
        compressed: null,
      },
      requestType: "search",
      sourceFormat: "claude",
      targetFormat: "openai-responses",
      apiKeyId: null,
      apiKeyName: null,
      comboName: "pool-opus",
      comboStepId: "github-luna",
      comboExecutionKey: "exec-1",
    },
    requestBody: { query: "safe query", provider: "github", limit: 3 },
    responseBody: { object: "response", id: `resp_${id}` },
    error: "upstream service unavailable",
    ...overrides,
  };
}

function writeArtifact(baseDir: string, value: ReturnType<typeof artifact>) {
  const relativePath = buildArtifactRelativePath(value.summary.timestamp, value.summary.id);
  const absolutePath = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, JSON.stringify(value));
  return { relativePath, absolutePath };
}

test("recovery dry-run, apply, and rerun are bounded and idempotent", () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-recovery-"));
  const { raw, db } = createDb();
  try {
    const valid = writeArtifact(artifactDir, artifact("recover-1", "2026-08-22T13:00:00.000Z"));
    writeArtifact(artifactDir, artifact("before-window", "2026-08-22T11:00:00.000Z"));
    const corruptPath = path.join(artifactDir, "2026-08-22", "corrupt.json");
    fs.mkdirSync(path.dirname(corruptPath), { recursive: true });
    fs.writeFileSync(corruptPath, "{");

    const options = {
      artifactDir,
      fromExclusive: "2026-08-22T12:00:00.000Z",
      throughInclusive: "2026-08-22T14:00:00.000Z",
    };
    const dryRun = recoverCallLogsFromArtifacts(db, options);
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.wouldInsert, 1);
    assert.equal(dryRun.inserted, 0);
    assert.equal(dryRun.outOfWindow, 1);
    assert.equal(dryRun.corrupt, 1);
    assert.equal(
      (raw.prepare("SELECT COUNT(*) AS count FROM call_logs").get() as { count: number }).count,
      0
    );

    const applied = recoverCallLogsFromArtifacts(db, { ...options, apply: true });
    assert.equal(applied.inserted, 1);
    const row = raw.prepare("SELECT * FROM call_logs WHERE id = ?").get("recover-1") as {
      artifact_relpath: string;
      artifact_sha256: string;
      response_id: string;
      error_type: string;
      request_summary: string;
    };
    assert.equal(row.artifact_relpath, valid.relativePath);
    assert.match(row.artifact_sha256, /^[0-9a-f]{8}$/);
    assert.equal(row.response_id, "resp_recover-1");
    assert.equal(row.error_type, "server_error");
    assert.deepEqual(JSON.parse(row.request_summary), {
      query: "safe query",
      filters: { limit: 3 },
    });

    const rerun = recoverCallLogsFromArtifacts(db, { ...options, apply: true });
    assert.equal(rerun.inserted, 0);
    assert.equal(rerun.duplicates, 1);
  } finally {
    raw.close();
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("recovery rejects checksum-changing collisions without overwriting the row", () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-collision-"));
  const { raw, db } = createDb();
  const options = {
    artifactDir,
    fromExclusive: "2026-08-22T12:00:00.000Z",
    throughInclusive: "2026-08-22T14:00:00.000Z",
    apply: true,
  };
  try {
    const written = writeArtifact(
      artifactDir,
      artifact("recover-collision", "2026-08-22T13:00:00.000Z")
    );
    recoverCallLogsFromArtifacts(db, options);
    fs.writeFileSync(
      written.absolutePath,
      JSON.stringify(
        artifact("recover-collision", "2026-08-22T13:00:00.000Z", {
          error: "changed after insertion",
        })
      )
    );

    const collision = recoverCallLogsFromArtifacts(db, options);
    assert.equal(collision.inserted, 0);
    assert.equal(collision.collisions, 1);
    assert.equal(collision.checksumMismatches, 1);
    assert.equal(
      (
        raw
          .prepare("SELECT error_summary FROM call_logs WHERE id = ?")
          .get("recover-collision") as { error_summary: string }
      ).error_summary,
      "upstream service unavailable"
    );
  } finally {
    raw.close();
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("recovery applies all candidate rows in one transaction", () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-transaction-"));
  const { raw, db } = createDb();
  try {
    writeArtifact(artifactDir, artifact("transaction-ok", "2026-08-22T13:00:00.000Z"));
    writeArtifact(artifactDir, artifact("transaction-reject", "2026-08-22T13:01:00.000Z"));
    raw.exec(`
      CREATE TRIGGER reject_recovery_row BEFORE INSERT ON call_logs
      WHEN NEW.id = 'transaction-reject'
      BEGIN SELECT RAISE(FAIL, 'forced recovery failure'); END;
    `);

    assert.throws(() =>
      recoverCallLogsFromArtifacts(db, {
        artifactDir,
        fromExclusive: "2026-08-22T12:00:00.000Z",
        throughInclusive: "2026-08-22T14:00:00.000Z",
        apply: true,
      })
    );
    assert.equal(
      (raw.prepare("SELECT COUNT(*) AS count FROM call_logs").get() as { count: number }).count,
      0
    );
  } finally {
    raw.close();
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("recovery CLI defaults to dry-run and requires an explicit apply switch", () => {
  assert.deepEqual(
    parseRecoveryArgs([
      "--db",
      "/tmp/storage.sqlite",
      "--from",
      "2026-08-19T12:44:10.277Z",
      "--through",
      "2026-08-22T15:00:00.000Z",
    ]),
    {
      apply: false,
      maxRows: 100_000,
      dbPath: "/tmp/storage.sqlite",
      fromExclusive: "2026-08-19T12:44:10.277Z",
      throughInclusive: "2026-08-22T15:00:00.000Z",
    }
  );
  assert.equal(parseRecoveryArgs(["--apply"]).apply, true);
  assert.throws(() => parseRecoveryArgs(["--max-rows", "10oops"]));
});
