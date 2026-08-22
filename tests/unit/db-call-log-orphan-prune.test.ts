import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.ts";
import type { SqliteAdapter } from "../../src/lib/db/adapters/types.ts";
import { inventoryCallLogOrphans, pruneCallLogOrphans } from "../../src/lib/db/callLogRecovery.ts";
import { buildArtifactRelativePath } from "../../src/lib/usage/callLogArtifacts.ts";
import { parsePruneArgs } from "../../scripts/ops/prune-call-log-orphans.mjs";

const CUTOFF = "2026-08-22T14:00:00.000Z";
const OLD_MTIME = new Date("2026-08-22T13:00:00.000Z");

function createDb() {
  const raw = new Database(":memory:");
  raw.exec(`
    CREATE TABLE call_logs (
      id TEXT PRIMARY KEY,
      artifact_relpath TEXT
    );
  `);
  return { raw, db: createBetterSqliteAdapter(raw) };
}

function artifact(id: string, timestamp: string) {
  return {
    schemaVersion: 5,
    summary: {
      id,
      timestamp,
      method: "POST",
      path: "/v1/responses",
      status: 200,
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
      requestType: "chat",
      sourceFormat: "claude",
      targetFormat: "openai-responses",
      apiKeyId: null,
      apiKeyName: null,
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
    },
    requestBody: { messages: [{ role: "user", content: "hello" }] },
    responseBody: { object: "response", id: `resp_${id}` },
    error: null,
  };
}

function writeArtifact(baseDir: string, id: string, timestamp: string, mtime = OLD_MTIME) {
  const value = artifact(id, timestamp);
  const relativePath = buildArtifactRelativePath(timestamp, id);
  const absolutePath = path.join(baseDir, relativePath);
  const serialized = JSON.stringify(value);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, serialized);
  fs.utimesSync(absolutePath, mtime, mtime);
  return {
    relativePath,
    absolutePath,
    sizeBytes: Buffer.byteLength(serialized),
  };
}

