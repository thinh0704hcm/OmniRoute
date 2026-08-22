#!/usr/bin/env node

/**
 * Inventory or explicitly prune validated, unreferenced call-log artifacts.
 *
 * Dry-run example:
 *   node --import tsx/esm scripts/ops/prune-call-log-orphans.mjs \
 *     --db /app/data/storage.sqlite --before 2026-08-22T15:00:00.000Z
 *
 * Apply only with the exact orphanCount and orphanBytes printed by that dry run.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function usage() {
  return [
    "Usage: node --import tsx/esm scripts/ops/prune-call-log-orphans.mjs",
    "       --db <storage.sqlite> --before <exclusive-ISO-mtime-cutoff>",
    "       [--artifacts <call_logs-dir>] [--max-files <count>]",
    "       [--apply --confirm-count <orphanCount> --confirm-bytes <orphanBytes>]",
    "",
    "Default mode is read-only inventory. Files at or newer than --before are excluded.",
    "Apply recomputes inventory and requires both exact dry-run confirmations.",
  ].join("\n");
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative safe integer`);
  }
  return parsed;
}

export function parsePruneArgs(argv) {
  const parsed = { apply: false, maxFiles: 100_000 };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--apply") parsed.apply = true;
    else if (flag === "--help" || flag === "-h") parsed.help = true;
    else if (
      [
        "--db",
        "--before",
        "--artifacts",
        "--max-files",
        "--confirm-count",
        "--confirm-bytes",
      ].includes(flag)
    ) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--db") parsed.dbPath = value;
      else if (flag === "--before") parsed.modifiedBeforeExclusive = value;
      else if (flag === "--artifacts") parsed.artifactDir = value;
      else if (flag === "--max-files") {
        parsed.maxFiles = parseNonNegativeInteger(value, flag);
        if (parsed.maxFiles < 1) throw new Error("--max-files must be a positive integer");
      } else if (flag === "--confirm-count") {
        parsed.confirmedCount = parseNonNegativeInteger(value, flag);
      } else {
        parsed.confirmedBytes = parseNonNegativeInteger(value, flag);
      }
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }

  if (parsed.apply) {
    if (parsed.confirmedCount === undefined) {
      throw new Error("--apply requires --confirm-count from the dry-run inventory");
    }
    if (parsed.confirmedBytes === undefined) {
      throw new Error("--apply requires --confirm-bytes from the dry-run inventory");
    }
  } else if (parsed.confirmedCount !== undefined || parsed.confirmedBytes !== undefined) {
    throw new Error("--confirm-count and --confirm-bytes may only be used with --apply");
  }
  return parsed;
}

async function main() {
  const args = parsePruneArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.dbPath || !args.modifiedBeforeExclusive) {
    throw new Error(`--db and --before are required\n\n${usage()}`);
  }

  const dbPath = path.resolve(args.dbPath);
  const artifactDir = path.resolve(
    args.artifactDir || path.join(path.dirname(dbPath), "call_logs")
  );
  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
    throw new Error(`SQLite database does not exist: ${dbPath}`);
  }

  const [{ tryOpenSync }, recovery] = await Promise.all([
    import("../../src/lib/db/adapters/driverFactory.ts"),
    import("../../src/lib/db/callLogRecovery.ts"),
  ]);
  // Pruning mutates only individually validated artifact files. SQLite stays read-only.
  const db = tryOpenSync(dbPath, {
    fileMustExist: true,
    readonly: true,
    timeout: 2_000,
  });
  if (!db) throw new Error("No synchronous SQLite driver is available");

  try {
    const commonOptions = {
      artifactDir,
      modifiedBeforeExclusive: args.modifiedBeforeExclusive,
      maxFiles: args.maxFiles,
    };
    const result = args.apply
      ? recovery.pruneCallLogOrphans(db, {
          ...commonOptions,
          confirmedCount: args.confirmedCount,
          confirmedBytes: args.confirmedBytes,
        })
      : recovery.inventoryCallLogOrphans(db, commonOptions);
    console.log(JSON.stringify({ mode: args.apply ? "apply" : "dry-run", ...result }, null, 2));
    if (
      result.corrupt > 0 ||
      result.invalid > 0 ||
      result.unsafeEntries > 0 ||
      ("unlinkErrors" in result && result.unlinkErrors > 0) ||
      ("preservedChanged" in result && result.preservedChanged > 0)
    ) {
      process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      `[prune-call-log-orphans] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
