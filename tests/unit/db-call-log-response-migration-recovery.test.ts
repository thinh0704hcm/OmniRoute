import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

const migrationsDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-call-log-response-migration-")
);
const originalMigrationsDir = process.env.OMNIROUTE_MIGRATIONS_DIR;
process.env.OMNIROUTE_MIGRATIONS_DIR = migrationsDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

fs.writeFileSync(
  path.join(migrationsDir, "154_call_logs_response_id.sql"),
  "ALTER TABLE call_logs ADD COLUMN response_id TEXT DEFAULT NULL; " +
    "CREATE INDEX IF NOT EXISTS idx_cl_response_id ON call_logs(response_id);"
);
fs.writeFileSync(
  path.join(migrationsDir, "157_exclusive_connection_leases.sql"),
  "CREATE TABLE IF NOT EXISTS exclusive_connection_leases (connection_id TEXT PRIMARY KEY);"
);

const { runMigrations } = await import("../../src/lib/db/migrationRunner.ts");
const { ensureCallLogsColumns } = await import("../../src/lib/db/schemaColumns.ts");

function createDatabase(applied: Array<{ version: string; name: string }>) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE call_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      combo_name TEXT
    );
    CREATE TABLE exclusive_connection_leases (connection_id TEXT PRIMARY KEY);
    CREATE TABLE _omniroute_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const insert = db.prepare("INSERT INTO _omniroute_migrations (version, name) VALUES (?, ?)");
  for (const migration of applied) insert.run(migration.version, migration.name);
  return db;
}

function assertResponseSchema(db: Database.Database) {
  const columns = db.prepare("PRAGMA table_info(call_logs)").all() as Array<{ name: string }>;
  assert.equal(
    columns.some((column) => column.name === "response_id"),
    true
  );
  assert.ok(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_cl_response_id'")
      .get()
  );
}

test.after(() => {
  fs.rmSync(migrationsDir, { recursive: true, force: true });
  if (originalMigrationsDir === undefined) delete process.env.OMNIROUTE_MIGRATIONS_DIR;
  else process.env.OMNIROUTE_MIGRATIONS_DIR = originalMigrationsDir;
  delete process.env.DISABLE_SQLITE_AUTO_BACKUP;
});

test("legacy 154 lease marker is moved to 157 so canonical response migration can run", () => {
  const db = createDatabase([{ version: "154", name: "exclusive_connection_leases" }]);
  try {
    assert.equal(runMigrations(db), 1);
    assertResponseSchema(db);
    assert.deepEqual(
      db.prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version").all(),
      [
        { version: "154", name: "call_logs_response_id" },
        { version: "157", name: "exclusive_connection_leases" },
      ]
    );
  } finally {
    db.close();
  }
});

test("production-shaped 154 and 157 lease markers free 154 without losing 157", () => {
  const db = createDatabase([
    { version: "154", name: "exclusive_connection_leases" },
    { version: "157", name: "exclusive_connection_leases" },
  ]);
  try {
    assert.equal(runMigrations(db), 1);
    assertResponseSchema(db);
    assert.deepEqual(
      db.prepare("SELECT version, name FROM _omniroute_migrations ORDER BY version").all(),
      [
        { version: "154", name: "call_logs_response_id" },
        { version: "157", name: "exclusive_connection_leases" },
      ]
    );
  } finally {
    db.close();
  }
});

test("partially applied response schema heals the missing index idempotently", () => {
  const db = createDatabase([{ version: "157", name: "exclusive_connection_leases" }]);
  try {
    db.exec("ALTER TABLE call_logs ADD COLUMN response_id TEXT DEFAULT NULL");
    assert.equal(runMigrations(db), 1);
    assertResponseSchema(db);
    assert.equal(runMigrations(db), 0);
  } finally {
    db.close();
  }
});

test("call-log schema reconciliation heals response_id and its index", () => {
  const db = createDatabase([]);
  try {
    assert.doesNotThrow(() => ensureCallLogsColumns(db));
    assertResponseSchema(db);
    assert.doesNotThrow(() => ensureCallLogsColumns(db));
  } finally {
    db.close();
  }
});
