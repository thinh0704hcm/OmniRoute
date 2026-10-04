#!/usr/bin/env node
/**
 * probe-combo-models.mjs — live-probe every unique kind=model target referenced
 * by combos in a (production) OmniRoute SQLite DB.
 *
 * Read-only: never touches the DB beyond SELECT, never mutates combos.
 * Sends one tiny non-streaming chat completion per unique provider/model through
 * the running gateway and classifies each target as ok / broken / inconclusive.
 *
 * Usage:
 *   OMNIROUTE_SMOKE_API_KEY=sk-... node scripts/ad-hoc/probe-combo-models.mjs \
 *     [--db /home/ubuntu/.omniroute/storage.sqlite] \
 *     [--gateway http://127.0.0.1:20128] \
 *     [--out /tmp/combo-probe-results.json] [--delay-ms 2000] [--limit 0]
 *
 * Verdicts:
 *   ok           — HTTP 200 with non-empty choice text
 *   broken       — 4xx (except 429), repeated 5xx/timeout/network error
 *   inconclusive — 429 twice (rate-limited, not provably dead) or other transient
 */
import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";

const raw = process.argv.slice(2);
const args = {};
for (let i = 0; i < raw.length; i += 1) {
  const m = raw[i].match(/^--([^=]+)(?:=(.*))?$/);
  if (!m) continue;
  const key = m[1].replace(/-/g, "_");
  if (m[2] !== undefined) {
    args[key] = m[2];
  } else if (i + 1 < raw.length && !raw[i + 1].startsWith("--")) {
    args[key] = raw[i + 1];
    i += 1;
  } else {
    args[key] = "1";
  }
}

const DB = args.db ?? "/home/ubuntu/.omniroute/storage.sqlite";
const GATEWAY = args.gateway ?? "http://127.0.0.1:20131";
const OUT = args.out ?? "/tmp/combo-probe-results.json";
const DELAY_MS = Number(args.delay_ms ?? 2000);
const TIMEOUT_MS = 60000;
const LIMIT = Number(args.limit ?? 0);
const API_KEY = process.env.OMNIROUTE_SMOKE_API_KEY ?? "";

if (!API_KEY) {
  console.error("FATAL: OMNIROUTE_SMOKE_API_KEY env is required");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeOnce(model) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        // 64, not 8: reasoning models spend the first tokens thinking and would
        // otherwise hit finish_reason=length with empty content (false negative).
        max_tokens: 64,
        temperature: 0,
      }),
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - started;
    const status = res.status;
    let snippet = "";
    let text = "";
    try {
      const body = await res.json();
      snippet = JSON.stringify(body).slice(0, 300);
      text = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text ?? "";
    } catch {
      snippet = (await res.text().catch(() => "")).slice(0, 300);
    }
    return { status, snippet, text: String(text).slice(0, 120), latencyMs };
  } catch (err) {
    return {
      status: 0,
      snippet: `network/timeout: ${err?.name ?? "error"} ${err?.message ?? ""}`.slice(0, 300),
      text: "",
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(t);
  }
}

function classify(first, second) {
  // Returns { verdict, status, snippet } given up to two attempts.
  const attempts = second ? [first, second] : [first];
  const last = attempts[attempts.length - 1];
  if (last.status === 200 && last.text.trim().length > 0) {
    return { verdict: "ok", attempt: attempts.length };
  }
  if (last.status === 200) {
    return { verdict: "inconclusive", reason: "empty-200", attempt: attempts.length };
  }
  if (last.status === 429) {
    return {
      verdict: attempts.length > 1 ? "inconclusive" : "retry",
      reason: "rate-limited",
      attempt: attempts.length,
    };
  }
  if (last.status >= 400 && last.status < 500) {
    return { verdict: "broken", reason: `http-${last.status}`, attempt: attempts.length };
  }
  // 0 (network/timeout) or 5xx: retry once, then broken.
  if (attempts.length === 1)
    return {
      verdict: "retry",
      reason: last.status === 0 ? "timeout" : `http-${last.status}`,
      attempt: 1,
    };
  return {
    verdict: "broken",
    reason: last.status === 0 ? "timeout-x2" : `http-${last.status}-x2`,
    attempt: 2,
  };
}

const db = new Database(DB, { readonly: true });
const rows = db.prepare("SELECT id, name, data FROM combos ORDER BY sort_order").all();
db.close();

const uniq = new Map(); // "providerId\x00model" -> { providerId, model, usedBy: [] }
for (const r of rows) {
  const d = JSON.parse(r.data);
  for (const m of d.models ?? []) {
    if (m?.kind !== "model" || !m?.model) continue;
    const key = `${m.providerId ?? ""}\0${m.model}`;
    if (!uniq.has(key)) {
      uniq.set(key, { providerId: m.providerId ?? "", model: m.model, usedBy: [] });
    }
    uniq.get(key).usedBy.push(r.name);
  }
}

let entries = [...uniq.values()];
console.log(`combos=${rows.length} unique_model_targets=${entries.length}`);
if (LIMIT > 0) entries = entries.slice(0, LIMIT);

const results = [];
let n = 0;
for (const e of entries) {
  n += 1;
  const first = await probeOnce(e.model);
  let c = classify(first);
  let deciding = first;
  if (c.verdict === "retry") {
    await sleep(10000);
    deciding = await probeOnce(e.model);
    c = classify(first, deciding);
  }
  const rec = {
    providerId: e.providerId,
    model: e.model,
    verdict: c.verdict,
    reason: c.reason ?? "",
    httpStatus: deciding.status,
    snippet: deciding.snippet,
    text: deciding.text,
    usedBy: e.usedBy,
  };
  results.push(rec);
  console.log(
    `[${n}/${entries.length}] ${c.verdict.toUpperCase().padEnd(12)} ${e.model} (${c.reason ?? "ok"})`
  );
  await sleep(DELAY_MS);
}

writeFileSync(OUT, JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 1));
const tall = (v) => results.filter((r) => r.verdict === v).length;
console.log(
  `\nprobe done: ok=${tall("ok")} broken=${tall("broken")} inconclusive=${tall("inconclusive")} -> ${OUT}`
);
