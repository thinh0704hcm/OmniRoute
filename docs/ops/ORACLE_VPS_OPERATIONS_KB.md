---
title: Oracle VPS operations knowledge base
---

# Oracle VPS operations knowledge base

Last updated: 2026-08-26

This is the canonical, durable runbook for OmniRoute production on `oracle-vps`. It covers
source ownership, validation, immutable builds, isolated canary qualification, promotion,
rollback, log recovery, artifact pruning, and cleanup. The incident snapshot below remains as
provenance for the August 2026 repair; update the live-state fields after every verified rollout.

## Verified repair outcome — 2026-08-23

- Canonical fork branch: `update/v3.8.50`; runtime source commit: `4506bd9326`.
- Production image: `omniroute:canary-4506bd9326-20260823`, image ID
  `sha256:cbfd94dcea5e0623163af2a505b2a2693557b3e92084be20a444dbd5d3535265`.
- Immediate rollback image ID:
  `sha256:75d4021de57fc4f6703e1439b0eb590afa237c0cab5f833f7379fe33851c46dc`.
- Production promotion, live rollback, and re-promotion all reached healthy status with zero
  restarts. The final candidate’s canary and post-promotion gates passed all four completions,
  streaming, all four mixed-case tool continuations, combo evidence, and advancing call logs.
  Terra’s free-target tool regression was reproduced, fixed, and replayed successfully.
- Call-log recovery inserted 13,557 valid missing rows for
  `(2026-08-19T12:44:10.277Z, 2026-08-22T18:52:48.000Z]`, with zero corruption, invalid rows,
  checksum mismatches, collisions, or capacity skips. The repeat scan found 13,557 duplicates
  and zero inserts. Orphan inventory scanned 22,675 artifacts and found zero orphans.
- The latest integrity-checked pre-promotion backup is
  `/home/ubuntu/.omniroute/deployments/backups/storage_20260822T202429499086488Z_2336671_pre-promote.sqlite`.

### Decisions discovered during qualification

- The 12 GiB BuildKit cap failed with `cannot allocate memory`. Keep the existing builder name
  `omniroute-safe-12g-4`, but its container is updated to 18 GiB memory and 20 GiB memory+swap.
  Verify the effective limits with `docker inspect` before future builds; recreating the builder
  from its old driver options would silently restore the insufficient 12/16 GiB limits.
- The required `JWT_SECRET`, `API_KEY_SECRET`, and `OMNIROUTE_WS_BRIDGE_SECRET` were empty or
  absent in the transferred environment. Fresh 256-bit values were generated on Oracle and are
  stored only in `contrib/vps/.env` (mode `0600`). Never print or commit them.
- Canary containers run with the host data owner (UID/GID 1001 on this host), while production
  reconciliation runs as the image data owner (UID/GID 1000). Canary preparation copies
  `server.env` at mode `0600` so encrypted credentials remain decryptable.
- Oracle Redis is Redis 7.4.10. The verified existing image ID was also tagged locally as
  `docker.io/library/redis:7.4.10-alpine`; canary and production overlays use that exact tag.
- Exact stored combo names must win before route-level model alias expansion. Otherwise
  `gpt-5.6-luna` and peers become `opencode/...`, bypass the quota-tiered combos, and return 402.
- Deployment backups live under the host-writable `deployments/backups` directory. The
  application-owned `db_backups` directory is not a valid deploy-user destination.
- Validation policy for this repair was broad `npm run lint` plus focused unit tests only. The
  broad unit runner was explicitly stopped; Vitest was not run. Focused routing/deploy matrices
  and real canary/production probes provide the bug-fix evidence.

## Authority and current state

Continue only on oracle-vps in /home/ubuntu/OmniRoute-src.

    branch: update/v3.8.50
    upstream remote: origin
    fork remote: fork
    upstream base: 6cd4d38e2

The Oracle working tree is clean at the canonical pushed commit. Changes are developed on the
workstation, pushed to `fork`, then synchronized and verified on Oracle; never deploy a dirty
checkout or hand-edit only persisted combo rows.

