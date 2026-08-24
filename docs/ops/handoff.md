---
title: Oracle production repair handoff
---

# Oracle production repair handoff

Last updated: 2026-08-23

> Completion update (2026-08-23): production runs
> `omniroute:canary-4506bd9326-20260823` at image ID
> `sha256:cbfd94dcea5e0623163af2a505b2a2693557b3e92084be20a444dbd5d3535265`.
> The final candidate passed all four completions, streaming, all four mixed-case tool
> continuations, combo evidence, and advancing call-log gates. Rollback and re-promotion were
> live-tested after fixing the Compose fingerprint root cause. The Terra free-target tool
> regression was reproduced and corrected by ordering protocol-capable targets first.
> The authoritative final decisions and exact identifiers are in
> `docs/ops/ORACLE_VPS_OPERATIONS_KB.md`; that section supersedes the unfinished-state notes
> below. The BuildKit container now uses 18 GiB memory and 20 GiB memory+swap despite retaining
> its historical `omniroute-safe-12g-4` name.

## Authority and current state

Continue only on oracle-vps in /home/ubuntu/OmniRoute-src.

    branch: update/v3.8.50
    upstream remote: origin
    fork remote: fork
    upstream base: 6cd4d38e2

The Oracle working tree is clean at the canonical pushed commit. Develop on the workstation,
push `fork/update/v3.8.50`, synchronize Oracle, and verify there; do not deploy a dirty checkout.

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
  performance/quota-ordered tiers; unreviewed x-preview and invalid Haiku routes are gone.
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
    scripts/ops/reconcile-canonical-combos.mjs
    scripts/ops/recover-call-logs.mjs
    scripts/ops/prune-call-log-orphans.mjs
    src/lib/db/callLogRecovery.ts
    src/lib/db/canonicalEconomicCombos.ts
    src/lib/combos/canonicalEconomicPools.ts
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
    OMNIROUTE_WS_BIND_HOST=0.0.0.0
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

### 6. Recover logs

After response_id exists and new logs advance, take another online backup. Use:

    from: 2026-08-19T12:44:10.277Z
    through: <exact pre-fix cutover timestamp>

Dry-run in the immutable ops image:

    docker run --rm --network none --read-only \
      --tmpfs /tmp:size=64m,mode=1777 \
      --volume /home/ubuntu/.omniroute:/app/data \
      --workdir /app "$ops_image" \
      node --import tsx/esm scripts/ops/recover-call-logs.mjs \
      --db /app/data/storage.sqlite \
      --from 2026-08-19T12:44:10.277Z \
      --through '<exact pre-fix cutover timestamp>'

Review corrupt, invalid, checksumMismatches, and collisions. Repeat with --apply
only after backup and review. A final dry-run must report wouldInsert zero.

### 7. Prune residual orphans

Only after recovery, dry-run:

    docker run --rm --network none --read-only \
      --tmpfs /tmp:size=64m,mode=1777 \
      --volume /home/ubuntu/.omniroute:/app/data \
      --workdir /app "$ops_image" \
      node --import tsx/esm scripts/ops/prune-call-log-orphans.mjs \
      --db /app/data/storage.sqlite \
      --before '<exact pre-fix cutover timestamp>'

Do not apply with unexplained unsafe/corrupt/invalid entries. Apply by repeating
the command with:

    --apply --confirm-count <exact orphanCount> --confirm-bytes <exact orphanBytes>

The apply path rescans and revalidates inode, size, mtime, checksum, and DB
references before individual unlinks.

### 8. Verify and drill rollback

Verify response_id/index, current advancing log timestamps, all 24 combos,
absence of unreviewed x-preview routes, completion/streaming for all four aliases, mixed-case
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

## Decisions recorded after recovery

- Canonical branch: `update/v3.8.50`; Oracle has one checkout and the legacy workdir is archived.
- Effective builder: `omniroute-safe-12g-4`; BuildKit limits are 18 GiB memory / 20 GiB memory+swap.
- GPT-5.6 pools are now tiered by documented capability and economics: Luna → `pool-luna`,
  Terra → `pool-terra`, Sol → frontier-only `pool-sol-codex`. Terra orders
  Antigravity/credits before free targets because a live replay found the first Tencent
  free target did not emit a tool call.
- Claude uses four relative performance bands (Haiku, Sonnet, Opus, Fable), with free,
  subscription, credits, and API represented as child pricing pools. Fable and GPT-5.6 Terra
  share the normalized general-access top band; GPT-5.6 Sol is explicit-access and never
  selected implicitly.
- Utilization policy now admits more recurring healthy routes into the performance pools:
  OpenCode Mimo, Cloudflare Qwen Coder, Gemini 3 Flash, Mistral Devstral, and recurring
  Nemotron fallbacks. NIMStats scores are recorded as NVIDIA-only evidence; they are not
  copied onto OpenRouter, OpenCode, or other providers.
- Source URLs and deterministic scoring are recorded in `src/lib/combos/tierEvidence.ts`;
  replay with `node scripts/ops/replay-tier-evidence.mjs snapshot.json`.
- Focused regression coverage is in `tests/unit/tier-evidence-replay.test.ts`.
- Oracle aggregate availability at decision time: 46 active of 49 connections; Codex 3,
  Antigravity 4, Gemini 7, Command Code 3 active of 5, AgentRouter 1. Quota snapshots
  are not treated as current until reduced by latest window.
- Broad unit tests were deliberately not run; lint and focused tests are the required gate.
- Rollback fingerprint root cause fixed: Compose hashing now excludes both mutable
  **OMNIROUTE_IMAGE** and `OMNIROUTE_BUILD_SHA` values imported through `.env`; the
  previous implementation excluded only the build SHA and rejected valid immediate rollbacks.
