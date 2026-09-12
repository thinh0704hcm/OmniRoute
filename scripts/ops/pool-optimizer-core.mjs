/**
 * scripts/ops/pool-optimizer-core.mjs
 *
 * Pure ranking + budget logic for scripts/ops/optimize-pools.mjs.
 *
 * Extracted so it can be unit-tested and reused by the dry-run job without
 * opening a database. Nothing here performs IO: every lookup arrives through
 * the `deps` argument, and every input is a plain object.
 *
 * @see scripts/ops/optimize-pools.mjs — the CLI that owns the DB, fs and writes
 * @see docs/ops/POOL_OPTIMIZATION.md — the ranking contract
 */

/** Minimum observed requests before a latency/reliability judgement is trusted. */
export const MIN_SAMPLES = 5;

/** Beta prior for the reliability factor: (ok + 4) / (n + 5) → prior 0.8. */
export const RELIABILITY_PRIOR_OK = 4;
export const RELIABILITY_PRIOR_N = 5;

/** Reliability assumed for a member we have never observed. */
export const COLD_RELIABILITY = 0.6;

/**
 * A proven member below this reliability is demoted alongside the over-budget
 * ones. Proven-and-broken must never outrank unproven: "we tried it and it fails
 * 98% of the time" is worse evidence than "we have not tried it".
 */
export const USABLE_RELIABILITY_FLOOR = 0.35;

/** A member is "over budget" once its p50 passes the pool budget. */
export const OVER_BUDGET_RATIO = 1.0;

/** Arena Elo band used to normalize into 0..1 (covers current top models). */
export const ELO_FLOOR = 1450;
export const ELO_CEIL = 1650;

/** A member with zero successes and at least this much hard-failure traffic is dead. */
export const DEAD_HARD_FAIL_RATE = 0.5;

/** Statuses that are hard failures (as opposed to 429/5xx which may be transient). */
export const HARD_FAIL_STATUSES = new Set([400, 401, 402, 403, 404, 410, 422]);

/** Fallback budget when a pool has neither explicit config nor usable evidence. */
export const DEFAULT_BUDGET_MS = 15_000;

/** Derived budgets are clamped into this band and rounded up to a whole second. */
export const BUDGET_FLOOR_MS = 5_000;
export const BUDGET_CEIL_MS = 60_000;

/**
 * How many members a cascade may walk through before the wall-clock cap applies.
 * Drives `comboTimeoutMs = budgetMs * ALLOWED_CASCADE_ATTEMPTS`.
 */
export const ALLOWED_CASCADE_ATTEMPTS = 4;

export function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

/** Bare model leaf: strip provider segments and :free/-free suffixes. */
export function bareLeaf(model) {
  return String(model)
    .split("/")
    .pop()
    .toLowerCase()
    .replace(/:free$/, "")
    .replace(/-free$/, "");
}

/** True when the model string carries an explicit free-tier suffix. */
export function isFreeVariant(model) {
  return /(:free|-free)$/i.test(String(model));
}

/**
 * Strip the `providerId/` prefix a combo member carries.
 *
 * Combo members store `model` as `<providerId>/<model>` (`longcat/LongCat-2.0`),
 * while `usage_history.model` stores it bare (`LongCat-2.0`). Keying a lookup on
 * the member string would never match, which is what pushed every lookup into the
 * lossy bare-leaf fallback.
 */
export function rawModelFor(provider, model) {
  const s = String(model);
  const prefix = `${provider}/`;
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

/** Percentile over an already-sorted array. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.floor(p * (sorted.length - 1))];
}

/**
 * Look up a latency bucket for a member, preferring the exact raw model and
 * falling back to the bare leaf only when that leaf is unambiguous.
 *
 * Without this, `nemotron-3-ultra-free` and `nemotron-3-ultra` collapse onto one
 * bucket (bareLeaf strips the `-free` suffix) and the two variants silently
 * share latency stats.
 */
export function lookupVariant(map, provider, model, keySep = "\u0000") {
  const rawKey = `${provider}${keySep}${rawModelFor(provider, model)}`;
  if (map.has(rawKey)) return map.get(rawKey);

  const leaf = bareLeaf(model);
  const wantsFree = isFreeVariant(model);
  const candidates = [];
  for (const [k, hit] of map) {
    const [p, m] = k.split(keySep);
    if (p !== provider) continue;
    if (m === leaf || bareLeaf(m) === leaf) candidates.push({ hit, free: isFreeVariant(m) });
  }
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0].hit;
  const variant = candidates.find((c) => c.free === wantsFree);
  return (variant ?? candidates[0]).hit;
}

