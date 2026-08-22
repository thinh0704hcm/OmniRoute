#!/usr/bin/env node
/**
 * Reconcile the operator database with the canonical economic/performance combo hierarchy.
 *
 * Usage:
 *   node scripts/ops/reconcile-canonical-combos.mjs [--db PATH]
 *   node scripts/ops/reconcile-canonical-combos.mjs --check [--db PATH]
 *   node scripts/ops/reconcile-canonical-combos.mjs --apply [--adopt] [--db PATH]
 *
 * The default is a read-only dry-run. First use against pre-existing unowned names requires
 * `--apply --adopt`; later applies refuse to overwrite rows without the ownership marker.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  inspectCanonicalComboDatabase,
  reconcileCanonicalComboDatabase,
} from "../../src/lib/db/canonicalEconomicCombos.ts";

function parseArgs(argv) {
  const args = { apply: false, adopt: false, check: false, json: false, dbPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") args.apply = true;
    else if (flag === "--adopt") args.adopt = true;
    else if (flag === "--check") args.check = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--db") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--db requires a path");
      args.dbPath = value;
    } else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (args.apply && args.check) throw new Error("--apply and --check are mutually exclusive");
  if (args.adopt && !args.apply) throw new Error("--adopt requires --apply");
  return args;
}

function defaultDbPath() {
  const legacyDataDir = path.join(os.homedir(), ".omniroute");
  const defaultDataDir = fs.existsSync(legacyDataDir)
    ? legacyDataDir
    : process.env.XDG_CONFIG_HOME
      ? path.resolve(process.env.XDG_CONFIG_HOME, "omniroute")
      : legacyDataDir;
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : defaultDataDir;
  return path.join(dataDir, "storage.sqlite");
}

function usage() {
  return [
    "Usage:",
    "  reconcile-canonical-combos.mjs [--db PATH]                 # dry-run",
    "  reconcile-canonical-combos.mjs --check [--db PATH]         # drift gate",
    "  reconcile-canonical-combos.mjs --apply [--adopt] [--db PATH]",
    "",
    "Options:",
    "  --adopt  allow the first apply to take ownership of exact managed names",
    "  --json   emit machine-readable output",
  ].join("\n");
}

function summarize(dbPath, plan, extra = {}) {
  return {
    dbPath,
    manager: plan.manager,
    version: plan.version,
    drift: plan.drift,
    operations: plan.operations.map(({ action, name }) => ({ action, name })),
    conflicts: plan.conflicts,
    ...extra,
  };
}

function printResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log(`Database: ${result.dbPath}`);
  console.log(`Drift: ${result.drift ? "yes" : "no"}`);
  for (const operation of result.operations) {
    console.log(`  ${operation.action.padEnd(6)} ${operation.name}`);
  }
  for (const conflict of result.conflicts) {
    console.log(`  refuse ${conflict.name} (${conflict.action}; ${conflict.reason})`);
  }
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
  if (result.applied) console.log(`Applied: ${result.applied} operation(s)`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  const dbPath = path.resolve(args.dbPath || defaultDbPath());
  if (!args.apply) {
    const { plan } = inspectCanonicalComboDatabase({ dbPath });
    const result = summarize(dbPath, plan, { mode: args.check ? "check" : "dry-run" });
    printResult(result, args.json);
    if (args.check && plan.drift) process.exitCode = plan.conflicts.length > 0 ? 2 : 1;
  } else {
    const applied = await reconcileCanonicalComboDatabase({ dbPath, adopt: args.adopt });
    const result = summarize(dbPath, applied.plan, {
      mode: "apply",
      applied: applied.applied,
      backupPath: applied.backupPath,
    });
    printResult(result, args.json);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Canonical combo reconciliation failed: ${message}`);
  process.exitCode = 2;
}
