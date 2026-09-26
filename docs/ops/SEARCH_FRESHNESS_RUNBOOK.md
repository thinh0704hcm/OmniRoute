---
title: Search freshness runbook
---

# Search freshness runbook

Fresh search results need three things to line up: the right provider, a
`published_at` date on each hit, and (for SearXNG) an instance whose engines
return dates. This runbook covers all three.

## Recommended call shape

Deliberately not auto-select — auto-select lands on `ollama-search` (cheapest
non-fallback cost) whose 1000/mo quota dies silently with thin snippets:

```json
{
  "query": "latest AI model benchmark 2026",
  "providers": ["searxng-search", "tavily-search", "exa-search", "firecrawl"],
  "search_type": "news",
  "time_range": "week",
  "max_results": 5
}
```

- `providers` tries each leg in caller order under one shared 12s budget;
  first 2xx with ≥1 result wins, per-leg failures accumulate in `errors[]`.
  Mutually exclusive with `provider` (400 if both are set).
- `search_type: "news"` routes SearXNG to `categories=news` and per-provider
  news surfaces elsewhere.
- `time_range` (`hour|day|week|month|year`) flows to SearXNG (`?time_range=`),
  G-PSE, You.com, Linkup, and Nimble. Serper/Brave ignore it upstream.
- `backfill_dates: true` (default false) fills null `published_at` from
  result pages (`article:published_time` → OG → JSON-LD `datePublished` →
  `<time datetime>`), max 5 URLs inside the shared budget. Opt-in because it
  adds tail latency.

## SearXNG instance freshness (oracle-vps)

The instance runs out-of-band (not in `contrib/vps/compose*.yaml`) with stock
settings (`use_default_settings: true`), whose engine mix returns no date
fields. Enable date-returning engines:

```bash
ssh oracle-vps
# Append under the existing search: block in /home/ubuntu/searxng-settings.yml:
#   engines:
#     - name: bing news
#     - name: google news
docker restart searxng
curl -s 'http://localhost:8888/search?q=test&format=json' \
  | python3 -c "import json,sys; print(list(json.load(sys.stdin)['results'][0].keys()))"
```

Expect `publishedDate` (or `published_date`) among the keys. No compose or
`.env` change is involved, so the deployment manifest `compose-hash` is
unaffected. Verify through OmniRoute afterwards:

```bash
curl -s https://squrvq.tail0bec0f.ts.net/v1/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -d '{"query":"nvidia earnings","count":3,"provider":"searxng-search","search_type":"news","time_range":"week"}' \
  | python3 -c "import json,sys; [print(r.get('title','?')[:60],'|',r.get('published_at') or 'NO DATE') for r in json.load(sys.stdin)['results']]"
```

## Provider date coverage (verified 2026-09-07)

| Provider         | Date fields read                                                  | Live result                    |
| ---------------- | ----------------------------------------------------------------- | ------------------------------ |
| `exa-search`     | `publishedDate`, `published_date`, `date`                         | Real ISO dates                 |
| `tavily-search`  | `published_date`, `publishedDate`, `date`                         | Upstream dependent             |
| `searxng-search` | `publishedDate`, `published_date`, `published`, `date`, `updated` | Instance dependent (see above) |
| `firecrawl`      | `date`, `published_at`, `metadata.publishedTime`                  | Upstream dependent             |
| `ollama-search`  | Any common date key when present                                  | Usually null upstream          |

All dates normalize to canonical ISO-8601 via `normalizePublishedAt`
(`open-sse/handlers/search/publishedAt.ts`); unparseable values become null
rather than leaking garbage strings.

## Observability (wedge vs slow)

- Success responses carry `X-Search-Provider`, `X-Search-Cached`
  (`hit`/`miss`), `X-Search-Cost-Usd`, `X-Search-Upstream-Ms` headers, and
  `metrics.legs[]` (`{provider, ms, results, error?}`) for ordered chains.
- Rate-limited legs return `X-Quota-Remaining: 0` + `X-Quota-Provider`
  (plus the existing `Retry-After`) — an ollama 1000/mo exhaustion reads as
  an explicit quota signal, not silent thin results.
- Chat streams record `queueMs` (receipt→dispatch) and `upstreamTtfbMs`
  (dispatch→first upstream byte) in call logs next to `ttft`. Read:
  `upstream` large + no deltas = wedged upstream; `queue` large =
  gateway-side; both small = normal slow model.
- `effort: "none"` / `"low"` on `/v1/chat/completions` now survives to the
  upstream body (combo fan-out preserves it; ZAI/GLM floor and Codex
  `medium` fallback no longer resurrect reasoning over an explicit `none`).
  `Server-Timing` header emission is intentionally deferred — the marks are
  stamped (executor + stream transform) and land in call logs first.
