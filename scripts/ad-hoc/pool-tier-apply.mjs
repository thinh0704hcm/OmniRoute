#!/usr/bin/env node
/**
 * scripts/ad-hoc/pool-tier-apply.mjs — one-time pool tier placement.
 *
 * On-demand, single-purpose, manual invocation ONLY. Nothing in the codebase
 * calls this: no require/import, no job registration, no interval, no cron.
 * It never runs unless a human copies it into the container and runs it.
 *
 * What it does (idempotent — safe to re-run):
 *   1. pool-opus / pool-fable: drop the `free` combo-ref step, promote
 *      `antigravity` to defaultTier, re-link fallback chain
 *      (antigravity -> codex -> credits -> reserve).
 *   2. pool-opus-credits / pool-fable-credits: already hold exactly the
 *      -max contributor row — verified unchanged, no write.
 *   3. pool-opus-codex: already holds codex/gpt-5.6-luna-max — verified
 *      unchanged, no write.
 *   4. pool-fable-codex: left untouched per operator order.
 *   Leaf combos (pool-*-free) are KEPT for instant rollback.
 *
 * Usage:
 *   1. Back up first (script refuses to run without a fresh backup stamp):
 *      docker exec omniroute-parallel node /app/data/pool-optimizer/pool-tier-apply.mjs --backup-only
 *   2. Dry run (default, writes nothing):
 *      docker exec omniroute-parallel node /app/data/pool-optimizer/pool-tier-apply.mjs
 *   3. Apply (requires explicit flag + fresh backup):
 *      docker exec omniroute-parallel node /app/data/pool-optimizer/pool-tier-apply.mjs --apply
 *
 * Rollback: re-apply the pre-change backup JSON written to
 * /app/data/db_backups/pool-tier-apply-<stamp>-pre.json via --restore <file>.
 */
import Database from "better-sqlite3";
import fs from "node:fs";

const DB_PATH = process.env.DB_PATH ?? "/app/data/storage.sqlite";
const BACKUP_DIR = "/app/data/db_backups";
const APPLY = process.argv.includes("--apply");
const BACKUP_ONLY = process.argv.includes("--backup-only");
const RESTORE_FILE = (() => {
  const i = process.argv.indexOf("--restore");
  return i !== -1 ? process.argv[i + 1] : null;
})();

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const PARENT_NAMES = ["pool-opus", "pool-fable"];

function load(db, name) {
  const row = db.prepare("SELECT id, data, updated_at FROM combos WHERE name = ?").get(name);
  if (!row) throw new Error(`combo missing: ${name}`);
  return { id: row.id, updatedAt: row.updated_at, combo: JSON.parse(row.data) };
}

function writeBackup(db, names) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const path = `${BACKUP_DIR}/pool-tier-apply-${stamp}-pre.json`;
  const combos = {};
  for (const name of names) {
    const row = db
      .prepare("SELECT name, data, updated_at FROM combos WHERE name = ?")
      .get(name);
    if (row) combos[name] = { name: row.name, data: row.data, updated_at: row.updated_at };
  }
  fs.writeFileSync(path, JSON.stringify({ takenAt: stamp, combos }, null, 2));
  return path;
}

function planParentEdit(name, combo) {
  const models = Array.isArray(combo.models) ? combo.models : [];
  const freeStep = models.find((m) => m?.kind === "combo-ref" && /-free$/.test(m?.comboName || ""));
  if (!freeStep) return { changed: false, reason: "no free combo-ref step" };
  const nextModels = models.filter((m) => m !== freeStep);
  const tiers = combo?.config?.compositeTiers?.tiers;
  if (!tiers || typeof tiers !== "object") {
    return { changed: false, reason: "no compositeTiers config" };
  }
  // Find the tier entry whose stepId is the free step, and the tier that falls back TO free.
  let freeTierName = null;
  let prevTierName = null;
  for (const [tierName, tier] of Object.entries(tiers)) {
    if (tier?.stepId === freeStep.id) freeTierName = tierName;
    if (tier?.fallbackTier === freeTierName || (freeTierName === null && false)) {
      // resolved after freeTierName known; handled below
    }
  }
  for (const [tierName, tier] of Object.entries(tiers)) {
    if (tier?.fallbackTier === freeTierName) prevTierName = tierName;
  }
  if (!freeTierName) return { changed: false, reason: "free step not referenced by any tier" };
  const nextTiers = {};
  for (const [tierName, tier] of Object.entries(tiers)) {
    if (tierName === freeTierName) continue;
    nextTiers[tierName] = { ...tier };
  }
  // Re-link: whatever fell back to free now falls back to free's own fallback (antigravity).
  const freeFallback = tiers[freeTierName]?.fallbackTier || null;
  if (prevTierName && freeFallback) nextTiers[prevTierName] = { ...nextTiers[prevTierName], fallbackTier: freeFallback };
  const nextConfig = {
    ...combo.config,
    compositeTiers: {
      ...combo.config.compositeTiers,
      defaultTier:
        combo.config.compositeTiers.defaultTier === freeTierName
          ? freeFallback || combo.config.compositeTiers.defaultTier
          : combo.config.compositeTiers.defaultTier,
      tiers: nextTiers,
    },
  };
  const nextCombo = {
    ...combo,
    models: nextModels,
    config: nextConfig,
    updatedAt: new Date().toISOString(),
    version: (combo.version ?? 1) + 1,
    repairNote: `[pool-tier-apply ${stamp}] drop free tier step (${freeStep.comboName}); defaultTier -> ${nextConfig.compositeTiers.defaultTier}. Leaf pool-*-free kept for rollback.`,
  };
  return { changed: true, freeStep, freeTierName, nextCombo };
}

