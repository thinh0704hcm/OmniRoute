#!/usr/bin/env node
/**
 * prune-combo-models.mjs — remove probe-broken model targets from live combos.
 *
 * Reads probe-combo-models.mjs results, computes per-combo removals, and
 * applies them through PUT /api/combos/[id] (service layer, cache-consistent).
 *
 * Dry-run by default. Pass --apply to mutate.
 *
 * Usage:
 *   OMNIROUTE_SMOKE_API_KEY=sk-... node scripts/ad-hoc/prune-combo-models.mjs \
 *     --results /tmp/combo-probe-full.json \
 *     [--mgmt http://127.0.0.1:20130] [--apply] [--plan-out /tmp/combo-prune-plan.json]
 *
 * Safety:
 *   - combos that would be left with zero models are SKIPPED (PUT refuses empty
 *     lists) and reported as NEEDS-ATTENTION.
 *   - quota-share combos (PUT 409) are skipped and reported.
 *   - combo-ref entries pointing at non-existent combos are removed; refs to
 *     existing combos are kept even if that combo is degraded.
 */
import { readFileSync, writeFileSync } from "node:fs";

const raw = process.argv.slice(2);
const args = {};
for (let i = 0; i < raw.length; i += 1) {
  const m = raw[i].match(/^--([^=]+)(?:=(.*))?$/);
  if (!m) continue;
  const key = m[1].replace(/-/g, "_");
  if (m[2] !== undefined) args[key] = m[2];
  else if (i + 1 < raw.length && !raw[i + 1].startsWith("--")) {
    args[key] = raw[i + 1];
    i += 1;
  } else args[key] = "1";
}

const RESULTS = args.results ?? "/tmp/combo-probe-full.json";
const MGMT = args.mgmt ?? "http://127.0.0.1:20130";
const APPLY = args.apply === "1" || args.apply === "true";
const KEEP = new Set(
  (args.keep_models ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const PLAN_OUT = args.plan_out ?? "/tmp/combo-prune-plan.json";
const API_KEY = process.env.OMNIROUTE_SMOKE_API_KEY ?? "";
if (!API_KEY) {
  console.error("FATAL: OMNIROUTE_SMOKE_API_KEY env is required");
  process.exit(2);
}

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${API_KEY}`,
};

const probe = JSON.parse(readFileSync(RESULTS, "utf8"));
const brokenModels = new Set(
  probe.results.filter((r) => r.verdict === "broken" && !KEEP.has(r.model)).map((r) => r.model)
);
if (KEEP.size > 0) console.log(`force-kept (transient, not pruned): ${[...KEEP].join(", ")}`);
console.log(`broken model targets: ${brokenModels.size}`);

const comboRes = await fetch(`${MGMT}/api/combos`, { headers });
if (!comboRes.ok) {
  console.error(`FATAL: GET /api/combos -> ${comboRes.status}`);
  process.exit(2);
}
const { combos } = await comboRes.json();
const names = new Set(combos.map((c) => c.name));

const plan = [];
for (const c of combos) {
  const kept = [];
  const removed = [];
  for (const m of c.models ?? []) {
    if (m?.kind === "model" && brokenModels.has(m.model)) {
      removed.push(m);
    } else if (m?.kind === "combo-ref" && m.comboName && !names.has(m.comboName)) {
      removed.push({ ...m, _pruneReason: "dangling-combo-ref" });
    } else {
      kept.push(m);
    }
  }
  if (removed.length === 0) continue;
  plan.push({
    id: c.id,
    name: c.name,
    strategy: c.strategy,
    before: (c.models ?? []).length,
    after: kept.length,
    removed: removed.map((m) => ({
      kind: m.kind,
      model: m.model ?? null,
      comboName: m.comboName ?? null,
      providerId: m.providerId ?? null,
      reason: m._pruneReason ?? "probe-broken",
    })),
    kept,
    skipped: kept.length === 0 ? "would-empty-combo" : null,
  });
}

const actionable = plan.filter((p) => !p.skipped);
const skipped = plan.filter((p) => p.skipped);
console.log(
  `combos touched: ${plan.length} (actionable=${actionable.length}, skipped-empty=${skipped.length})`
);
for (const p of plan) {
  console.log(
    `${p.skipped ? "SKIP " : "PRUNE"} ${p.name}: ${p.before} -> ${p.after} ` +
      `removed=[${p.removed.map((r) => r.model ?? r.comboName).join(", ")}]` +
      (p.skipped ? ` (${p.skipped})` : "")
  );
}
writeFileSync(
  PLAN_OUT,
  JSON.stringify({ plannedAt: new Date().toISOString(), apply: APPLY, plan }, null, 1)
);

if (!APPLY) {
  console.log(`\ndry-run only. plan -> ${PLAN_OUT}. re-run with --apply to mutate.`);
  process.exit(0);
}

let okCount = 0;
for (const p of actionable) {
  const res = await fetch(`${MGMT}/api/combos/${p.id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ models: p.kept }),
  });
  const body = await res.text();
  if (!res.ok) {
    console.log(`FAIL ${p.name}: HTTP ${res.status} ${body.slice(0, 200)}`);
    p.applyResult = `http-${res.status}`;
    continue;
  }
  // Confirm persisted state.
  const verify = await fetch(`${MGMT}/api/combos/${p.id}`, { headers });
  const vbody = await verify.json();
  const vcount = (vbody?.models ?? vbody?.combo?.models ?? []).length;
  const confirmed = vcount === p.after;
  console.log(`${confirmed ? "OK  " : "MISMATCH"} ${p.name}: now ${vcount} models`);
  p.applyResult = confirmed ? "ok" : `mismatch-${vcount}`;
  if (confirmed) okCount += 1;
}
writeFileSync(
  PLAN_OUT,
  JSON.stringify({ plannedAt: new Date().toISOString(), apply: true, plan }, null, 1)
);
console.log(`\napplied ${okCount}/${actionable.length}. plan -> ${PLAN_OUT}`);
if (skipped.length > 0) {
  console.log(`NEEDS-ATTENTION (left untouched): ${skipped.map((s) => s.name).join(", ")}`);
}