### Pending manual-routing rollout — 2026-08-26

- `b1108cd6ae` adds `config.manualRoutingOverride`. In the Combo editor, enable **Manual
  routing override**, arrange the persisted step order, and save. That order then takes
  precedence over a managed composite tier graph. Clear the checkbox to resume canonical
  graph-based routing. The setting is persistent, so it is an operator control rather than a
  one-time database edit.
- `e539eff323` sets `API_HOST=0.0.0.0` in both Oracle Compose overlays. This is required for
  the host-loopback API bridge ports used by the canary and deployment gates.
- The immutable `omniroute:canary-b1108cd6ae-20260826` / `ops-b1108cd6ae-20260826` images were
  built and one isolated qualification passed health, SHA/image identity, zero restart,
  completion, streaming, mixed-case tool, combo, and call-log gates.
- No production cutover occurred. Two later promotion requalifications ended with the bounded
  upstream error `The operation was aborted due to timeout`; the deployment tool correctly
  stopped before cutover. Production remains on its prior image. Do not promote by manually
  replacing a container. Rerun the normal `promote` command only after a fresh qualification
  passes.

When investigating this class of failure, distinguish a transient provider timeout from a
container failure: inspect the current image, restart/OOM state, Docker health, and loopback
`/healthz` response time. Preserve the canary, backup, and rollback safeguards; do not clear a
live deployment lock except through the deployment helper's canary cleanup actions after an
interrupted client has been verified absent.

Current live state:

    container: omniroute-parallel
    image: omniroute:canary-4506bd9326-20260823
    image ID: sha256:cbfd94dcea5e0623163af2a505b2a2693557b3e92084be20a444dbd5d3535265
    status: running, healthy, 0 restarts
    rollback tag: omniroute:rollback-canary
    rollback ID: sha256:54e1f509e4dacad520e7b55ad8eb5f6bf22385c464395b32d7c6765b798453f6

Historical pre-repair database evidence:

    call_logs rows: 44,976
    latest timestamp: 2026-08-19T12:44:10.277Z
    response_id column: absent
    orphan backlog: about 13,606 files / 3.77 GB

Root cause: a reused migration lease slot recorded the response migration as
applied without adding response_id. New inserts fail after writing artifacts.

## Implemented root fixes

- Migration reconciliation heals the lease marker, response_id, and its index.
- Failed summary inserts delete only their own new artifact and still rotate.
- Artifact recovery is bounded, validated, transactional, and dry-run first.
- Orphan pruning requires exact dry-run count/bytes and revalidates each file.
- Tool aliases preserve exact client case across Chat, Responses, Claude,
  streaming, non-streaming, and continuation paths.
- Only GitHub/GHE gpt-5.6-luna receives lowercase wire names; ambiguous aliases
  fail closed.
- Anthropic structured blocks and Tencent XML tool arguments are normalized at
  protocol boundaries.
- Exactly 24 canonical combos use reset-aware leaf pools and executable,
  performance/quota-ordered tiers; x-preview and invalid Haiku routes are gone.
- Combo reconciliation is dry-run/adopt/check based and creates no-clobber,
  integrity-checked backups.
- Canary and promotion use immutable identity, isolated data/Redis/network,
  runtime traffic gates, manifests, exact rollback pinning, and auto-rollback.
- Dynamic MCP ports, OpenCode quota, Antigravity probe, and Cloudflare null
  content fixes were retained because regression tests prove them.

Key operator files:

    scripts/ops/oracle-deploy.mjs
    scripts/ops/oracleDeploy.ts
    scripts/ops/oracle-deploy-remote.sh
    contrib/vps/compose.oracle.yaml
    contrib/vps/compose.canary.yaml

## Verification completed

On Oracle:

    npm ci: passed
    OmniGlyph: 1.4.0
    shell syntax: passed
    focused Node matrix: 134 passed / 0 failed
    git diff --check: passed
    Prettier: applied to changed supported files

A broader pre-transfer matrix passed 310/310, but final full runners are still
required on Oracle. npm run lint was running when the interactive session was
interrupted; check it and rerun to capture a definite exit status.

