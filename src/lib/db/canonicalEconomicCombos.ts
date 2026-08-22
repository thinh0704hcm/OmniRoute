/**
 * Persistence boundary for the canonical economic/performance combo reconciler.
 *
 * The operator can target a production database or an isolated canary copy, so this module owns
 * a short-lived handle instead of the process-wide application singleton. All table access,
 * backup creation, concurrency checks, and transactional writes stay inside the DB layer.
 */

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import {
  planCanonicalComboReconciliation,
  type CanonicalComboOperation,
  type CanonicalComboReconciliationPlan,
  type StoredCanonicalCombo,
} from "../combos/canonicalEconomicPools.ts";

type ComboRow = {
  id: string;
  name: string;
  data: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type CanonicalComboDatabaseOptions = {
  dbPath: string;
  adopt?: boolean;
  now?: string;
};

export type CanonicalComboDatabaseInspection = {
  dbPath: string;
  plan: CanonicalComboReconciliationPlan;
};

export type CanonicalComboDatabaseApplyResult = CanonicalComboDatabaseInspection & {
  applied: number;
  backupPath: string | null;
};

function openDatabase(dbPath: string, readonly: boolean): Database.Database {
  const resolvedPath = path.resolve(dbPath);
  if (!fs.existsSync(resolvedPath)) throw new Error(`Database does not exist: ${resolvedPath}`);
  return new Database(resolvedPath, { readonly, fileMustExist: true });
}

function readComboRows(database: Database.Database): StoredCanonicalCombo[] {
  const table = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'combos'")
    .get();
  if (!table) throw new Error("Database has no combos table; start OmniRoute once first");

  return (
    database
      .prepare("SELECT id, name, data, sort_order, created_at, updated_at FROM combos")
      .all() as ComboRow[]
  ).map((row) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.data) as Record<string, unknown>;
    } catch {
      throw new Error(`Combo ${row.name} has invalid JSON and cannot be reconciled safely`);
    }
    return {
      ...parsed,
      id: row.id,
      name: row.name,
      sortOrder: row.sort_order,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : row.created_at,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : row.updated_at,
    };
  });
}

function timestampForFile(value: string): string {
  return value.replace(/[:.]/g, "-");
}

function assertBackupIntegrity(backupPath: string): void {
  const backupDatabase = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    const result = backupDatabase.pragma("integrity_check", { simple: true });
    if (result !== "ok") {
      throw new Error(`Backup integrity_check failed for ${backupPath}: ${String(result)}`);
    }
  } finally {
    backupDatabase.close();
  }
}

function finalizeBackupWithoutClobber(
  partialPath: string,
  backupDir: string,
  filenameStem: string
): string {
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const filename = `${filenameStem}${suffix === 0 ? "" : `-${suffix}`}.sqlite`;
    const finalPath = path.join(backupDir, filename);
    try {
      // The staging directory and final path share a filesystem. A hard link publishes the
      // already-complete inode atomically, and unlike rename() it fails instead of replacing an
      // existing rollback point.
      fs.linkSync(partialPath, finalPath);
      return finalPath;
    } catch (error: unknown) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code)
          : "";
      if (code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`Could not reserve a unique canonical-combo backup name in ${backupDir}`);
}

async function createPreReconcileBackup(
  database: Database.Database,
  dbPath: string,
  now: string
): Promise<string> {
  const backupDir = path.join(path.dirname(dbPath), "db_backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const filenameStem = `db_${timestampForFile(now)}_pre-canonical-combos`;
  const stagingDir = fs.mkdtempSync(path.join(backupDir, ".canonical-combo-backup-"));
  const partialPath = path.join(stagingDir, `${filenameStem}.partial.sqlite`);
  let finalPath: string | null = null;

  try {
    await database.backup(partialPath);
    assertBackupIntegrity(partialPath);
    finalPath = finalizeBackupWithoutClobber(partialPath, backupDir, filenameStem);
    assertBackupIntegrity(finalPath);
    return finalPath;
  } catch (error) {
    // A failed post-publication validation invalidates only the path this invocation linked.
    // Existing files are unreachable here because linkSync() is no-clobber.
    if (finalPath) {
      try {
        fs.unlinkSync(finalPath);
      } catch {
        // Preserve the original validation/finalization error.
      }
    }
    throw error;
  } finally {
    // stagingDir is an exact mkdtemp result owned by this invocation.
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function applyOperations(database: Database.Database, operations: CanonicalComboOperation[]): void {
  const insert = database.prepare(
    "INSERT INTO combos (id, name, data, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const update = database.prepare(
    "UPDATE combos SET name = ?, data = ?, sort_order = ?, updated_at = ? WHERE id = ? AND updated_at = ?"
  );
  const remove = database.prepare(
    "DELETE FROM combos WHERE id = ? AND name = ? AND updated_at = ?"
  );

  const transaction = database.transaction(() => {
    for (const operation of operations) {
      if (operation.action === "delete") {
        const result = remove.run(operation.combo.id, operation.name, operation.previousUpdatedAt);
        if (result.changes !== 1) throw new Error(`Delete race for combo ${operation.name}`);
        continue;
      }

      const combo = operation.combo;
      if (operation.action === "create") {
        insert.run(
          combo.id,
          combo.name,
          JSON.stringify(combo),
          combo.sortOrder,
          combo.createdAt,
          combo.updatedAt
        );
        continue;
      }

      const result = update.run(
        combo.name,
        JSON.stringify(combo),
        combo.sortOrder,
        combo.updatedAt,
        combo.id,
        operation.previousUpdatedAt
      );
      if (result.changes !== 1) throw new Error(`Update race for combo ${operation.name}`);
    }
  });
  transaction();
}

export function inspectCanonicalComboDatabase(
  options: CanonicalComboDatabaseOptions
): CanonicalComboDatabaseInspection {
  const dbPath = path.resolve(options.dbPath);
  const database = openDatabase(dbPath, true);
  try {
    const plan = planCanonicalComboReconciliation(readComboRows(database), {
      adopt: options.adopt,
      now: options.now,
    });
    return { dbPath, plan };
  } finally {
    database.close();
  }
}

export async function reconcileCanonicalComboDatabase(
  options: CanonicalComboDatabaseOptions
): Promise<CanonicalComboDatabaseApplyResult> {
  const dbPath = path.resolve(options.dbPath);
  const now = options.now || new Date().toISOString();
  const database = openDatabase(dbPath, false);
  try {
    database.pragma("busy_timeout = 10000");
    const plan = planCanonicalComboReconciliation(readComboRows(database), {
      adopt: options.adopt,
      now,
    });
    if (plan.conflicts.length > 0) {
      throw new Error(
        `Refusing ${plan.conflicts.length} unowned row(s); inspect dry-run and use --adopt only for the first reviewed apply`
      );
    }
    if (plan.operations.length === 0) {
      return { dbPath, plan, applied: 0, backupPath: null };
    }

    const backupPath = await createPreReconcileBackup(database, dbPath, now);
    applyOperations(database, plan.operations);

    const postPlan = planCanonicalComboReconciliation(readComboRows(database), { now });
    if (postPlan.drift) throw new Error("Post-apply verification found remaining combo drift");
    return {
      dbPath,
      plan: postPlan,
      applied: plan.operations.length,
      backupPath,
    };
  } finally {
    database.close();
  }
}