test("orphan inventory is read-only and excludes referenced and live/new artifacts", () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-orphan-inventory-"));
  const { raw, db } = createDb();
  try {
    const orphan = writeArtifact(artifactDir, "old-orphan", "2026-08-22T12:00:00.000Z");
    const referenced = writeArtifact(artifactDir, "old-referenced", "2026-08-22T12:01:00.000Z");
    const newer = writeArtifact(
      artifactDir,
      "new-orphan",
      "2026-08-22T12:02:00.000Z",
      new Date(CUTOFF)
    );
    raw
      .prepare("INSERT INTO call_logs (id, artifact_relpath) VALUES (?, ?)")
      .run("old-referenced", referenced.relativePath);

    const result = inventoryCallLogOrphans(db, {
      artifactDir,
      modifiedBeforeExclusive: CUTOFF,
    });

    assert.equal(result.orphanCount, 1);
    assert.equal(result.orphanBytes, orphan.sizeBytes);
    assert.equal(result.referenced, 1);
    assert.equal(result.atOrAfterCutoff, 1);
    assert.equal(result.valid, 2);
    assert.equal(fs.existsSync(orphan.absolutePath), true);
    assert.equal(fs.existsSync(referenced.absolutePath), true);
    assert.equal(fs.existsSync(newer.absolutePath), true);
  } finally {
    raw.close();
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("prune refuses count or byte confirmations that do not exactly match inventory", () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-orphan-confirm-"));
  const { raw, db } = createDb();
  try {
    const orphan = writeArtifact(artifactDir, "confirmation-orphan", "2026-08-22T12:00:00.000Z");
    const inventory = inventoryCallLogOrphans(db, {
      artifactDir,
      modifiedBeforeExclusive: CUTOFF,
    });

    assert.throws(
      () =>
        pruneCallLogOrphans(db, {
          artifactDir,
          modifiedBeforeExclusive: CUTOFF,
          confirmedCount: inventory.orphanCount + 1,
          confirmedBytes: inventory.orphanBytes,
        }),
      /confirmation does not match/i
    );
    assert.throws(
      () =>
        pruneCallLogOrphans(db, {
          artifactDir,
          modifiedBeforeExclusive: CUTOFF,
          confirmedCount: inventory.orphanCount,
          confirmedBytes: inventory.orphanBytes + 1,
        }),
      /confirmation does not match/i
    );
    assert.equal(fs.existsSync(orphan.absolutePath), true);
  } finally {
    raw.close();
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("prune preserves pre-referenced artifacts and rows that race the final reference check", () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-orphan-race-"));
  const { raw, db } = createDb();
  try {
    const referenced = writeArtifact(artifactDir, "already-referenced", "2026-08-22T12:00:00.000Z");
    const raced = writeArtifact(artifactDir, "raced-reference", "2026-08-22T12:01:00.000Z");
    raw
      .prepare("INSERT INTO call_logs (id, artifact_relpath) VALUES (?, ?)")
      .run("already-referenced", referenced.relativePath);

    const inventory = inventoryCallLogOrphans(db, {
      artifactDir,
      modifiedBeforeExclusive: CUTOFF,
    });
    assert.equal(inventory.orphanCount, 1);

    let racedLookups = 0;
    const racingDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("WHERE artifact_relpath = ?")) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty !== "get") {
                return Reflect.get(statementTarget, statementProperty, statementReceiver);
              }
              return (...params: unknown[]) => {
                if (params[0] === raced.relativePath) {
                  racedLookups++;
                  if (racedLookups === 2) {
                    raw
                      .prepare("INSERT INTO call_logs (id, artifact_relpath) VALUES (?, ?)")
                      .run("raced-reference", raced.relativePath);
                  }
                }
                return statementTarget.get(...params);
              };
            },
          });
        };
      },
    }) as SqliteAdapter;

    const applied = pruneCallLogOrphans(racingDb, {
      artifactDir,
      modifiedBeforeExclusive: CUTOFF,
      confirmedCount: inventory.orphanCount,
      confirmedBytes: inventory.orphanBytes,
    });

    assert.equal(applied.deletedCount, 0);
    assert.equal(applied.preservedByReferenceRace, 1);
    assert.equal(fs.existsSync(referenced.absolutePath), true);
    assert.equal(fs.existsSync(raced.absolutePath), true);
  } finally {
    raw.close();
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("inventory never follows symlinks or nested paths outside dated artifact directories", (t) => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-orphan-bounds-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-orphan-outside-"));
  const { raw, db } = createDb();
  try {
    const valid = writeArtifact(artifactDir, "bounded-orphan", "2026-08-22T12:00:00.000Z");
    const outside = writeArtifact(outsideDir, "outside-orphan", "2026-08-22T12:01:00.000Z");
    const linkedFile = path.join(path.dirname(valid.absolutePath), "linked.json");
    const linkedDay = path.join(artifactDir, "2026-08-21");
    try {
      fs.symlinkSync(outside.absolutePath, linkedFile);
      fs.symlinkSync(path.dirname(outside.absolutePath), linkedDay, "dir");
    } catch (error) {
      t.skip(`symlinks unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const nestedDir = path.join(path.dirname(valid.absolutePath), "nested");
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(
      path.join(nestedDir, "nested.json"),
      JSON.stringify(artifact("nested", CUTOFF))
    );

    const inventory = inventoryCallLogOrphans(db, {
      artifactDir,
      modifiedBeforeExclusive: CUTOFF,
    });

    assert.equal(inventory.orphanCount, 1);
    assert.ok(inventory.unsafeEntries >= 3);
    assert.equal(fs.existsSync(outside.absolutePath), true);
    assert.equal(fs.lstatSync(linkedFile).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(linkedDay).isSymbolicLink(), true);
  } finally {
    raw.close();
    fs.rmSync(artifactDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("confirmed prune unlinks files individually, removes only empty day dirs, and is idempotent", () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-orphan-apply-"));
  const { raw, db } = createDb();
  try {
    const first = writeArtifact(artifactDir, "apply-one", "2026-08-21T12:00:00.000Z");
    const second = writeArtifact(artifactDir, "apply-two", "2026-08-21T12:01:00.000Z");
    const live = writeArtifact(
      artifactDir,
      "keep-live",
      "2026-08-22T12:02:00.000Z",
      new Date("2026-08-22T14:01:00.000Z")
    );
    const inventory = inventoryCallLogOrphans(db, {
      artifactDir,
      modifiedBeforeExclusive: CUTOFF,
    });

    const applied = pruneCallLogOrphans(db, {
      artifactDir,
      modifiedBeforeExclusive: CUTOFF,
      confirmedCount: inventory.orphanCount,
      confirmedBytes: inventory.orphanBytes,
    });
    assert.equal(applied.deletedCount, 2);
    assert.equal(applied.deletedBytes, first.sizeBytes + second.sizeBytes);
    assert.equal(applied.emptyDayDirsRemoved, 1);
    assert.equal(fs.existsSync(first.absolutePath), false);
    assert.equal(fs.existsSync(second.absolutePath), false);
    assert.equal(fs.existsSync(path.dirname(first.absolutePath)), false);
    assert.equal(fs.existsSync(live.absolutePath), true);
    assert.equal(fs.existsSync(artifactDir), true);

    const rerunInventory = inventoryCallLogOrphans(db, {
      artifactDir,
      modifiedBeforeExclusive: CUTOFF,
    });
    assert.equal(rerunInventory.orphanCount, 0);
    const rerun = pruneCallLogOrphans(db, {
      artifactDir,
      modifiedBeforeExclusive: CUTOFF,
      confirmedCount: 0,
      confirmedBytes: 0,
    });
    assert.equal(rerun.deletedCount, 0);
    assert.equal(fs.existsSync(artifactDir), true);
  } finally {
    raw.close();
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("orphan prune CLI is dry-run by default and requires both apply confirmations", () => {
  assert.deepEqual(
    parsePruneArgs(["--db", "/tmp/storage.sqlite", "--before", CUTOFF, "--max-files", "42"]),
    {
      apply: false,
      maxFiles: 42,
      dbPath: "/tmp/storage.sqlite",
      modifiedBeforeExclusive: CUTOFF,
    }
  );
  assert.throws(
    () =>
      parsePruneArgs([
        "--apply",
        "--confirm-count",
        "1",
        "--db",
        "/tmp/storage.sqlite",
        "--before",
        CUTOFF,
      ]),
    /--confirm-bytes/
  );
  assert.throws(
    () => parsePruneArgs(["--apply", "--confirm-count", "1", "--confirm-bytes", "10oops"]),
    /--confirm-bytes/
  );
});
