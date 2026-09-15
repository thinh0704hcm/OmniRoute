---
title: "Pool Optimization"
version: 3.8.51
lastUpdated: 2026-09-11
---

# Pool optimization

How the `pool-*` combos are ordered, what evidence drives that order, and how to
supply better evidence.

The maintained tooling is `scripts/ops/optimize-pools.mjs`. It reads the live DB,
ranks every leaf pool's members, derives each pool's response-time budget, and (with
`--apply`) rewrites the member order and the enforcement config together.

## Priority order

Members are ranked by three signals, in this priority:

1. **Performance** — quality evidence, best source first:
   external benchmark file → arena Elo → catalog proxy. Multiplied by a smoothed
   reliability factor so a model that fails most of the time cannot rank first on
   benchmark strength alone.
2. **Response time** — measured p50 from `usage_history`, falling back to external
   latency evidence. Members slower than the pool's `firstContentTimeoutMs` budget
   are gated **below every member that satisfies it** — the "good enough" gate.
3. **Quota** — remaining quota from `quota_snapshots`, used as the final tiebreak.

The gate is what makes "make sure response time is good enough" concrete: a pool
with an 8 000 ms budget will not put a 41 s model ahead of a 6 s one, no matter how
strong the slow model's benchmark score is.

The budget is evidence, not a constant. Unless the pool already sets
`firstContentTimeoutMs`, it is the **median of the proven members' p90** — what a
typical working member costs at its 90th percentile. Pooling every raw sample
instead would let the slowest members drag the budget toward the ceiling, which
defeats the purpose: the budget exists to exclude the stalling members, so it must
not be computed from them. The derived value is rounded up to a whole second and
clamped to 5 000–60 000 ms; a pool with no usable evidence falls back to
`BUDGET_MS` (default 15 000).

### Member states

| State        | Meaning                                                            | Effect                               |
| ------------ | ------------------------------------------------------------------ | ------------------------------------ |
| `dead`       | Never succeeded, dominated by hard failures (4xx), not rate limits | **Removed** from the pool            |
| over budget  | Response time exceeds the pool's budget (measured or external)     | Gated below all passing members      |
| `unreliable` | Enough samples, but a measured success rate under 35%              | Demoted below every unproven member  |
| proven       | Enough samples, inside budget, usable                              | Normal ranking                       |
| unknown      | No samples yet                                                     | Below the proven, above the unusable |

The reliability floor exists because "we tried it and it fails 98% of the time" is
worse evidence than "we have not tried it": without it, a member measured at 2%
success over thousands of calls would still outrank an unproven one on the strength
of having samples at all.

Only **leaf pools** have their member _order_ rewritten — the ones holding real
`providerId` members. Tier-shell pools (whose members are `combo-ref`s, e.g.
`pool-sonnet` → `pool-sonnet-antigravity` / `-free` / `-credits`) keep their order
and `fallbackTier` chain, which carry routing semantics rather than ranking. Shells
still receive **enforcement** config, derived from the leaves they reference.

## Usage

The CLI imports its pure core by relative path, so both files have to sit together
on the container. `/app/data` is the mounted data volume, so the tooling survives a
container replacement:

```bash
docker cp scripts/ops/optimize-pools.mjs omniroute-parallel:/app/data/pool-optimizer/
docker cp scripts/ops/pool-optimizer-core.mjs omniroute-parallel:/app/data/pool-optimizer/

# Dry run — prints the proposed order and enforcement, writes nothing.
docker exec omniroute-parallel node /app/data/pool-optimizer/optimize-pools.mjs

# Apply. Always writes a rollback backup first.
docker exec omniroute-parallel node /app/data/pool-optimizer/optimize-pools.mjs --apply
```

Env overrides: `DB_PATH`, `WINDOW` (days of history, default 7), `BUDGET_MS`
(fallback budget, default 15000), `PERFORMANCE_FILE` (default
`/app/data/model-performance.json`).

`--verbose` also prints pools that need no change.

Every `--apply` writes `db_backups/pool-optimize-<timestamp>.json` containing the
pre-change `combos` rows and `updatedAt`, and stamps each rewritten combo with a
`repairNote`. Restore by writing those rows back.

## Enforcement

Ordering decides which member is attempted first; it cannot bound how long a bad
member stalls the request. That is the enforcement config, and the same `--apply`
fills it in:

| Field                   | Effect                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `firstContentTimeoutMs` | Bounds one member's stall after it answered 200 (streaming only)                                                                     |
| `comboTimeoutMs`        | Bounds the whole cascade — after it elapses, remaining targets are skipped and the request returns a 504 with aggregated diagnostics |

