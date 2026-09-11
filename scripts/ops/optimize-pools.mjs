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
 * Members proven dead (never succeeded, and not merely rate-limited) are removed.
 *
 * Only leaf pools (those with real `providerId` members) are touched. Tier-shell
 * pools — the ones whose members are `combo-ref`s, e.g. pool-sonnet ->
 * pool-sonnet-antigravity/free/credits — are deliberately left alone: their order
 * and `fallbackTier` chain carry routing semantics, not ranking.
 *
 * Usage (host -> running container):
 *   docker exec -i omniroute-parallel node - < scripts/ops/optimize-pools.mjs
 *   docker exec -i omniroute-parallel node - -- --apply < scripts/ops/optimize-pools.mjs
 *
 * Env:
 *   DB_PATH           default /app/data/storage.sqlite
 *   WINDOW            days of usage_history to consider (default 7)
 *   BUDGET_MS         fallback usable-response budget (default 15000)
 *   PERFORMANCE_FILE  external evidence file (default /app/data/model-performance.json)
 *
 * Without --apply it is a dry run and writes nothing. With --apply it always
 * writes a timestamped rollback backup before the first UPDATE.
 *
 * @see scripts/ops/model-performance.sample.json — input format
 * @see docs/ops/POOL_OPTIMIZATION.md — rationale + how to gather evidence
 */

import Database from "better-sqlite3";
import fs from "node:fs";

const DB_PATH = process.env.DB_PATH ?? "/app/data/storage.sqlite";
const WINDOW_DAYS = Number(process.env.WINDOW ?? 7);
const DEFAULT_BUDGET_MS = Number(process.env.BUDGET_MS ?? 15_000);
const PERFORMANCE_FILE = process.env.PERFORMANCE_FILE ?? "/app/data/model-performance.json";
const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

// ── tunables ─────────────────────────────────────────────────────────────────

/** Minimum observed requests before a latency/reliability judgement is trusted. */
const MIN_SAMPLES = 5;

/** Beta prior for the reliability factor: (ok + 4) / (n + 5) → prior 0.8. */
const RELIABILITY_PRIOR_OK = 4;
const RELIABILITY_PRIOR_N = 5;

/** Reliability assumed for a member we have never observed. */
const COLD_RELIABILITY = 0.6;

/** A member is "over budget" once its p50 passes the pool budget. */
const OVER_BUDGET_RATIO = 1.0;

/** Arena Elo band used to normalize into 0..1 (covers current top models). */
const ELO_FLOOR = 1450;
const ELO_CEIL = 1650;

/** A member with zero successes and at least this much hard-failure traffic is dead. */
const DEAD_HARD_FAIL_RATE = 0.5;

/** Statuses that are hard failures (as opposed to 429/5xx which may be transient). */
const HARD_FAIL_STATUSES = new Set([400, 401, 402, 403, 404, 410, 422]);

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

// ── member resolution ────────────────────────────────────────────────────────

/** Bare model leaf: strip provider segments and :free/-free suffixes. */
function bareLeaf(model) {
  return String(model)
    .split("/")
    .pop()
    .toLowerCase()
    .replace(/:free$/, "")
    .replace(/-free$/, "");
}

function lookupLatency(provider, model) {
  const leaf = bareLeaf(model);
  const key = `${provider}\u0000${leaf}`;
  if (latency.has(key)) return latency.get(key);
  for (const [k, hit] of latency) {
    const [p, m] = k.split("\u0000");
    if (p === provider && (m === leaf || bareLeaf(m) === leaf)) return hit;
  }
  return null;
}

function lookupExternal(model) {
  const leaf = bareLeaf(model);
  if (external.has(leaf)) return external.get(leaf);
  for (const [k, v] of external) {
    if (k === leaf || k.endsWith(`/${leaf}`) || leaf.endsWith(`/${k}`)) return v;
  }
  return null;
}

function lookupElo(model) {
  const leaf = bareLeaf(model);
  if (elo.has(leaf)) return elo.get(leaf);
  for (const [k, v] of elo) {
    if (k === leaf || k === `${leaf}-max` || k === `${leaf}-high`) return v;
  }
  return null;
}

function lookupCapability(provider, model) {
  const leaf = bareLeaf(model);
  if (capability.has(`${provider}\u0000${leaf}`)) return capability.get(`${provider}\u0000${leaf}`);
  for (const [k, v] of capability) {
    if (k.endsWith(`\u0000${leaf}`)) return v;
  }
  return null;
}

