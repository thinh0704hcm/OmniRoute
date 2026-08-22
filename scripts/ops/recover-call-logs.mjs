#!/usr/bin/env node

/**
 * Recover SQLite call-log summaries from validated request artifacts.
 *
 * Usage:
 *   node --import tsx/esm scripts/ops/recover-call-logs.mjs \
 *     --db /app/data/storage.sqlite \
 *     --from 2026-08-19T12:44:10.277Z \
 *     --through 2026-08-22T15:00:00.000Z
 *
 * Add --apply only after reviewing the dry-run JSON and taking an online DB backup.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function usage() {
  return [
    "Usage: node --import tsx/esm scripts/ops/recover-call-logs.mjs --db <storage.sqlite>",
    "       --from <exclusive-ISO-timestamp> --through <inclusive-ISO-timestamp>",
    "       [--artifacts <call_logs-dir>] [--max-rows <count>] [--apply]",
    "",
    "Default mode is read-only dry-run. --apply is the only write switch.",
  ].join("\n");
}

export function parseRecoveryArgs(argv) {
  const parsed = { apply: false, maxRows: 100_000 };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--apply") parsed.apply = true;
    else if (flag === "--help" || flag === "-h") parsed.help = true;
    else if (["--db", "--from", "--through", "--artifacts", "--max-rows"].includes(flag)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--db") parsed.dbPath = value;
      else if (flag === "--from") parsed.fromExclusive = value;
      else if (flag === "--through") parsed.throughInclusive = value;
      else if (flag === "--artifacts") parsed.artifactDir = value;
      else {
        parsed.maxRows = Number(value);
        if (!Number.isInteger(parsed.maxRows) || parsed.maxRows < 1) {
          throw new Error("--max-rows must be a positive integer");
        }
      }
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  return parsed;
}

async function main() {
  const args = parseRecoveryArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.dbPath || !args.fromExclusive || !args.throughInclusive) {
    throw new Error(`--db, --from, and --through are required\n\n${usage()}`);
  }

  const dbPath = path.resolve(args.dbPath);
  const artifactDir = path.resolve(
    args.artifactDir || path.join(path.dirname(dbPath), "call_logs")
  );
  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
    throw new Error(`SQLite database does not exist: ${dbPath}`);
  }

  const [{ tryOpenSync }, { recoverCallLogsFromArtifacts }] = await Promise.all([
    import("../../src/lib/db/adapters/driverFactory.ts"),
    import("../../src/lib/db/callLogRecovery.ts"),
  ]);
  const db = tryOpenSync(dbPath, {
    fileMustExist: true,
    readonly: !args.apply,
    timeout: 2_000,
  });
  if (!db) throw new Error("No synchronous SQLite driver is available");

  try {
    const result = recoverCallLogsFromArtifacts(db, {
      artifactDir,
      fromExclusive: args.fromExclusive,
      throughInclusive: args.throughInclusive,
      apply: args.apply,
      maxRows: args.maxRows,
    });
    console.log(JSON.stringify(result, null, 2));
    if (
      result.corrupt > 0 ||
      result.invalid > 0 ||
      result.checksumMismatches > 0 ||
      result.collisions > 0
    ) {
      process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[recover-call-logs] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
