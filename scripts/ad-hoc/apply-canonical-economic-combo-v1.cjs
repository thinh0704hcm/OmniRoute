// Apply canonical economic combo pools. Make a durable backup before production use.
const fs = require("node:fs");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const dbPath = process.argv[2] || "/app/data/storage.sqlite";
if (!fs.existsSync(dbPath)) throw new Error(`SQLite database not found: ${dbPath}`);
const backupPath = `${dbPath}.before-canonical-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
const targets = {
  "pool-haiku-free": ["gemini/gemini-3.5-flash-lite", "groq/qwen/qwen3.6-27b", "nous-research/meituan/longcat-2.0:free", "nous-research/stepfun/step-3.7-flash:free", "openrouter/nvidia/nemotron-3.5-lightning:free", "cloudflare-ai/@cf/google/gemma-4-26b-a4b-it", "nvidia/nvidia/nemotron-3-super-120b-a12b", "openrouter/nvidia/nemotron-3-super-120b-a12b:free", "groq/openai/gpt-oss-120b", "nous-research/poolside/laguna-xs-2.1:free", "openrouter/poolside/laguna-xs-2.1:free", "openrouter/cohere/north-mini-code:free", "openrouter/dots-studio/dots-3-note-preview:free", "groq/openai/gpt-oss-20b", "openrouter/openai/gpt-oss-20b:free"],
  "pool-haiku-antigravity": ["antigravity/gemini-2.5-flash"],
  "pool-sonnet-free": ["nvidia/z-ai/glm-5.2", "nous-research/tencent/hy3:free", "nous-research/upstage/solar-pro4:free", "nous-research/poolside/laguna-s-2.1:free"],
  "pool-sonnet-antigravity": ["antigravity/gemini-3.6-flash-medium", "antigravity/claude-sonnet-4-6"],
  "pool-sonnet-credits": ["command-code/poolside/laguna-s-2.1-free"],
  "pool-opus-antigravity": ["antigravity/gemini-3.7-flash-tiered", "antigravity/claude-opus-4-6-thinking"],
  "pool-opus-credits": ["agentrouter/claude-opus-5"],
  "pool-opus-codex": ["codex/gpt-5.6-luna"],
  "pool-fable-antigravity": ["antigravity/gemini-3.7-flash-tiered", "antigravity/claude-opus-4-6-thinking"],
  "pool-fable-credits": ["agentrouter/claude-opus-5", "command-code/meta/muse-spark-1.2-contributor"],
  "pool-fable-codex": ["codex/gpt-5.6-terra"],
  "pool-fable-premium": ["codex/gpt-5.6-sol"],
};
const pools = { "pool-haiku": ["pool-haiku-free", "pool-haiku-antigravity"], "pool-sonnet": ["pool-sonnet-free", "pool-sonnet-antigravity", "pool-sonnet-credits"], "pool-opus": ["pool-opus-antigravity", "pool-opus-credits", "pool-opus-codex"], "pool-fable": ["pool-fable-antigravity", "pool-fable-credits", "pool-fable-codex"] };
const db = new Database(dbPath); const now = new Date().toISOString();
async function main() {
await db.backup(backupPath);
const rows = new Map(db.prepare("SELECT * FROM combos").all().map((r) => [r.name, r]));
const insert = db.prepare("INSERT INTO combos (id,name,data,sort_order,created_at,updated_at,context_cache_protection) VALUES (?,?,?,?,?,?,?)");
const update = db.prepare("UPDATE combos SET name=?,data=?,sort_order=?,updated_at=? WHERE id=?"); const remove = db.prepare("DELETE FROM combos WHERE id=?"); const obsolete = ["pool-haiku-paid", "pool-sonnet-paid", "pool-opus-free", "pool-opus-paid", "pool-fable-free", "pool-fable-paid"];
db.transaction(() => { for (const n of obsolete) if (rows.has(n)) remove.run(rows.get(n).id); let order = 0; const save = (name, data) => { const old = rows.get(name); const rowId = old?.id || crypto.randomUUID(); data.id = rowId; data.name = name; data.updatedAt = now; if (old) update.run(name, JSON.stringify(data), order++, now, rowId); else insert.run(rowId, name, JSON.stringify(data), order++, now, now, 0); };
  for (const [name, models] of Object.entries(targets)) save(name, { models: models.map((model, i) => ({ id: `canonical-${i}`, kind: "model", model, providerId: model.slice(0, model.indexOf("/")), weight: 0 })), strategy: name.endsWith("-codex") || name.endsWith("-premium") ? "priority" : "reset-aware" });
  for (const [name, refs] of Object.entries(pools)) save(name, { models: refs.map((comboName, i) => ({ id: `canonical-ref-${i}`, kind: "combo-ref", comboName, weight: 0 })), strategy: "priority" });
  for (const [name, comboName] of Object.entries({ "gpt-5.4-mini": "pool-haiku", "gpt-5.6-luna": "pool-opus", "gpt-5.6-terra": "pool-fable", "gpt-5.6-sol": "pool-fable-premium" })) {
    const old = rows.get(name); if (!old) continue; const data = JSON.parse(old.data); data.models = [{ id: `canonical-alias-${name}`, kind: "combo-ref", comboName, weight: 0 }]; data.strategy = "priority"; save(name, data);
  }
})(); db.close(); console.log(JSON.stringify({ dbPath, backupPath }, null, 2));
}
main().catch((error) => { try { db.close(); } catch {} console.error(error); process.exitCode = 1; });