Both are set from the pool's derived budget: `firstContentTimeoutMs` to the budget,
`comboTimeoutMs` to the budget × 4. **An explicit value is never overwritten** — a
value the operator already set is left exactly as it is, so this adds a deadline to
unconfigured pools rather than retuning configured ones.

This matters because the ranking gate assumes a budget the runtime must also
enforce. A pool whose `firstContentTimeoutMs` is unset has no per-member deadline at
all, so the member the gate calls "over budget" still stalls the client; only the
member _order_ changes.

## Supplying better performance evidence

In-DB evidence is thin: arena Elo covers roughly 10% of pool members, and
everything else falls back to a coarse catalog proxy capped at 0.70. The external
file is the seam for real benchmark evidence.

**Format:** `scripts/ops/model-performance.sample.json` (documented template).
**Working file:** `scripts/ops/model-performance.json`, uploaded to
`/app/data/model-performance.json` in the container.

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-11T00:00:00.000Z",
  "provenance": [{ "source": "artificial_analysis", "url": "…", "retrievedAt": "…" }],
  "models": [
    {
      "model": "glm-5.3", // BARE leaf — no provider, no ':free'/'-free'
      "scores": { "coding": 0.82, "default": 0.8 }, // normalized 0..1
      "metrics": { "sweBenchVerified": 72.1, "latencyMs": 1200, "ttftMs": 420 },
      "confidence": "high",
      "sources": ["artificial_analysis", "swebench"],
    },
  ],
}
```

Rules that keep the ordering trustworthy:

- **`model` is the bare leaf.** `nvidia/nemotron-3-ultra-550b-a55b:free` and
  `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` both match the entry named
  `nemotron-3-ultra-550b-a55b`. Matching is case-insensitive.
- **`scores` are the only values used for ranking quality.** Prefer `default`,
  else `coding`, else `agentic`, else `reasoning`, else the mean of what is given.
- **`metrics` are raw evidence for audit.** Not used for ranking — except
  `latencyMs`/`ttftMs`, which fill response time when we have no measured latency
  of our own.
- **Only include numbers you actually retrieved.** Do not interpolate between
  models. An absent model is better than an invented score; absent entries simply
  fall back to arena/proxy.
- **Cite every source** in `provenance`. Entries named `example-*` are ignored.

A malformed or unreadable file never aborts the run — the optimizer logs that it
fell back to DB signals and continues.

### Sources worth gathering, most relevant first

Agentic routing quality (what the pools actually serve):

| Benchmark           | Why                                                           |
| ------------------- | ------------------------------------------------------------- |
| SWE-bench Verified  | Real repo-level coding, closest to agentic coding work        |
| Aider polyglot      | Multi-language code editing                                   |
| LiveCodeBench       | Contamination-resistant coding                                |
| Terminal-Bench      | Shell/terminal agent behaviour                                |
| BFCL                | Function/tool-call correctness — directly gates tool loops    |
| τ-bench (tau-bench) | Tool-agent-user loops end to end                              |
| Artificial Analysis | Composite intelligence index + independent latency/throughput |
| GPQA Diamond / AIME | Reasoning depth                                               |
| MMLU-Pro            | Broad knowledge                                               |
| LMArena Elo         | Human-preference quality (partially synced already)           |

Serving performance: OpenRouter's per-model latency/throughput columns and
Artificial Analysis output speed.

## How ranking is computed

```
performance = quality × reliability

quality      =  evidence (0..1)          when the external file has a score
             |  (elo − 1450) / 200       when arena Elo exists
             |  catalog proxy, ≤ 0.70    otherwise (capped, never beats evidence)
             |  0.40                     when nothing is known

reliability  =  (ok + 4) / (n + 5)       n > 0   (Beta prior toward 0.8)
             |  0.60                     n = 0   (cold: neutral-low, cannot dominate)
```

Nothing is invented to fill a gap: an unmeasured member sits at a middling score
and is reported as `estimate` or `unknown`, so a reviewer can see how much of the
order rests on hard evidence. Where the external file carries a latency for a
model we have never called ourselves, the response-time gate still applies and
the output marks the source (`measured` vs `external`).

## Applying the same evidence to runtime routing

The optimizer writes combo member order; it does not change the runtime scorer.
To make the same evidence affect `auto` routing, write it into `model_intelligence`
(source `user_override`, highest in the resolution chain in
`src/lib/db/modelIntelligence.ts`) instead of, or in addition to, the JSON file.
Note the resolution chain's SQL enumerates its sources — a new source name would
need to be added there and covered by a test.

## Related

- `docs/routing/AUTO-COMBO.md` — runtime strategy scoring
- `docs/architecture/RESILIENCE_GUIDE.md` — circuit breaker, cooldown, model lockout
- `docs/ops/ORACLE_VPS_OPERATIONS_KB.md` — deploy/rollback contract for the VPS
