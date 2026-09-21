#!/usr/bin/env node
/**
 * scripts/ops/optimize-pools.mjs
 *
 * Re-orders `pool-*` combo members from measured evidence, in this priority:
 *
 *   1. PERFORMANCE    — quality evidence, best source first:
 *                       external benchmark file  >  arena Elo  >  catalog proxy.
 *                       Multiplied by a smoothed reliability factor so a model
 *                       that fails most of the time cannot rank first on
 *                       benchmark strength alone.
 *   2. RESPONSE TIME  — measured p50 from usage_history, falling back to
 *                       external latency evidence. Members slower than the
 *                       pool's `firstContentTimeoutMs` budget are gated BELOW
 *                       every member that satisfies it ("good enough" gate).
 *   3. QUOTA          — remaining quota from quota_snapshots, last tiebreak.
 *
 * Members proven dead (never succeeded, and not merely rate-limited) are removed,
 * and members proven unreliable (a measured success rate under the usable floor)
 * are demoted below every unproven member.
 *
 * It also PLANS AND WRITES THE RESPONSE-TIME ENFORCEMENT for every pool:
 *
 *   firstContentTimeoutMs — bounds one member's stall after it answered 200
 *   comboTimeoutMs        — bounds the whole cascade across members
 *
 * The budget behind both is the measured p90 of the pool's proven members, so the
 * ranking gate and the runtime deadline rest on the same number. An explicit value
 * the operator already set is never overwritten — this fills in what is missing.
 *
 * Only leaf pools (those with real `providerId` members) have their member ORDER
 * rewritten. Tier-shell pools — the ones whose members are `combo-ref`s, e.g.
 * pool-sonnet -> pool-sonnet-antigravity/free/credits — keep their order and
 * `fallbackTier` chain, which carry routing semantics rather than ranking. Shells
 * still receive enforcement config, derived from the leaves they reference.
 *
 * Usage (host -> running container):
 *   docker exec -i omniroute-parallel node - < scripts/ops/optimize-pools.mjs
 *   docker exec -i omniroute-parallel node - -- --apply < scripts/ops/optimize-pools.mjs
 *
 * Env:
 *   DB_PATH           default /app/data/storage.sqlite
 *   WINDOW            days of usage_history to consider (default 7)
 *   BUDGET_MS         fallback budget when a pool has no evidence (default 15000)
 *   PERFORMANCE_FILE  external evidence file (default /app/data/model-performance.json)
 *
 * Without --apply it is a dry run and writes nothing. With --apply it always
 * writes a timestamped rollback backup before the first UPDATE.
 *
 * @see scripts/ops/pool-optimizer-core.mjs — the pure ranking + budget logic
 * @see scripts/ops/model-performance.sample.json — input format
 * @see docs/ops/POOL_OPTIMIZATION.md — rationale + how to gather evidence
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import {
  DEFAULT_BUDGET_MS,
  HARD_FAIL_STATUSES,
  bareLeaf,
  compare,
  deriveBudgetMs,
  enforcementFor,
  evaluate,
  lookupVariant,
} from "./pool-optimizer-core.mjs";

const DB_PATH = process.env.DB_PATH ?? "/app/data/storage.sqlite";
const WINDOW_DAYS = Number(process.env.WINDOW ?? 7);
const FALLBACK_BUDGET_MS = Number(process.env.BUDGET_MS ?? DEFAULT_BUDGET_MS);
const PERFORMANCE_FILE = process.env.PERFORMANCE_FILE ?? "/app/data/model-performance.json";
const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

// ── external evidence ────────────────────────────────────────────────────────

/**
 * Load the external performance file. Shape is validated leniently: a malformed
 * entry is skipped with a warning rather than aborting the run, because this file
 * is produced by an external agent and must never break pool maintenance.
 * Entries named `example-*` are ignored so the shipped sample is inert.
 */
function loadExternal() {
  const out = new Map();
  if (!fs.existsSync(PERFORMANCE_FILE)) {
    console.log(`external evidence: none (${PERFORMANCE_FILE} not found) — using DB signals only`);
    return out;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(PERFORMANCE_FILE, "utf8"));
  } catch (err) {
    console.log(`external evidence: UNREADABLE (${err.message}) — using DB signals only`);
    return out;
  }
  const models = Array.isArray(parsed?.models) ? parsed.models : [];
  let skipped = 0;
  for (const m of models) {
    const key = String(m?.model ?? "")
      .trim()
      .toLowerCase();
    if (!key || key.startsWith("example-")) {
      skipped += 1;
      continue;
    }
    const scores = m.scores && typeof m.scores === "object" ? m.scores : {};
    const numeric = Object.entries(scores).filter(([, v]) => Number.isFinite(Number(v)));
    const metrics = m.metrics && typeof m.metrics === "object" ? m.metrics : {};
    out.set(key, {
      scores: Object.fromEntries(numeric.map(([k, v]) => [k.toLowerCase(), Number(v)])),
      metrics,
      confidence: m.confidence ?? null,
      sources: Array.isArray(m.sources) ? m.sources : [],
    });
  }
  console.log(
    `external evidence: ${out.size} model(s) from ${PERFORMANCE_FILE}` +
      (skipped ? ` (${skipped} placeholder/skipped)` : "") +
      (parsed?.generatedAt ? ` generated ${parsed.generatedAt}` : "")
  );
  return out;
}