// ── scoring ──────────────────────────────────────────────────────────────────

/**
 * Quality evidence in 0..1, with the source reported so a reviewer can see how
 * much of the order rests on hard evidence versus an estimate.
 *
 * The catalog proxy is deliberately capped below 1.0: it exists so an
 * unmeasured member still gets a sane relative position, and it must never
 * outrank a member we have actually measured.
 */
function qualityOf(provider, model) {
  const ext = lookupExternal(model);
  if (ext && Object.keys(ext.scores).length) {
    const s = ext.scores;
    const value =
      s.default ??
      s.coding ??
      s.agentic ??
      s.reasoning ??
      Object.values(s).reduce((a, b) => a + b, 0) / Object.values(s).length;
    return {
      score: clamp01(value),
      basis: "evidence",
      detail: ext.sources.join("+") || "external",
    };
  }

  const arena = lookupElo(model);
  if (arena != null) {
    return {
      score: clamp01((arena - ELO_FLOOR) / (ELO_CEIL - ELO_FLOOR)),
      basis: "arena",
      detail: `elo ${arena}`,
    };
  }

  const cap = lookupCapability(provider, model);
  if (cap) {
    // 0.25 .. 0.70 — narrow, honest, and never competitive with measured data.
    const ctxScore = clamp01(Math.log10(Math.max(cap.ctx, 1) / 8_000) / 1.5);
    const score = 0.25 + 0.2 * (cap.tool ? 1 : 0) + 0.1 * (cap.reasoning ? 1 : 0) + 0.15 * ctxScore;
    return {
      score: clamp01(Math.min(score, 0.7)),
      basis: "estimate",
      detail: `tool=${cap.tool} reason=${cap.reasoning} ctx=${cap.ctx}`,
    };
  }

  return { score: 0.4, basis: "unknown", detail: "no evidence" };
}

