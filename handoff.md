# Handoff: 503 on Vision Models (antigravity/claude-sonnet-4-6, antigravity-sonnet-vision)

## Summary
- **Deployment**: Successfully deployed `omniroute:cf-null-fix-20260820-prod-v1` via canary pipeline (§16)
- **Rollback**: Completed — prod now on `omniroute:rollback-canary` (sha `f66f258dfaff`)
- **Issue**: Vision models return 503 (unavailable) in replay gate; text models pass
- **Models affected**: `antigravity/claude-sonnet-4-6`, `antigravity-sonnet-vision`
- **Root cause**: Provider capability/config mismatch — vision models not enabled on antigravity connections

---

## Current Prod State

| Component | Status |
|-----------|--------|
| `omniroute-parallel` | Running on `omniroute:rollback-canary` (sha `f66f258dfaff`) |
| `omniroute-parallel-redis` | Healthy |
| Health endpoint | 200 |
| Streaming chat (`antigravity/gemini-2.5-flash-lite`) | 200 |
| Replay gate text cases | PASS (200) |
| Replay gate vision cases | FAIL (503) |

---

## Provider Connections (from DB)

Active antigravity connections:
| ID | Name | test_status | is_active |
|----|------|-------------|-----------|
| baa987de-... | xuanthinh2207@gmail.com | active | 1 |
| e82c9028-... | tranxuanthinh1357@gmail.com | active | 1 |
| 57effec2-... | thinh0704hcm@gmail.com | active | 1 |
| 0a5f9e32-... | thinh0704hcm@protonmail.com | active | 1 |

No `provider_models` or `model_capabilities` tables exist (checked via better-sqlite3). Model routing appears to be handled by provider-specific logic (e.g., `antigravity` provider maps internal model IDs to upstream).

---

## Replay Gate Configuration

```bash
TEXT_RAW_MODEL="antigravity/gemini-2.5-flash-lite"      # PASS (200)
IMAGE_RAW_MODEL="antigravity/claude-sonnet-4-6"         # FAIL (503)
TEXT_COMBO_MODEL="pool-sonnet"                          # PASS (200)
IMAGE_COMBO_MODEL="antigravity-sonnet-vision"           # FAIL (503)
```

The 503 occurs at the provider level — the `antigravity` provider doesn't have vision models configured/available for these connections.

---

## What to Investigate

1. **Antigravity provider model mapping** — Check `open-sse/executors/antigravity.ts` or similar for which models are supported per connection

2. **Model capability overrides** — Check `model_capability_overrides` table (exists) for vision model flags

3. **Provider config** — Each antigravity connection may need specific model enablement (e.g., `models` array in `provider_specific_data`)

4. **Combo routing** — The `pool-sonnet` text combo works; vision may need a different provider (e.g., `anthropic` direct)

---

## Quick Fix Options

### Option A: Update replay gate to use available models
Change `IMAGE_RAW_MODEL` / `IMAGE_COMBO_MODEL` to models that exist on active connections (e.g., `antigravity/gemini-2.5-flash` if it supports vision, or use `anthropic/claude-3.5-sonnet` if an Anthropic connection exists).

### Option B: Enable vision on antigravity connections
If the antigravity provider supports vision but needs per-connection opt-in, update `provider_specific_data` for the active connections to include vision models.

### Option C: Add Anthropic provider connection
Add a direct Anthropic connection with vision models enabled — more reliable for vision workloads.

---

## Commands for Debugging

```bash
# Check provider_specific_data for antigravity connections
docker run --rm -v /home/ubuntu/.omniroute:/data -w /data node:22-slim node -e "
const Database = require('better-sqlite3');
const db = new Database('storage.sqlite', { readonly: true });
const conns = db.prepare('SELECT id, provider, name, provider_specific_data FROM provider_connections WHERE provider=\"antigravity\"').all();
conns.forEach(c => console.log(c.id, c.name, c.provider_specific_data));
"

# Check model_capabilities table schema
docker run --rm -v /home/ubuntu/.omniroute:/data -w /data node:22-slim node -e "
const Database = require('better-sqlite3');
const db = new Database('storage.sqlite', { readonly: true });
const cols = db.prepare('PRAGMA table_info(model_capabilities)').all();
console.log(JSON.stringify(cols, null, 2));
"

# Check what models are in model_capability_overrides
docker run --rm -v /home/ubuntu/.omniroute:/data -w /data node:22-slim node -e "
const Database = require('better-sqlite3');
const db = new Database('storage.sqlite', { readonly: true });
const caps = db.prepare('SELECT * FROM model_capability_overrides LIMIT 20').all();
console.log(JSON.stringify(caps, null, 2));
"
```

---

## Files to Check in Repo

| File | Purpose |
|------|---------|
| `open-sse/executors/antigravity.ts` | Antigravity provider executor — model mapping |
| `open-sse/services/accountFallback.ts` | Model lockout logic |
| `open-sse/translator/` | Model name translation |
| `src/lib/db/providerConnections.ts` | Provider connection DB ops |
| `src/lib/db/modelCapabilities.ts` | Model capability DB ops |

---

## Next Steps

1. Run the debug commands above to understand current model mappings
2. Decide on fix strategy (A/B/C)
3. Apply fix to DB or provider config
4. Re-run replay gate to verify
5. Re-promote candidate if fix works

---

## Related
- KB §16: Canary deployment pipeline
- Replay gate: `scripts/ops/replay-gate.sh` (renamed from `bluegreen-replay-gate.sh`)
- PR #10811: Blue-green removal + KB sync