Oracle Node toolchain:

    export PATH=/home/ubuntu/.local/omniroute-node/bin:$PATH
    node --version
    npm --version

Expected: Node v26.7.0 and npm 12.0.2. npm ci generated an ignored root .env;
it is not production configuration and its secrets must not replace production.

Cleanup completed:

- Keep only Buildx builder omniroute-safe-12g-4 (effective limit: 18 GiB memory / 20 GiB swap).
- Six obsolete builders and old OmniRoute images were removed.
- Live and rollback images remain protected.
- Oracle has more than 100 GB free.
- Workstation dependencies/caches, stale worktree, and stale watcher were removed.

## Continue from here

### 1. Finish gates

    cd /home/ubuntu/OmniRoute-src
    export PATH=/home/ubuntu/.local/omniroute-node/bin:$PATH
    pgrep -af 'eslint .*suppressions-location|npm run lint' || true
    npm run lint
    npm run typecheck:core
    npm run typecheck:noimplicit:core
    npm run check:cycles
    npm run test:unit
    npm run test:vitest
    npm run check:docs-all
    git diff --check

Both test runners are mandatory. Fix root causes and rerun narrow regressions
before broad gates.

### 2. Commit and publish the canonical branch

Review git status, diff, and diff --stat first. Then:

    git add -- Dockerfile contrib/vps open-sse scripts/ops src tests docs/ops/handoff.md
    git commit -m "fix(ops): repair routing logs and canary deployment"
    git push --force-with-lease=fork/update/v3.8.50:6fe25f3dc9aeeba07cc94252c6af1c3d15877cfb fork update/v3.8.50

Do not add co-author attribution. Do not push origin. Do not bypass hooks.

### 3. Migrate production configuration

Copy /home/ubuntu/OmniRoute/.env without printing it to:

    /home/ubuntu/OmniRoute-src/contrib/vps/.env

Set mode 0600 and preserve all values. Atomically update only:

    OMNIROUTE_IMAGE=omniroute:canary-6fe25f3dc-20260822
    OMNIROUTE_BUILD_SHA=6fe25f3dc
    OMNIROUTE_BIND_HOST=0.0.0.0
    OMNIROUTE_API_BIND_HOST=0.0.0.0
    REDIS_BIND_HOST=127.0.0.1

The app binds preserve the current public/Tailscale contract. Redis must be
loopback-only. Never print, diff, or commit this file.

Validate:

    docker compose --project-name omniroute \
      --project-directory contrib/vps \
      --env-file contrib/vps/.env \
      --file contrib/vps/compose.yaml \
      --file contrib/vps/compose.oracle.yaml config --quiet

Compose 2.24.4 or newer is required for !override.

### 4. Build immutable runner and ops images

Only after committing:

    sha="$(git rev-parse --short=10 HEAD)"
    candidate="omniroute:canary-$sha-20260822"
    ops_image="omniroute:ops-$sha-20260822"

    docker buildx build --builder omniroute-safe-12g-4 \
      --target runner-base \
      --build-arg "OMNIROUTE_BUILD_SHA=$sha" \
      --build-arg OMNIROUTE_BUILD_MEMORY_MB=8192 \
      --tag "$candidate" --load .

    docker buildx build --builder omniroute-safe-12g-4 \
      --target ops \
      --build-arg "OMNIROUTE_BUILD_SHA=$sha" \
      --build-arg OMNIROUTE_BUILD_MEMORY_MB=8192 \
      --tag "$ops_image" --load .

Inspect both OCI revision labels; each must equal the short Git SHA.

### 5. Qualify and promote

The orchestrator uses SSH. Because execution must remain on Oracle, first test:

    ssh -o BatchMode=yes -o ConnectTimeout=10 localhost true

If loopback SSH works, securely load OMNIROUTE_SMOKE_API_KEY without echoing it:

    node --import tsx/esm scripts/ops/oracle-deploy.mjs qualify \
      --host localhost --image "$candidate" --ops-image "$ops_image" --sha "$sha"

    node --import tsx/esm scripts/ops/oracle-deploy.mjs promote \
      --host localhost --image "$candidate" --ops-image "$ops_image" --sha "$sha"