function verifyLeafExpectations(db) {
  const checks = [
    {
      name: "pool-opus-credits",
      expect: ["command-code/meta/muse-spark-1.3-contributor-max"],
    },
    {
      name: "pool-fable-credits",
      expect: ["command-code/meta/muse-spark-1.3-contributor-max"],
    },
    { name: "pool-opus-codex", expect: ["codex/gpt-5.6-luna-max"] },
    { name: "pool-fable-codex", expect: ["codex/gpt-6-astra-max"] },
  ];
  const results = [];
  for (const { name, expect } of checks) {
    const { combo } = load(db, name);
    const got = (combo.models || []).map((m) => m.model || m.comboName);
    const ok = JSON.stringify(got) === JSON.stringify(expect);
    results.push({ name, ok, got, expect });
  }
  return results;
}

const db = new Database(RESTORE_FILE ? DB_PATH : DB_PATH, {
  readonly: !APPLY && !RESTORE_FILE,
  fileMustExist: true,
});

if (RESTORE_FILE) {
  const backup = JSON.parse(fs.readFileSync(RESTORE_FILE, "utf8"));
  const tx = db.transaction(() => {
    for (const [name, row] of Object.entries(backup.combos || {})) {
      const cur = db.prepare("SELECT id FROM combos WHERE name = ?").get(name);
      if (!cur) continue;
      const parsed = JSON.parse(row.data);
      parsed.updatedAt = new Date().toISOString();
      db.prepare("UPDATE combos SET data = ?, updated_at = ? WHERE name = ?").run(
        JSON.stringify(parsed),
        parsed.updatedAt,
        name
      );
      console.log(`  restored ${name} (updated_at ${row.updated_at})`);
    }
  });
  tx();
  console.log(`RESTORED ${Object.keys(backup.combos || {}).length} combos from ${RESTORE_FILE}`);
  db.close();
  process.exit(0);
}

if (BACKUP_ONLY) {
  const path = writeBackup(db, [
    ...PARENT_NAMES,
    "pool-opus-free",
    "pool-fable-free",
    "pool-opus-credits",
    "pool-fable-credits",
    "pool-opus-codex",
    "pool-fable-codex",
  ]);
  console.log(`backup: ${path}`);
  db.close();
  process.exit(0);
}

console.log("== leaf verification (no writes) ==");
let leavesOk = true;
for (const r of verifyLeafExpectations(db)) {
  console.log(`  ${r.ok ? "OK  " : "DIFF"} ${r.name}: got ${JSON.stringify(r.got)}`);
  if (!r.ok) leavesOk = false;
}
if (!leavesOk) {
  console.error("Leaf state differs from expected — refusing to touch parents. Inspect first.");
  db.close();
  process.exit(1);
}

console.log("== parent plan (dry run) ==");
const plans = [];
for (const name of PARENT_NAMES) {
  const { combo } = load(db, name);
  const plan = planParentEdit(name, combo);
  plans.push({ name, combo, plan });
  if (!plan.changed) {
    console.log(`  ${name}: no change (${plan.reason})`);
  } else {
    console.log(`  ${name}: drop step ${plan.freeStep.id} (${plan.freeStep.comboName}), tier '${plan.freeTierName}' removed`);
    console.log(`    members: ${(combo.models || []).map((m) => m.comboName || m.model).join(" | ")}`);
    console.log(`    ->       ${plan.nextCombo.models.map((m) => m.comboName || m.model).join(" | ")}`);
    console.log(`    defaultTier: ${combo.config.compositeTiers.defaultTier} -> ${plan.nextCombo.config.compositeTiers.defaultTier}`);
  }
}

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to write. Nothing changed.");
  db.close();
  process.exit(0);
}

const backupPath = writeBackup(db, [
  ...PARENT_NAMES,
  "pool-opus-free",
  "pool-fable-free",
  "pool-opus-credits",
  "pool-fable-credits",
  "pool-opus-codex",
  "pool-fable-codex",
]);
console.log(`\nrollback backup: ${backupPath}`);

const tx = db.transaction(() => {
  for (const { name, plan } of plans) {
    if (!plan.changed) continue;
    const cur = db.prepare("SELECT data FROM combos WHERE name = ?").get(name);
    const live = JSON.parse(cur.data);
    // Guard: parent must not have changed since we planned (same guard shape as optimize-pools' intent).
    if (JSON.stringify(live.models) !== JSON.stringify(plans.find((p) => p.name === name).combo.models)) {
      throw new Error(`${name} changed under us — aborting, no writes applied`);
    }
    db.prepare("UPDATE combos SET data = ?, updated_at = ? WHERE name = ?").run(
      JSON.stringify(plan.nextCombo),
      plan.nextCombo.updatedAt,
      name
    );
    console.log(`  wrote ${name}: dropped ${plan.freeStep.comboName} (v${plan.nextCombo.version})`);
  }
});
tx();
console.log("applied. Leaves kept for rollback; restore with --restore <backup>.");
db.close();