/** Quality evidence in 0..1, with the source reported so a reviewer can see the basis. */
export function qualityOf(provider, model, deps) {
  const ext = deps.lookupExternal(model);
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

  const arena = deps.lookupElo(model);
  if (arena != null) {
    return {
      score: clamp01((arena - ELO_FLOOR) / (ELO_CEIL - ELO_FLOOR)),
      basis: "arena",
      detail: `elo ${arena}`,
    };
  }

  const cap = deps.lookupCapability(provider, model);
  if (cap) {
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
export function reliabilityOf(lat) {
  if (!lat || lat.n === 0) return COLD_RELIABILITY;
  return clamp01((lat.ok + RELIABILITY_PRIOR_OK) / (lat.n + RELIABILITY_PRIOR_N));
}

/** Response time in ms: measured p50, else external latency, else null. */
export function responseTimeOf(lat, ext) {
  if (lat?.p50 != null) return { ms: lat.p50, source: "measured" };
  const m = ext?.metrics ?? {};
  const extMs = Number(m.latencyMs ?? m.ttftMs);
  if (Number.isFinite(extMs) && extMs > 0) return { ms: extMs, source: "external" };
  return { ms: null, source: "none" };
}

export function evaluate(member, budgetMs, deps) {
  const provider = member.providerId;
  const model = member.model;
  const lat = deps.lookupLatency(provider, model);
  const ext = deps.lookupExternal(model);
  const quality = qualityOf(provider, model, deps);
  const reliability = reliabilityOf(lat);
  const rt = responseTimeOf(lat, ext);

  const enough = Boolean(lat && lat.n >= MIN_SAMPLES);
  const dead = Boolean(
    enough && lat.ok === 0 && lat.hardRate >= DEAD_HARD_FAIL_RATE && lat.limitedRate < 0.5
  );
  const overBudget = Boolean(rt.ms != null && rt.ms > budgetMs * OVER_BUDGET_RATIO);
  const unreliable = Boolean(enough && reliability < USABLE_RELIABILITY_FLOOR);

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
    unreliable,
    quota: deps.lookupQuota(provider),
    p50: rt.ms,
  };
}

/**
 * Ordering key, ascending.
 *
 *   gate 0: enough evidence, inside the budget, and usable
 *   gate 1: no evidence yet — unproven, so below the proven-good
 *   gate 2: proven unusable — too slow, or reliable too rarely to be worth a slot
 *   gate 3: dead (removed)
 *
 * Then performance desc, response time asc, reliability desc, quota desc.
 */
export function sortKey(e) {
  const gate = e.dead ? 3 : e.overBudget || e.unreliable ? 2 : e.enough ? 0 : 1;
  return [
    gate,
    -Math.round(e.performance * 100),
    e.p50 ?? Number.POSITIVE_INFINITY,
    -Math.round(e.reliability * 100),
    e.quota ? -e.quota.pct : 0,
  ];
}

export function compare(a, b) {
  const ka = sortKey(a);
  const kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return a.model.localeCompare(b.model);
}

/**
 * Response-time budget for a pool: the median of its proven members' measured
 * p90 — "what a typical working member costs at its 90th percentile". The
 * deadline then fires on a stall, not on a member that is merely slower than its
 * peers.
 *
 * Pooling every raw sample instead would let the slowest members drag the budget
 * to the ceiling, which defeats the purpose: the budget exists to exclude the
 * stalling members, so it must not be computed from them. Rounded up to a whole
 * second and clamped to a sane band.
 *
 * Falls back to `fallbackMs` when no member has usable evidence.
 */
export function deriveBudgetMs(entries, opts = {}) {
  const floor = opts.floorMs ?? BUDGET_FLOOR_MS;
  const ceil = opts.ceilMs ?? BUDGET_CEIL_MS;
  const fallback = opts.fallbackMs ?? DEFAULT_BUDGET_MS;

  const perMember = [];
  for (const e of entries) {
    if (!e.enough || e.dead) continue;
    const p90 = e.lat?.p90;
    if (Number.isFinite(p90) && p90 > 0) perMember.push(p90);
  }
  if (!perMember.length) return fallback;

  perMember.sort((a, b) => a - b);
  const value = percentile(perMember, 0.5);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.ceil(value / 1000) * 1000, floor), ceil);
}

/**
 * Enforcement config for a pool, filling only what the operator has not set.
 * Existing explicit values win — this adds a deadline, it does not retune one.
 *
 *   firstContentTimeoutMs — bounds one member's stall after it answered 200
 *   comboTimeoutMs        — bounds the whole cascade across members
 */
export function enforcementFor(budgetMs, config = {}, opts = {}) {
  const attempts = opts.attempts ?? ALLOWED_CASCADE_ATTEMPTS;
  const current = Number(config?.firstContentTimeoutMs) || 0;
  const currentCombo = Number(config?.comboTimeoutMs) || 0;
  const patch = {};

  if (current <= 0) patch.firstContentTimeoutMs = budgetMs;
  if (currentCombo <= 0) patch.comboTimeoutMs = budgetMs * attempts;

  return patch;
}
