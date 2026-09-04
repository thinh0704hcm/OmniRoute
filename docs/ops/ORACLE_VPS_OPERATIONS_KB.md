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

The candidate and ops image must be built from the same clean commit and carry that commit in the
OCI `org.opencontainers.image.revision` label. Floating tags such as `latest`, `next`, `main`, and
`stable` are rejected.

```bash
cd /home/ubuntu/OmniRoute-src
sha="$(git rev-parse --short=10 HEAD)"
date_tag="$(date -u +%Y%m%d)"
candidate="omniroute:canary-$sha-$date_tag"
ops_image="omniroute:ops-$sha-$date_tag"
docker buildx build --target runner-base --build-arg "OMNIROUTE_BUILD_SHA=$sha" \
  --tag "$candidate" --load .
docker buildx build --target ops --build-arg "OMNIROUTE_BUILD_SHA=$sha" \
  --tag "$ops_image" --load .
```

## Inspect and qualify

`status` is read-only. `qualify` creates an isolated canary from a WAL-consistent data copy, runs
the local gates, stops the canary, and deletes the copied canary data. Load
`OMNIROUTE_SMOKE_API_KEY` securely without echoing it.

```bash
cd /home/ubuntu/OmniRoute-src
node --import tsx/esm scripts/ops/oracle-deploy.mjs status --host oracle-vps
node --import tsx/esm scripts/ops/oracle-deploy.mjs qualify --host oracle-vps \
  --image "$candidate" --ops-image "$ops_image" --sha "$sha"
```

Qualification fails closed unless the container identity, image ID, build SHA, health, resource
limits, restart/OOM state, dashboard, authenticated model catalog, completion, streaming, combo,
call-log, mixed-case tool, and LiveWS probes all pass. The canary never shares production Redis,
network identity, or mutable data.

## Promote

Promotion performs a fresh qualification, then acquires the production lock and records all
rollback anchors before cutover: SQLite backup, environment backup and hash, gateway state, prior
application image ID, prior gateway image, and effective Compose hash. It writes a schema-v2
`pending` manifest before mutation and marks it `active` only after local and public gates pass.

```bash
cd /home/ubuntu/OmniRoute-src
node --import tsx/esm scripts/ops/oracle-deploy.mjs promote --host oracle-vps \
  --image "$candidate" --ops-image "$ops_image" --sha "$sha"
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

## Safety invariants

- Never print, log, or commit credentials.
- Never deploy from a dirty checkout or a floating image tag.
- Never replace production data with the canary copy.
- Never remove live or rollback images before verification.
- Never clear a deployment lock until the owning process and container state are understood.
- Never delete repository, data, backup, archive, or home-directory roots recursively.
- Push fork branches only; do not push deployment changes to the upstream remote.