If loopback SSH fails, do not manually recreate production. Add a reviewed local
transport or configure key-based loopback SSH and rerun deployment tests.

Qualification uses a WAL-consistent DB copy and isolated canary. Promotion backs
up SQLite, pins exact rollback, reconciles combos, writes a pending manifest,
and either activates or restores and verifies rollback.

### Canonical squrvq recovery contract

`squrvq` is the only production origin: `https://squrvq.tail0bec0f.ts.net` and
`wss://squrvq.tail0bec0f.ts.net/live-ws`. The legacy `my-server` name is not a
production origin; retain it only as a temporary rollback alias while a verified
promotion is being observed.

The Oracle overlay owns the persistent `ts-gateway` container. It uses the pinned
Tailscale v1.102.2 arm64 digest, host networking, and the mode-0700 state bind at
`/home/ubuntu/ts-gateway/state`. Run every Tailscale command through
`docker exec ts-gateway tailscale`; never inspect or mutate an unrelated host
daemon. The one-time `adopt-gateway` transaction snapshots the complete state,
image/spec, and normalized Serve/Funnel JSON, then verifies the `squrvq` identity
and exact handlers: API root → `http://127.0.0.1:20131`, `/healthz` → dashboard
listener `20130`, and `/live-ws` → the native WebSocket listener `20133`. A failed
adoption restores the state snapshot and previous container/image/spec; a reset or
semantic mismatch is fatal.

Local qualification requires the exact container/image build identity, zero
restarts and OOM kills, 6-GiB memory, 2-CPU limit, dashboard/health/models,
non-empty completion, streaming, combo, call-log, and LiveWS welcome results.
Public qualification requires `/healthz` 200, unauthenticated `/v1/models` 401
(404 is a failure), authenticated models containing every configured smoke model,
non-empty authenticated completion, and an authorized LiveWS welcome with the
`Origin` header and `{"type":"subscribe","channels":["requests"]}` payload.
Missing, null, malformed, or false gate values fail closed.

The schema-v2 promotion transaction is ordered as follows: acquire the lock;
capture runtime/Compose state; back up SQLite, `.env`, and gateway state/config;
pin the previous OmniRoute and gateway images; write the `pending` manifest;
reconcile canonical `squrvq` environment and combos; set/recreate the candidate;
pass both local tunnels; reconcile Funnel; pass public gates; then mark `active`.
After a pending manifest exists, every failure attempts gateway restoration, `.env`
restoration and hash verification, then prior image recreation and local identity/
health verification. Only all-success restoration writes `rolled_back`; any
component failure writes `rollback_failed` with sanitized component errors. Manual
rollback uses the same v2 fields and ordering.

During deal-monitor recovery keep `TG_DEAL_MONITOR_ENABLED=false`, recreate only
`tg-bot-go`, and verify no deal worker or `concac` traffic remains before exposing
the gateway. Back up both SQLite databases, qualify and promote the immutable
images, adopt the gateway, and keep monitoring disabled until the directory-mounted
bot settings and `/dealstatus` pass their checks. Enable the monitor only after the
second deal-database backup; then observe the first 50 calls against the dedicated
key before allowing normal backlog draining.

### 6. Post-cutover log checks

After response identifiers exist and new logs advance, take another online backup.
Review the call-log counts, integrity status, and any orphaned artifacts using the
immutable ops image before making any cleanup decision. Do not delete records or
artifacts as a shortcut to readiness; unexplained integrity findings require a
separate reviewed recovery change.

### 8. Verify and drill rollback

Verify response_id/index, current advancing log timestamps, all 24 combos,
absence of x-preview, completion/streaming for all four aliases, mixed-case
two-turn tools, exact image/manifest identity, and zero restarts. Quantify 503
and upstream 400 rates from the repaired current window.

Then run rollback and promote the same candidate again:

    node --import tsx/esm scripts/ops/oracle-deploy.mjs rollback --host localhost
    node --import tsx/esm scripts/ops/oracle-deploy.mjs promote \
      --host localhost --image "$candidate" --ops-image "$ops_image" --sha "$sha"

