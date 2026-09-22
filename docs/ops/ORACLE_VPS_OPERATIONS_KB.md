---
title: Oracle VPS operations
---

# Oracle VPS operations

This runbook covers the maintained `squrvq` deployment path on `oracle-vps`. It intentionally
contains only the current canary, promotion, verification, and rollback contract. Incident
snapshots, release-specific SHAs, routing-tier evidence, and historical cleanup procedures do not
belong here.

## Maintained components

- `contrib/vps/compose.oracle.yaml`: production overlay for OmniRoute, Redis, and `ts-gateway`.
- `contrib/vps/compose.canary.yaml`: isolated application and Redis qualification overlay.
- `scripts/ops/oracle-deploy.mjs`: trusted-workstation CLI and traffic probes.
- `scripts/ops/oracleDeploy.ts`: fail-closed promotion and rollback transaction.
- `scripts/ops/oracle-deploy-remote.sh`: fixed-action remote Docker and backup adapter.

The production origin is `https://squrvq.tail0bec0f.ts.net`; LiveWS uses
`wss://squrvq.tail0bec0f.ts.net/live-ws`. The gateway routes API traffic to port `20131`, health
traffic to dashboard port `20130`, and LiveWS to port `20133`. Redis remains loopback-only.

## Prerequisites

Work from a clean checkout of the exact commit being built. Copy `contrib/vps/.env.example` to the
ignored `contrib/vps/.env`, preserve existing secrets, set mode `0600`, and set immutable image and
build-SHA values. Never print or commit the environment file.

Compose 2.24.4 or newer is required for `!override`. The remote source checkout is
`/home/ubuntu/OmniRoute-src`, and the SSH alias defaults to `oracle-vps`.

Validate the resolved production configuration before building:

```bash
cd /home/ubuntu/OmniRoute-src
docker compose --project-name omniroute \
  --project-directory contrib/vps \
  --env-file contrib/vps/.env \
  --file contrib/vps/compose.yaml \
  --file contrib/vps/compose.oracle.yaml config --quiet
```

## Build immutable images

The candidate image must carry its commit in the OCI `org.opencontainers.image.revision` label.
Floating tags such as `latest`, `next`, `main`, and `stable` are rejected.

```bash
cd /home/ubuntu/OmniRoute-src
sha="$(git rev-parse --short=10 HEAD)"
date_tag="$(date -u +%Y%m%d)"
candidate="omniroute:canary-$sha-$date_tag"
docker buildx build --target runner-base --build-arg "OMNIROUTE_BUILD_SHA=$sha" \
  --label "org.opencontainers.image.revision=$sha" \
  --tag "$candidate" --load .
```

The `--label` flag carries the commit even when the `Dockerfile` does not declare the
`revision` label (an upstream merge-sync has dropped those lines before); `qualify`
fails closed when the label is missing or mismatched.

## Inspect and qualify

`status` is read-only. `qualify` creates an isolated canary from a WAL-consistent data copy, runs
the local gates, stops the canary, and deletes the copied canary data. Load
`OMNIROUTE_SMOKE_API_KEY` securely without echoing it.

```bash
cd /home/ubuntu/OmniRoute-src
node --import tsx/esm scripts/ops/oracle-deploy.mjs status --host oracle-vps
node --import tsx/esm scripts/ops/oracle-deploy.mjs qualify --host oracle-vps \
  --image "$candidate" --sha "$sha"
```

Qualification fails closed unless the container identity, image ID, build SHA, health, resource
limits, restart/OOM state, dashboard, authenticated model catalog, completion, streaming, combo,
call-log, and LiveWS probes all pass. The canary never shares production Redis, network identity,
or mutable data.

## Promote

Promotion performs a fresh qualification, then acquires the production lock and records all
rollback anchors before cutover: SQLite backup, environment backup and hash, gateway state, prior
application image ID, prior gateway image, and effective Compose hash. It writes a schema-v2
`pending` manifest before mutation and marks it `active` only after local and public gates pass.

```bash
cd /home/ubuntu/OmniRoute-src
node --import tsx/esm scripts/ops/oracle-deploy.mjs promote --host oracle-vps \
  --image "$candidate" --sha "$sha"
```

Public verification requires `/healthz` 200, unauthenticated `/v1/models` 401, authenticated
`/v1/models` 200 with all smoke models, a non-empty completion, and an authorized LiveWS welcome.
Do not manually replace the production container when a gate fails.

## Rollback

Automatic rollback restores the gateway, environment, and prior application image, then verifies
image identity and health. Any incomplete restoration records `rollback_failed` with sanitized
component failures. Manual rollback accepts only a complete active schema-v2 manifest whose image
and Compose identities still match.

```bash
cd /home/ubuntu/OmniRoute-src
node --import tsx/esm scripts/ops/oracle-deploy.mjs rollback --host oracle-vps
```

Rollback to the previous known-good image through this command only. Keep the current, candidate,
and rollback images plus their backups until a rollback drill and observation window complete.

## Backup retention

`prune-backups` keeps the manifest-referenced SQLite, gateway, and config anchors plus the
newest `N` entries (default `5`) and deletes only `storage_*_pre-promote.sqlite` files and
`gateway_*` / `config_*` directories inside the deployments state dir. Legacy one-off
`storage.sqlite.pre-*` files are expired only when older than 7 days and never
manifest-referenced; recent (<7d) legacy files are kept. It prints `BEFORE` and
`AFTER` listings (including `legacy=` counts) and fails closed if a manifest anchor is missing
after the run.

```bash
cd /home/ubuntu/OmniRoute-src
node --import tsx/esm scripts/ops/oracle-deploy.mjs prune-backups --host oracle-vps --keep 5
# or directly: ssh oracle-vps bash /home/ubuntu/OmniRoute-src/scripts/ops/oracle-deploy-remote.sh prune-backups 5
```

Retention is auto-enforced best-effort after every verified promotion (`active` manifest):
`promote` runs `prune-backups` with `--keep 5` (or `--keep N`) after success; prune failure is
logged as skipped and never fails the promotion. Manual `prune-backups` remains for ad-hoc runs.
Never delete the manifest-referenced anchors, live or rollback images, or any path outside the
deployments dir.

## Safety invariants

- Never print, log, or commit credentials.
- Never deploy from a dirty checkout or a floating image tag.
- Never replace production data with the canary copy.
- Never remove live or rollback images before verification.
- Never clear a deployment lock until the owning process and container state are understood.
- Never delete repository, data, backup, archive, or home-directory roots recursively.
- Push fork branches only; do not push deployment changes to the upstream remote.
