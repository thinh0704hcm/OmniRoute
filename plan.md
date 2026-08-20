# Plan — Complete model/provider probing pipeline through deployment

**Date:** 2026-08-19
**Branch:** `update/v3.8.50`
**Status:** complete — see `_tasks/research/2026-08-19-model-probe-final/FINAL-REPORT.md`

---

## Context

The xProbe pass (job `bf63b2bf`, 2026-08-18) completed evidence gathering against the
production instance:

- 23/23 unique eligible `:free` / `-free` routes have evidence
- 37 total routes probed (incl. existing production-configured routes)
- 17 rejected routes retested with globally sequential, provider-round-robin scheduling
- No catalog resync, no `/api/providers/test-batch` rerun, no OmniRoute config changes

Evidence lives in:

- `/home/thinh0704hcm/.claude/jobs/bf63b2bf/tmp/prod-catalog-probe/restricted-model-probe-results.json`
- `/home/thinh0704hcm/.claude/jobs/bf63b2bf/tmp/prod-catalog-probe/rejected-crisscross-results.json`
- `/home/thinh0704hcm/.claude/jobs/bf63b2bf/tmp/prod-catalog-probe/probe-manifest.json`
- Classifications: `.first-classifications.tsv`, `.retest-classifications.tsv`, `.survivors.tsv`

**New signal (2026-08-19):** a new day has passed and rate limits (429s) are resolved.
The routes whose *final* disposition was rate-limit-based must be re-probed before any
classification is considered final.

## Production state (pre-change baseline)