// ── DB signals ───────────────────────────────────────────────────────────────

const db = new Database(DB_PATH, { readonly: !APPLY, fileMustExist: true });
const windowClause = `datetime('now','-${WINDOW_DAYS} day')`;

function loadLatency() {
  const rows = db
    .prepare(
      `SELECT provider, model, latency_ms AS ms, success, status
       FROM usage_history WHERE timestamp >= ${windowClause}`
    )
    .all();
  const buckets = new Map();
  for (const r of rows) {
    const key = `${r.provider}\u0000${r.model}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { ms: [], ok: 0, n: 0, hard: 0, limited: 0 }));
    b.n += 1;
    if (Number.isFinite(r.ms)) b.ms.push(r.ms);
    if (r.success === 1) b.ok += 1;
    const st = Number(String(r.status).replace(/\.0$/, ""));
    if (HARD_FAIL_STATUSES.has(st)) b.hard += 1;
    if (st === 429) b.limited += 1;
  }
  const out = new Map();
  for (const [key, b] of buckets) {
    const sorted = [...b.ms].sort((a, z) => a - z);
    out.set(key, {
      n: b.n,
      ok: b.ok,
      successRate: b.n ? b.ok / b.n : 0,
      hardRate: b.n ? b.hard / b.n : 0,
      limitedRate: b.n ? b.limited / b.n : 0,
      p50: sorted.length ? sorted[Math.floor(0.5 * (sorted.length - 1))] : null,
      p90: sorted.length ? sorted[Math.floor(0.9 * (sorted.length - 1))] : null,
    });
  }
  return out;
}

function loadElo() {
  const out = new Map();
  for (const r of db
    .prepare("SELECT model, MAX(elo_raw) AS elo FROM model_intelligence GROUP BY model")
    .all()) {
    if (Number.isFinite(r.elo)) out.set(String(r.model).toLowerCase(), r.elo);
  }
  return out;
}

function loadCapability() {
  const out = new Map();
  for (const r of db
    .prepare(
      "SELECT provider, model_id, tool_call, reasoning, limit_context FROM model_capabilities"
    )
    .all()) {
    out.set(`${r.provider}\u0000${String(r.model_id).toLowerCase()}`, {
      reasoning: r.reasoning === 1,
      tool: r.tool_call === 1,
      ctx: Number(r.limit_context) || 0,
    });
  }
  return out;
}

function loadQuota() {
  const out = new Map();
  for (const r of db
    .prepare(
      `SELECT provider, remaining_percentage AS pct, is_exhausted AS ex
       FROM quota_snapshots q
       WHERE created_at >= ${windowClause}
         AND created_at = (SELECT MAX(created_at) FROM quota_snapshots WHERE provider = q.provider)`
    )
    .all()) {
    out.set(r.provider, { pct: Number(r.pct), exhausted: r.ex === 1 });
  }
  return out;
}

const external = loadExternal();
const latency = loadLatency();
const elo = loadElo();
const capability = loadCapability();
const quota = loadQuota();

/** Lookups the pure core needs, bound to the loaded maps. */
const deps = {
  lookupLatency: (provider, model) => lookupVariant(latency, provider, model),
  lookupExternal: (model) => {
    const leaf = bareLeaf(model);
    if (external.has(leaf)) return external.get(leaf);
    for (const [k, v] of external) {
      if (k === leaf || k.endsWith(`/${leaf}`) || leaf.endsWith(`/${k}`)) return v;
    }
    return null;
  },
  lookupElo: (model) => {
    const leaf = bareLeaf(model);
    if (elo.has(leaf)) return elo.get(leaf);
    for (const [k, v] of elo) {
      if (k === leaf || k === `${leaf}-max` || k === `${leaf}-high`) return v;
    }
    return null;
  },
  lookupCapability: (provider, model) => {
    const leaf = bareLeaf(model);
    if (capability.has(`${provider}\u0000${leaf}`))
      return capability.get(`${provider}\u0000${leaf}`);
    for (const [k, v] of capability) {
      if (k.endsWith(`\u0000${leaf}`)) return v;
    }
    return null;
  },
  lookupQuota: (provider) => quota.get(provider) ?? null,
};

// ── pool structure ───────────────────────────────────────────────────────────

const poolRows = db
  .prepare("SELECT name, data FROM combos WHERE name LIKE 'pool-%'")
  .all()
  .map((r) => ({ name: r.name, combo: JSON.parse(r.data) }));
const byName = new Map(poolRows.map((r) => [r.name, r.combo]));

const realMembersOf = (combo) => (combo.models ?? []).filter((m) => m.providerId && m.model);
const refNamesOf = (combo) =>
  (combo.models ?? []).filter((m) => m.kind === "combo-ref" && m.comboName).map((m) => m.comboName);

/**
 * Members whose measured evidence informs a pool's budget. A leaf answers for
 * itself; a tier shell borrows from the leaves it references.
 */
function evidenceMembers(name, combo, seen = new Set()) {
  const real = realMembersOf(combo);
  if (real.length) return real;
  if (seen.has(name)) return [];
  seen.add(name);
  const out = [];
  for (const ref of refNamesOf(combo)) {
    const target = byName.get(ref);
    if (target) out.push(...realMembersOf(target));
  }
  return out;
}

/**
 * The pool's response-time budget: an explicit `firstContentTimeoutMs` when the
 * operator set one, otherwise the measured p90 of the pool's proven members.
 */
function budgetFor(name, combo) {
  const explicit = Number(combo.config?.firstContentTimeoutMs) || 0;
  if (explicit > 0) return { budgetMs: explicit, source: "config" };

  const entries = evidenceMembers(name, combo).map((m) =>
    evaluate(m, Number.POSITIVE_INFINITY, deps)
  );
  const measured = entries.some((e) => e.enough && Number.isFinite(e.lat?.p90) && e.lat.p90 > 0);
  return {
    budgetMs: deriveBudgetMs(entries, { fallbackMs: FALLBACK_BUDGET_MS }),
    source: measured ? "measured" : "fallback",
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

const report = [];
const changes = [];

for (const { name, combo } of poolRows) {
  const realMembers = realMembersOf(combo);
  // Leaf pools only — tier shells carry routing semantics, not ranking.
  if (realMembers.length < 2) continue;

  const { budgetMs, source } = budgetFor(name, combo);
  const evaluated = realMembers.map((m) => evaluate(m, budgetMs, deps));
  const refMembers = (combo.models ?? []).filter((m) => !(m.providerId && m.model));

  const dead = evaluated.filter((e) => e.dead);
  const ordered = evaluated.filter((e) => !e.dead).sort(compare);

  const changed =
    dead.length > 0 ||
    realMembers.map((m) => m.model).join("|") !== ordered.map((e) => e.model).join("|");

  report.push({
    pool: name,
    budgetMs,
    budgetSource: source,
    total: realMembers.length,
    dead,
    ordered,
    changed,
  });
  if (changed) changes.push({ name, combo, refMembers, ordered, dead });
}

const enforcements = [];
for (const { name, combo } of poolRows) {
  const { budgetMs, source } = budgetFor(name, combo);
  const patch = enforcementFor(budgetMs, combo.config ?? {});
  if (Object.keys(patch).length) enforcements.push({ name, combo, budgetMs, source, patch });
}

// ── output ───────────────────────────────────────────────────────────────────

for (const r of report) {
  if (!r.changed && !VERBOSE) continue;
  console.log(`\n${"═".repeat(104)}`);
  console.log(`${r.pool}   (budget ${r.budgetMs}ms ${r.budgetSource} · ${r.total} members)`);
  console.log("═".repeat(104));

  if (r.dead.length) {
    console.log(`  REMOVE ${r.dead.length} dead target(s):`);
    for (const d of r.dead) {
      console.log(
        `     ${d.model}  n=${d.lat.n} hard=${(d.lat.hardRate * 100).toFixed(0)}% limited=${(
          d.lat.limitedRate * 100
        ).toFixed(0)}%`
      );
    }
  }

  const over = r.ordered.filter((e) => e.overBudget);
  if (over.length) {
    console.log(`  GATE ${over.length} over-budget member(s) below the ${r.budgetMs}ms budget:`);
    for (const o of over) console.log(`     ${Math.round(o.p50)}ms (${o.rt.source})  ${o.model}`);
  }

  const bad = r.ordered.filter((e) => e.unreliable);
  if (bad.length) {
    console.log(`  DEMOTE ${bad.length} proven-unreliable member(s) below the unproven:`);
    for (const o of bad) {
      console.log(`     ${(o.reliability * 100).toFixed(0)}% over n=${o.lat.n}  ${o.model}`);
    }
  }

  console.log("  ORDER:");
  r.ordered.forEach((e, i) => {
    const q = `${e.quality.score.toFixed(2)}/${e.quality.basis}`;
    const rel = e.lat && e.lat.n ? `${Math.round((e.lat.ok / e.lat.n) * 100)}%` : "n/a";
    const latStr = e.p50 == null ? "    n/a" : `${String(Math.round(e.p50)).padStart(6)}ms`;
    const flag = e.overBudget ? "  ⚠ OVER" : e.unreliable ? "  ⚠ UNRELIABLE" : "";
    console.log(
      `   ${String(i + 1).padStart(2)}. perf=${e.performance.toFixed(3)}  q=${q.padEnd(18)} rel=${rel.padStart(4)} ${latStr}/${String(
        e.rt.source
      ).padEnd(8)} n=${String(e.lat?.n ?? 0).padStart(4)}  ${e.model}${flag}`
    );
  });
}

console.log(`\n${"═".repeat(104)}`);
console.log("ENFORCEMENT (pools still missing a deadline):");
if (!enforcements.length) {
  console.log("  every pool already has firstContentTimeoutMs and comboTimeoutMs set");
} else {
  for (const e of enforcements) {
    const parts = [];
    if (e.patch.firstContentTimeoutMs != null) {
      parts.push(`firstContent=${e.patch.firstContentTimeoutMs}ms`);
    }
    if (e.patch.comboTimeoutMs != null) parts.push(`combo=${e.patch.comboTimeoutMs}ms`);
    console.log(
      `  ${e.name.padEnd(28)} budget=${String(e.budgetMs).padStart(6)}ms ${e.source.padEnd(9)} → ${parts.join(" ")}`
    );
  }
}

console.log(`\n${"═".repeat(104)}`);
console.log(
  `pools evaluated: ${report.length}   needing change: ${changes.length}   needing enforcement: ${enforcements.length}   apply: ${APPLY}`
);
console.log("═".repeat(104));

const affected = [...new Set([...changes.map((c) => c.name), ...enforcements.map((e) => e.name)])];

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to write. Nothing changed.");
  process.exit(0);
}
if (!affected.length) {
  console.log("\nNothing to apply.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = `${DB_PATH.replace(/[^/]+$/, "")}db_backups`;
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = `${backupDir}/pool-optimize-${stamp}.json`;
const backup = {};
for (const name of affected) {
  const cur = db.prepare("SELECT name, data, updated_at FROM combos WHERE name = ?").get(name);
  if (cur) backup[name] = cur;
}
fs.writeFileSync(backupPath, JSON.stringify({ takenAt: stamp, combos: backup }, null, 2));
console.log(`\nrollback backup: ${backupPath}`);

const changeByName = new Map(changes.map((c) => [c.name, c]));
const enforceByName = new Map(enforcements.map((e) => [e.name, e]));
let written = 0;

for (const name of affected) {
  const cur = db.prepare("SELECT data FROM combos WHERE name = ?").get(name);
  if (!cur) continue;
  const combo = JSON.parse(cur.data);
  const change = changeByName.get(name);
  const enforcement = enforceByName.get(name);

  const next = { ...combo };
  if (change) next.models = [...change.ordered.map((e) => e.member), ...change.refMembers];
  if (enforcement) next.config = { ...(combo.config ?? {}), ...enforcement.patch };
  next.updatedAt = new Date().toISOString();
  next.version = (combo.version ?? 1) + 1;

  const notes = [`[pool-optimize ${stamp}]`];
  if (change) {
    notes.push(
      `order: performance>response-time>quota; removed ${change.dead.length} dead, gated ${
        change.ordered.filter((e) => e.overBudget).length
      } over-budget, demoted ${change.ordered.filter((e) => e.unreliable).length} unreliable`
    );
  }
  if (enforcement) {
    notes.push(
      `enforcement: budget ${enforcement.budgetMs}ms (${enforcement.source}) → ${JSON.stringify(
        enforcement.patch
      )}`
    );
  }
  next.repairNote = notes.join(" · ");

  db.prepare("UPDATE combos SET data = ?, updated_at = ? WHERE name = ?").run(
    JSON.stringify(next),
    next.updatedAt,
    name
  );
  written += 1;
  const bits = [];
  if (change) bits.push(`${next.models.length} members`);
  if (enforcement) bits.push(JSON.stringify(enforcement.patch));
  console.log(`  wrote ${name}: ${bits.join(" + ")} (v${next.version})`);
}
console.log(`\napplied to ${written} pool(s).`);