Observe health and representative traffic after final promotion.

### 9. Final cleanup

Keep candidate, rollback, newest verified DB backups, /home/ubuntu/.omniroute,
and /home/ubuntu/OmniRoute-archive through the drill and observation window.
Remove the ops image only after recovery verification.

Audit /home/ubuntu/OmniRoute and /home/ubuntu/OmniRoute-archive before removing
old workdirs. Migrate the legacy .env and checksum private artifacts first.
Never broadly delete /home/ubuntu/.omniroute.

## Safety invariants

- Never print or commit credentials.
- Never replace production data with a canary copy.
- Never apply recovery before dry-run review and backup.
- Never prune before recovery.
- Never remove live or rollback images before the drill.
- Never push origin or bypass gates.
- Never recursively delete a data, repository, home, or archive root.

## Tier evidence and replay decision (2026-08-23)

The canonical economic pool manifest is version 4. The managed GPT-5.6 aliases now use
performance-specific pools: `gpt-5.6-luna`
uses `pool-luna` (free → Antigravity → credits → Codex), `gpt-5.6-terra` uses
`pool-terra` (Antigravity → credits → Sonnet-class free → Codex), and `gpt-5.6-sol`
uses the frontier `pool-sol-codex`. Claude aliases retain their existing semantic
pools. This preserves cheap fallbacks for Luna, balanced fallbacks for Terra, and
frontier-only behavior for Sol. Claude is explicitly modeled as four relative performance
bands — Haiku, Sonnet, Opus, and Fable — with pricing-structure pools underneath each band
(free, subscription, credits, or API). Claude Fable and GPT-5.6 Terra share the normalized
general-access top band; GPT-5.6 Sol is a separate explicit-access special model and is never
implicitly selected.

The utilization expansion is provider-scoped. NIMStats data is retained only for NVIDIA NIM
model identities (for example, Nemotron Super at composite score 73); equivalent model names
served by OpenRouter or OpenCode do not inherit that score. Additional recurring routes that
passed live catalog/probe checks are placed into Sonnet or Haiku pools according to observed
tool behavior and benchmark evidence.

Terra intentionally places the free pool after protocol-capable Antigravity and
credits targets. A live replay showed the first free Tencent target returning only
thinking content for a tool request, so making free the first Terra target would
regress mixed-case tool continuation despite a successful HTTP response.

The evidence ledger and tier replay details are maintained in the release-specific
routing documentation. Sources reviewed on 2026-08-23:

- OpenAI GPT-5.6 overview: https://openai.com/index/gpt-5-6/
- OpenAI price/performance update: https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/
- OpenAI Terra model card and rate limits: https://developers.openai.com/api/docs/models/gpt-5.6-terra
- Google Gemini 3.7 Flash model card benchmark table: https://deepmind.google/models/model-cards/gemini-3-7-flash/
- Anthropic Sonnet 5 research/pricing: https://www.anthropic.com/research/claude-sonnet-5
- Anthropic Opus pricing: https://www.anthropic.com/claude/opus

Oracle availability snapshot (safe aggregate only): 49 provider connections were
present, 46 active; Codex had 3 active connections, Antigravity 4, Gemini 7,
Command Code 3 active of 5, and AgentRouter 1. Quota snapshots are historical and
must be reduced to the latest window before changing weights; raw credentials and
quota payloads are never copied into the ledger.

Operational build decision: the effective Oracle BuildKit builder remains
`omniroute-safe-12g-4`, but its BuildKit container was raised to 18 GiB memory and
20 GiB memory+swap to finish the production image reliably; the historical builder
name was retained for compatibility. Cache was pruned to recover disk space.

Rollback root cause fixed: the remote Compose fingerprint now removes both
**OMNIROUTE_IMAGE** and `OMNIROUTE_BUILD_SHA` from the resolved `env_file` environment.
Previously only `OMNIROUTE_BUILD_SHA` was removed, so every image identity change
made the effective Compose hash differ and incorrectly blocked an immediate rollback.