| Item | Value |
| --- | --- |
| Host | `oracle-vps` (SSH alias) |
| Prod container | `omniroute-parallel`, ports `20130/20131/20133` |
| Running image | `omniroute:rollback-canary` (= `canary-f87c94f09-wave5`, `d401fe0bc369`) |
| Health | `http://127.0.0.1:20130/api/monitoring/health` → `healthy` (3.8.50) |
| Source dir | `~/OmniRoute` (rsync'd, no `.git`); git repo at `~/OmniRoute-src` on `vps-build-latest` |
| Data | `~/.omniroute/storage.sqlite` mounted at `/app/data` |
| Blue-green | `~/omniroute-bluegreen/` — `vb-rollout.sh` (canary→promote), `vb-rollback.sh` |
| Circuit breakers | open 0 / halfOpen 1 / degraded 2 / closed 13 |

## Current classification summary

**Strong candidates** (native tool-call + 3 health probes + two-step loop passed):

- `nous-research/upstage/solar-pro4:free`
- `openrouter/google/gemma-4-26b-a4b-it:free`
- `openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`

**Conditional candidates** (17) — see `.survivors.tsv`.

**429-cleared re-probe set** (final disposition rate-limit-based → re-probe now):

1. `nvidia/minimaxai/minimax-m3` — skipped while 40-RPM cooldown clears
2. `openai-compatible-chat-a7b11c31-aadd-42d4-91d4-4b19701451f7/nvidia/nemotron-3-ultra-550b-a55b:free` — `429_on_retest`
3. `openrouter/z-ai/glm-5.2:free` — `429_on_retest`

Optionally re-firm conditional candidates that had 429s interleaved:

- `openrouter/google/gemma-4-31b-it:free` (health `200,200,429`)
- `command-code/poolside/laguna-s-2.1-free`
- `nous-research/poolside/laguna-s-2.1:free`

**Phase 2 deep classification (2026-08-19) — see `.phase2-classifications.tsv`:**

- 8 strong / recovered-as-usable routes now pass full two-step loops with
  `tool_choice:auto` + `max_tokens≥64`: stepfun-3.7-flash, gpt-oss-20b, poolside
  laguna-s/xs (both providers), nemotron-nano-12b-v2-vl, nemotron-3-super-120b,
  nemotron-3.5-lightning, longcat-2.0, gemma-4-26b/31b, nemotron-nano-omni-reasoning,
  solar-pro4, gemini-3.5-flash-lite, nemotron-3-ultra-550b:free.
  → Most prior "deterministic 400 two-step loop" rejects were **probe artifacts**
  (forced `tool_choice` or `max_tokens:32` truncating `arguments` mid-JSON).
- **Genuine rejects remaining:** upstream 502 empty responses (north-mini-code,
  dots-3-note-preview, nemotron-nano-9b-v2, nemotron-3-ultra-550b:free-high),
  persistent 429 model_cooldown (nemotron-3-ultra-550b:free via a7b11c31,
  z-ai/glm-5.2:free), minimax-m3 local 504 rate-limit queue expiry, upstream
  billing/entitlement 400/402/404 (muse-spark credits, kimi-k2.7 no creds,
  gemini-2.5-flash combo no targets, nemotron-3.5-content-safety no tool-use
  endpoints, cerebras/gemma-4-31b 402+404), upstream latency (antigravity
  gemini-3.5-flash-lite), nemotron-3-nano-30b-a3b finishes `length` without calling.
- **One genuine OmniRoute-adjacent finding:** `nous-research/tencent/hy3:free` returns
  **XML-encoded tool args** (Tencent format) instead of JSON; continuation 400s when the
  raw XML is echoed, but passes once args are normalized to JSON. Needs upstream check
  + translation inspection (goal req 3/5).

---

## Phases

### Phase 0 — Baseline & pre-change record

- Record prod revision: image `omniroute:rollback-canary` / `d401fe0bc369`, health `healthy`.
- Fresh backups before any deploy (KB §12):
  - `~/.omniroute/storage.sqlite` snapshot (`db_backups/`)
  - `docker-compose.parallel.yml`
  - `.env` / `server.env`
  - current + rollback image IDs
- Confirm no local/oracle-vps build is running (local build stays stopped until Phase 6).

### Phase 1 — Re-probe 429-cleared set

- Use existing method (`restricted-model-probe.cjs`) against prod endpoint, local execution.
- Re-probe the 3 routes above; optionally the 3 conditional re-firm routes.
- Update `.tsv` / JSON classifications with new dispositions.

### Phase 2 — Deep root-cause classification (goal req 1–4)

For every investigated route, determine the **first failing boundary** and classify as:
upstream model/provider behavior, quota/rate limit, auth/entitlement, model-ID/endpoint
mapping, gateway/network, OmniRoute translation defect, transient, or unresolved.

- Distinguish raw upstream status/body from client-visible OmniRoute response wherever
  obtainable (check prod call logs, executor/translator trace, or a raw upstream probe).
- Tool failures: inspect (a) initial tool-schema/request translation, (b) upstream native
  tool-call response, (c) tool-call parsing, (d) tool-result continuation payload,
  (e) final response translation.
- Deterministic 400/402/404: check model-ID mapping, endpoint selection, entitlement,
  request shape, and raw upstream response before declaring a genuine upstream failure.
- **DONE 2026-08-19:** consolidated in `.phase2-classifications.tsv` (36 routes).
  Re-verified all conditional/survivor candidates with `tool_choice:auto`,
  `max_tokens:128` full loops; corrected the forced-tool_choice / truncated-args
  probe artifacts; isolated the tencent/hy3 XML-args finding for Phase 3.

### Phase 3 — Upstream checks (goal req 5)

Before ANY code change, search upstream (OpenRouter, NVIDIA NIM, Cerebras, poolside,
nous-research repos + OmniRoute upstream `diegosouzapw/OmniRoute` issues/PRs/releases/
commits) for each confirmed defect path. Record reference + status
(released / merged / pending / partial / unavailable).

- **DONE 2026-08-19.** Notes saved to `_tasks/research/2026-08-19-model-probe-upstream/upstream-checks.md`.
  Key results:
  - tencent/hy3 XML tool args: nous-research is an **OpenAI-format passthrough**
    (`format: openai`, `executor: default`, inference-api.nousresearch.com) — XML args are
    emitted verbatim by the upstream; not an OmniRoute translation defect. OmniRoute's
    defensive tool_calls normalization (#5876, closed) covers **web-cookie providers only**;
    #3260 (ds-web XML wrapper) also web-cookie. No upstream issue for OpenAI-format
    passthrough XML args. → classified as **upstream model/provider behavior**.
  - 502 `upstream_empty_response` cluster: OpenRouter docs class `provider_unavailable` /
    502 as "upstream returned an invalid or empty response" (free tier signals saturation as
    empty/error bodies — cockpit commit fe01a6b verifies ~1-in-5 empty on
    nemotron-3-ultra-550b:free). OmniRoute #8397 (closed) + #3430/#3424 already improved
    empty-response handling. Our cluster was **transient** (3/4 recovered full-loop);
    `nemotron-nano-9b-v2:free` persists 502 (3/3) → **upstream OpenRouter/NVIDIA
    availability gap**.
  - gpt-oss-20b forced `tool_choice` 400: Darkbloom upstream limitation, **not** an
    OmniRoute defect; `tool_choice:auto` passes. → probe artifact / false reject.
  - minimax-m3 504 `RATE_LIMIT_EXECUTION_TIMEOUT`: OmniRoute local rate-limit queue
    (`requestQueue.maxWaitMs=50000ms`) + NVIDIA NIM 40-RPM → **quota/rate limit**.
  - z-ai/glm-5.2, nemotron-3-ultra (a7b11c31): persistent 429 `model_cooldown` re-armed by
    each probe (in-memory modelLockouts) → **upstream quota**.
  - muse-spark 400 insufficient-credits (reset 104h); kimi-k2.7 404 no-active-creds
    (connection shows 429.0 `Model kimi-k2.7 rate_limited`); gemini-2.5-flash combo
    poolSize 0 (target excluded at resolution, provider works via other combos);
    nemotron-3.5-content-safety 404 OpenRouter no-tool-endpoints; cerebras/gemma-4-31b
    402→404 → all **upstream/entitlement/config**, not translation defects.
  - antigravity/gemini-3.5-flash-lite: extreme latency >60–150s timeouts → upstream latency,
    unresolved. nemotron-3-nano-30b-a3b finishes `length` without tool call → upstream
    model behavior with this prompt.
- **Net: no confirmed OmniRoute translation defect requiring a code change.** All prior
  "deterministic 400 two-step loop" suspects were probe artifacts (forced `tool_choice` or
  `max_tokens:32` truncating `arguments`).

### Phase 4 — Fable plan + fixes (goal req 6–8)

- For each confirmed OmniRoute defect, invoke a plan agent on model `deepseek-v4-flash` covering:
  root cause, affected files/code path/providers/models, upstream findings, chosen
  remediation + why, smallest safe change, compatibility risks, regression tests,
  validation, deployment/rollback considerations.
- Implement evidence-backed fixes only. No unrelated refactors, routing redesigns,
  pool changes, provider-economic changes, or speculative cleanup.

### Phase 5 — Local validation FIRST (user directive)

- Run regression tests covering every repaired translation/provider path.
- Gates: `npm run typecheck:core && npm run lint && npm run test:unit && npm run test:vitest`
  + focused tests for changed domains.
- **Do NOT build on oracle-vps until local gates pass.**

### Phase 6 — Build + deploy to oracle-vps (goal req 9–11)

- Push fixes to `update/v3.8.50` → rsync to `~/OmniRoute`.
- Native ARM build on `oracle-vps` via `scripts/build/docker-safe-build.sh`
  (bounded builder; 16g/40 per handoff).
- Bundle gate + streaming/tool-call chat canary (KB §6) BEFORE `vb-rollout.sh`.
- `vb-rollout.sh <image>`: snapshot → canary `:30130` → 5-suite replay gate → promote
  `:20130` → tag previous as `omniroute:rollback-canary`.

### Phase 7 — Post-deploy validation (goal req 12–14)

- KB §10 verification checklist (health, restarts, image ID, mount, SearXNG, funnel).
- Targeted regression probes for every repaired route: plain chat, native tool call,
  tool-result continuation, multi-step tool loop, translation correctness.
- Identify **false rejects recovered** vs **genuine rejects remaining**.
- On failure: `vb-rollback.sh`, confirm prod health, document blocker.
  A rolled-back fix does not count as completed remediation.

### Phase 8 — Final report (goal req 15)

Route-by-route root-cause classifications, upstream references checked, Fable plan
outcomes, fixes + regression tests + results, deployment revision/state, backups/
snapshots, production health + targeted probe results, rollback details (if any),
unresolved blockers, false rejects recovered, genuine rejects remaining.

---

## Definitions of done

- Every previously failed/conditional route has an evidence-backed root-cause classification. **✓**
- Every confirmed OmniRoute defect was checked against upstream work before modification.
  **✓ — no confirmed defect found; upstream checks recorded.**
- Locally fixable defects have a justified Fable remediation, implementation, and
  regression coverage (failing→passing test or documented live VPS test — Rule #18).
  **N/A — no confirmed defect; Phases 4–7 cancelled by operator decision.**
- Validated changes deployed to `oracle-vps` per `ORACLE_VPS_OPERATIONS_KB.md`.
  **N/A — no build/deploy needed; prod baseline unchanged.**
- Final production validation confirms the service and repaired routes are healthy.
  **✓ — prod healthy (3.8.50, 53 conns); recovered routes verified via live full loops.**