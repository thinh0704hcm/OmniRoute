---
title: Muse compat runbook
---

# Muse compat runbook

`muse` (Meta's CLI) talks to this gateway through the `/muse-code`
surface, which proxies Spark inference to the opencode Go backend
(`opencode-go` provider → `https://opencode.ai/zen/go/v1/responses`).
Verified live: direct-zen probe returns HTTP 200 for
`muse-spark-1.3-contributor`, and `muse` completed searches through the
same request shape.

## Request path

```
muse
 └─ GET  /muse-code/models    model catalog (MSP metadata)
 ├─ POST /muse-code/search    web search (same pipeline as /v1/search)
 └─ POST /v1/responses        inference; bare Spark ids rewritten to
                              opencode-go/<id> when registered, and a
                              stable x-opencode-session is pinned when
                              the client sends none
```

## Model ids and effort tiers

- Base id: `muse-spark-1.3-contributor` (also `muse-spark-1.3`, `muse-spark-1.1`).
- Effort tiers append a suffix: `-minimal`, `-low`, `-medium`, `-high`,
  `-xhigh`. The suffix is stripped before the upstream call and sent as
  the reasoning field instead.
- Bare ids (no `provider/` prefix) are resolved against the registry;
  anything already prefixed, `auto`, or a combo name passes through
  untouched.

## Session pinning (required)

Direct zen calls **without** `x-opencode-session` fail closed:

```json
{"type":"error","error":{"type":"MissingSessionID","message":"Request is missing x-opencode-session and cannot be routed efficiently. Please see https://opencode.ai/docs/go/#where-can-i-use-it"}}
```

When `muse` sends no session, the gateway derives a stable one from the
request's `prompt_cache_key` (the embedded session uuid) plus the
workspace root, so retries in the same session route to the same
upstream session. Clients that manage their own sessions are
unaffected — an explicit `x-opencode-session` header always wins.

## Headers

Send a real client `User-Agent` (e.g. `pi/1.0.1`). Generic library
defaults such as `Python-urllib/*` trip the upstream abuse wall and
return HTML 403s even with valid auth.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `400 MissingSessionID` | no `x-opencode-session` | let the gateway pin one, or send your own |
| HTML `403` on valid key | generic `User-Agent` | send a real client UA string |
| `muse` lists no Spark models | catalog missing `metadata["muse-code"]` | `GET /muse-code/models` must include it for Spark ids |
| search returns `{results: []}` | provider miss, not a shape error | retry; per-leg failures accumulate in `errors[]` |
| bare id not rewritten | model not registered under `opencode-go` | check the opencode/go registry for the id |

## Code map

- `open-sse/handlers/museCode.ts` — Spark id set, session derivation,
  catalog builder, search-shape mapper
- `src/app/api/internal/muse-code/modelResolution.ts` — bare-id rewrite
- `src/app/api/v1/muse-code/models/route.ts` — catalog (+ MSP metadata)
- `src/app/api/v1/muse-code/search/route.ts` — search wrapper
- `src/app/api/v1/responses/route.ts` — rewrite + session pinning hook

## Build note (2026-10-05): dashboard webpack OOMs at default heap

`docker buildx build` of this branch OOMs (`FATAL ERROR: Ineffective
mark-compacts near heap limit`) during `npm run build` with the Dockerfile
default `ARG OMNIROUTE_BUILD_MEMORY_MB=6144`. Rebuild with
`--build-arg OMNIROUTE_BUILD_MEMORY_MB=8192` (host had 23 GB; safe there).
Also note the revision label requires the exact arg name
`OMNIROUTE_BUILD_SHA` — `BUILD_SHA` is silently ignored and qualify then
fails closed on the empty `org.opencontainers.image.revision` label.