/** Smoothed success rate so a small sample cannot dominate. */
function reliabilityOf(lat) {
  if (!lat || lat.n === 0) return COLD_RELIABILITY;
  return clamp01((lat.ok + RELIABILITY_PRIOR_OK) / (lat.n + RELIABILITY_PRIOR_N));
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

/** Response time in ms: measured p50, else external latency, else null. */
function responseTimeOf(lat, ext) {
  if (lat?.p50 != null) return { ms: lat.p50, source: "measured" };
  const m = ext?.metrics ?? {};
  const extMs = Number(m.latencyMs ?? m.ttftMs);
  if (Number.isFinite(extMs) && extMs > 0) return { ms: extMs, source: "external" };
  return { ms: null, source: "none" };
}

function evaluate(member, budgetMs) {
  const provider = member.providerId;
  const model = member.model;
  const lat = lookupLatency(provider, model);
  const ext = lookupExternal(model);
  const quality = qualityOf(provider, model);
  const reliability = reliabilityOf(lat);
  const rt = responseTimeOf(lat, ext);

  const enough = Boolean(lat && lat.n >= MIN_SAMPLES);
  // Dead = never succeeded, dominated by hard failures rather than rate limits.
  const dead = Boolean(
    enough && lat.ok === 0 && lat.hardRate >= DEAD_HARD_FAIL_RATE && lat.limitedRate < 0.5
  );
  // Gate on response time wherever it comes from. Our own p50 is authoritative,
  // but external evidence still disqualifies a member we have never called —
  // a third party measuring 39s against a 15s budget is decisive enough that
  // leaving it in the unknown bucket would overstate its usability.
  const overBudget = Boolean(rt.ms != null && rt.ms > budgetMs * OVER_BUDGET_RATIO);

  return {
    member,
    provider,
    model,
    quality,
    reliability,
    performance: quality.score * reliability,
    lat,
    ext,
    rt,
    enough,
    dead,
    overBudget,
    quota: quota.get(provider) ?? null,
    p50: rt.ms,
  };
}

/**
 * Ordering key, ascending.
 *
 *   gate 0: enough evidence and inside the response-time budget
 *   gate 1: no evidence yet — unproven, so below the proven-good
 *   gate 2: proven too slow — below the unknowns, above nothing (dead are removed)
 *
 * Then performance desc, response time asc, reliability desc, quota desc.
 */
function sortKey(e) {
  const gate = e.dead ? 3 : e.overBudget ? 2 : e.enough ? 0 : 1;
  return [
    gate,
    -Math.round(e.performance * 100), // 0..100, coarsens float noise
    e.p50 ?? Number.POSITIVE_INFINITY,
    -Math.round(e.reliability * 100),
    e.quota ? -e.quota.pct : 0,
  ];
}

function compare(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return a.model.localeCompare(b.model);
}

// ── main ─────────────────────────────────────────────────────────────────────

const poolRows = db
  .prepare("SELECT name, data FROM combos WHERE name LIKE 'pool-%' AND data LIKE '%providerId%'")
  .all();

const report = [];
const changes = [];

for (const row of poolRows) {
  const combo = JSON.parse(row.data);
  const models = combo.models ?? [];
  const realMembers = models.filter((m) => m.providerId && m.model);
  // Leaf pools only — tier shells carry routing semantics, not ranking.
  if (realMembers.length < 2) continue;

  const budgetMs = Number(combo.config?.firstContentTimeoutMs) || DEFAULT_BUDGET_MS;
  const evaluated = realMembers.map((m) => evaluate(m, budgetMs));
  const refMembers = models.filter((m) => !(m.providerId && m.model));

  const dead = evaluated.filter((e) => e.dead);
  const ordered = evaluated.filter((e) => !e.dead).sort(compare);

  const changed =
    dead.length > 0 ||
    realMembers.map((m) => m.model).join("|") !== ordered.map((e) => e.model).join("|");

  report.push({ pool: row.name, budgetMs, total: realMembers.length, dead, ordered, changed });
  if (changed) changes.push({ name: row.name, combo, refMembers, ordered, dead });
}

// ── output ───────────────────────────────────────────────────────────────────

for (const r of report) {
  if (!r.changed && !VERBOSE) continue;
  console.log(`\n${"═".repeat(104)}`);
  console.log(`${r.pool}   (budget ${r.budgetMs}ms · ${r.total} members)`);
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

  console.log("  ORDER:");
  r.ordered.forEach((e, i) => {
    const q = `${e.quality.score.toFixed(2)}/${e.quality.basis}`;
    const rel = e.lat && e.lat.n ? `${Math.round((e.lat.ok / e.lat.n) * 100)}%` : "n/a";
    const latStr = e.p50 == null ? "    n/a" : `${String(Math.round(e.p50)).padStart(6)}ms`;
    const flag = e.overBudget ? "  ⚠ OVER" : "";
    console.log(
      `   ${String(i + 1).padStart(2)}. perf=${e.performance.toFixed(3)}  q=${q.padEnd(18)} rel=${rel.padStart(4)} ${latStr}/${String(
        e.rt.source
      ).padEnd(8)} n=${String(e.lat?.n ?? 0).padStart(4)}  ${e.model}${flag}`
    );
  });
}

console.log(`\n${"═".repeat(104)}`);
console.log(
  `pools evaluated: ${report.length}   needing change: ${changes.length}   apply: ${APPLY}`
);
console.log("═".repeat(104));

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to write. Nothing changed.");
  process.exit(0);
}
if (!changes.length) {
  console.log("\nNothing to apply.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = `${DB_PATH.replace(/[^/]+$/, "")}db_backups`;
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = `${backupDir}/pool-optimize-${stamp}.json`;
const backup = {};
for (const c of changes) {
  const cur = db.prepare("SELECT name, data, updated_at FROM combos WHERE name = ?").get(c.name);
  if (cur) backup[c.name] = cur;
}
fs.writeFileSync(backupPath, JSON.stringify({ takenAt: stamp, combos: backup }, null, 2));
console.log(`\nrollback backup: ${backupPath}`);

let written = 0;
for (const c of changes) {
  const next = {
    ...c.combo,
    models: [...c.ordered.map((e) => e.member), ...c.refMembers],
    updatedAt: new Date().toISOString(),
    version: (c.combo.version ?? 1) + 1,
    repairNote: `[pool-optimize ${stamp}] performance>response-time>quota; removed ${c.dead.length} dead, gated ${c.ordered.filter((e) => e.overBudget).length} over-budget`,
  };
  db.prepare("UPDATE combos SET data = ?, updated_at = ? WHERE name = ?").run(
    JSON.stringify(next),
    next.updatedAt,
    c.name
  );
  written += 1;
  console.log(`  wrote ${c.name}: ${next.models.length} members (v${next.version})`);
}
console.log(`\napplied to ${written} pool(s).`);
