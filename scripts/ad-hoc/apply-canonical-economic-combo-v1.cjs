// Apply canonical v1 economic combo layout to an OmniRoute SQLite database.
// Usage: node scripts/ad-hoc/apply-canonical-economic-combo-v1.cjs /path/storage.sqlite
const Database = require("better-sqlite3");

const db = new Database(process.argv[2] || "/app/data/storage.sqlite");
const rows = db.prepare("SELECT id,name,data FROM combos WHERE name LIKE 'pool-%'").all();
const byName = new Map(rows.map((row) => [row.name, row]));

const pools = {
  "pool-haiku": ["pool-haiku-free", "pool-haiku-antigravity", "pool-haiku-credits"],
  "pool-sonnet": ["pool-sonnet-free", "pool-sonnet-antigravity", "pool-sonnet-credits"],
  "pool-opus": ["pool-opus-antigravity", "pool-opus-credits", "pool-opus-codex"],
  "pool-fable": ["pool-fable-antigravity", "pool-fable-credits", "pool-fable-codex"],
};

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
};

const now = new Date().toISOString();
const tx = db.transaction(() => {
  for (const [name, list] of Object.entries(targets)) {
    const row = byName.get(name);
    if (!row) continue;
    const data = JSON.parse(row.data);
    data.models = list.map((model, i) => ({ id: `canonical-${i}`, kind: "model", model, providerId: model.slice(0, model.indexOf("/")), weight: 0 }));
    // Quota-aware ordering within each economic class balances headroom,
    // reset pressure, and equivalent-target rotation.
    data.strategy = name.endsWith("-codex") ? "priority" : "reset-aware";
    data.updatedAt = now;
    db.prepare("UPDATE combos SET data=?, updated_at=? WHERE id=?").run(JSON.stringify(data), now, row.id);
  }
  for (const [name, suffixes] of Object.entries(pools)) {
    const row = byName.get(name);
    if (!row) continue;
    const data = JSON.parse(row.data);
    data.models = suffixes.filter((suffix) => targets[suffix]?.length).map((comboName, i) => ({ id: `canonical-ref-${i}`, kind: "combo-ref", comboName, weight: 0 }));
    data.strategy = "priority";
    data.updatedAt = now;
    db.prepare("UPDATE combos SET data=?, updated_at=? WHERE id=?").run(JSON.stringify(data), now, row.id);
  }
});
tx();
