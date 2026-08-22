---
title: Oracle VPS operations knowledge base
---

# Oracle VPS operations knowledge base

Last updated: 2026-08-23

This is the canonical, durable runbook for OmniRoute production on `oracle-vps`. It covers
source ownership, validation, immutable builds, isolated canary qualification, promotion,
rollback, log recovery, artifact pruning, and cleanup. The incident snapshot below remains as
provenance for the August 2026 repair; update the live-state fields after every verified rollout.

## Verified repair outcome — 2026-08-23

- Canonical fork branch: `update/v3.8.50`; runtime source commit: `1cbcbcdc702437d5fb1881cf6564f5d13e6b6ca7`.
- Production image: `omniroute:canary-1cbcbcdc7-20260823`, image ID
  `sha256:54e1f509e4dacad520e7b55ad8eb5f6bf22385c464395b32d7c6765b798453f6`.
- Immediate rollback image ID:
  `sha256:75d4021de57fc4f6703e1439b0eb590afa237c0cab5f833f7379fe33851c46dc`.
- Production promotion, live rollback, and re-promotion all reached healthy status with zero
  restarts. All four public aliases returned HTTP 200; Luna, Terra, and Sol preserved the exact
  mixed-case tool name `GetTestValue`; Luna streaming produced SSE and `[DONE]`.
- Call-log recovery inserted 13,557 valid missing rows for
  `(2026-08-19T12:44:10.277Z, 2026-08-22T18:52:48.000Z]`, with zero corruption, invalid rows,
  checksum mismatches, collisions, or capacity skips. The repeat scan found 13,557 duplicates
  and zero inserts. Orphan inventory scanned 22,675 artifacts and found zero orphans.
- The integrity-checked pre-promotion backup is
  `/home/ubuntu/.omniroute/deployments/backups/storage_20260822T185248176348595Z_2285006_pre-promote.sqlite`.

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

The Oracle working tree has the complete repair and tests, formatted but not
committed or pushed. It had 66 changed/untracked paths at handoff. Do not restart
from the workstation checkout; it does not contain the final Oracle formatting.

Production has not been changed:

    container: omniroute-parallel
    image: omniroute:canary-6fe25f3dc-20260822
    image ID: sha256:75d4021de57fc4f6703e1439b0eb590afa237c0cab5f833f7379fe33851c46dc
    status: running, healthy, 0 restarts
    rollback tag: omniroute:rollback-canary
    rollback ID: sha256:f66f258dfaff7b6cd3987febf8a59d012afddfb69d1fb3aae7953cf9760298e8

Pre-deploy database evidence:

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
