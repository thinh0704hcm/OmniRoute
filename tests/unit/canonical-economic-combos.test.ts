import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import Database from "better-sqlite3";

import {
  CANONICAL_COMBO_MANAGER,
  CANONICAL_COMBO_VERSION,
  getCanonicalComboManifest,
  planCanonicalComboReconciliation,
  validateCanonicalComboManifest,
} from "../../src/lib/combos/canonicalEconomicPools.ts";
import { reconcileCanonicalComboDatabase } from "../../src/lib/db/canonicalEconomicCombos.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-canonical-combos-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
process.env.DATA_DIR = TEST_DATA_DIR;

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { registerQuotaFetcher } = await import("../../open-sse/services/quotaPreflight.ts");

after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
});

type ComboStep = {
  id: string;
  kind: "model" | "combo-ref";
  model?: string;
  providerId?: string;
  connectionId?: string;
  comboName?: string;
  weight: number;
};

type CanonicalCombo = {
  name: string;
  strategy: string;
  models: ComboStep[];
  config: Record<string, unknown>;
};

function manifestCombos(): CanonicalCombo[] {
  return getCanonicalComboManifest().combos as CanonicalCombo[];
}

function findCombo(combos: CanonicalCombo[], name: string): CanonicalCombo {
  const combo = combos.find((entry) => entry.name === name);
  assert.ok(combo, `missing combo ${name}`);
  return combo;
}

function modelNames(combo: CanonicalCombo): string[] {
  return combo.models
    .map((step) => step.model)
    .filter((model): model is string => typeof model === "string");
}

function comboReferences(combo: CanonicalCombo): string[] {
  return combo.models
    .map((step) => step.comboName)
    .filter((name): name is string => typeof name === "string");
}

function makeLog() {
  return {
    info() {},
    warn() {},
    debug() {},
    error() {},
  };
}

function okResponse(model: string) {
  return Response.json({ choices: [{ message: { role: "assistant", content: model } }] });
}

function errorResponse(status = 503) {
  return Response.json({ error: { message: "upstream unavailable" } }, { status });
}

test("canonical manifest locks exact aliases, economic tiers, and forbidden exclusions", () => {
  const manifest = getCanonicalComboManifest();
  const validation = validateCanonicalComboManifest(manifest);
  assert.deepEqual(validation, { ok: true, errors: [] });
  assert.equal(manifest.manager, CANONICAL_COMBO_MANAGER);
  assert.equal(manifest.version, CANONICAL_COMBO_VERSION);

  const combos = manifest.combos as CanonicalCombo[];
  const expectedAliases = new Map([
    ["gpt-5.4-mini", "pool-haiku"],
    ["gpt-5.6-luna", "pool-opus"],
    ["gpt-5.6-terra", "pool-fable"],
    ["gpt-5.6-sol", "pool-fable-premium"],
    ["claude-haiku-4-5-20251001", "pool-haiku"],
    ["claude-sonnet-5", "pool-sonnet"],
    ["claude-opus-5", "pool-opus"],
    ["claude-fable-5", "pool-fable"],
  ]);
  for (const [alias, parent] of expectedAliases) {
    const combo = findCombo(combos, alias);
    assert.equal(combo.strategy, "priority");
    assert.deepEqual(comboReferences(combo), [parent]);
    assert.equal(combo.config.nestedComboMode, "execute");
    assert.equal(combo.config.maxRetries, 0);
  }

  assert.deepEqual(comboReferences(findCombo(combos, "pool-haiku")), [
    "pool-haiku-free",
    "pool-haiku-antigravity",
  ]);
  assert.deepEqual(comboReferences(findCombo(combos, "pool-sonnet")), [
    "pool-sonnet-free",
    "pool-sonnet-antigravity",
    "pool-sonnet-credits",
  ]);
  assert.deepEqual(comboReferences(findCombo(combos, "pool-opus")), [
    "pool-opus-antigravity",
    "pool-opus-credits",
    "pool-opus-codex",
  ]);
  assert.deepEqual(comboReferences(findCombo(combos, "pool-fable")), [
    "pool-fable-antigravity",
    "pool-fable-credits",
    "pool-fable-codex",
  ]);

  const expectedLeaves = new Map<string, { strategy: string; models: string[] }>([
    [
      "pool-haiku-free",
      {
        strategy: "reset-aware",
        models: [
          "gemini/gemini-3.5-flash-lite",
          "groq/qwen/qwen3.6-27b",
          "nous-research/meituan/longcat-2.0:free",
          "nous-research/stepfun/step-3.7-flash:free",
          "openrouter/nvidia/nemotron-3.5-lightning:free",
          "cloudflare-ai/@cf/google/gemma-4-26b-a4b-it",
          "nvidia/nvidia/nemotron-3-super-120b-a12b",
          "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
          "groq/openai/gpt-oss-120b",
          "nous-research/poolside/laguna-xs-2.1:free",
          "openrouter/poolside/laguna-xs-2.1:free",
          "groq/openai/gpt-oss-20b",
          "openrouter/openai/gpt-oss-20b:free",
        ],
      },
    ],
    [
      "pool-haiku-antigravity",
      { strategy: "reset-aware", models: ["antigravity/gemini-2.5-flash"] },
    ],
    [
      "pool-sonnet-free",
      {
        strategy: "reset-aware",
        models: [
          "nvidia/z-ai/glm-5.2",
          "nous-research/tencent/hy3:free",
          "nous-research/upstage/solar-pro4:free",
          "nous-research/poolside/laguna-s-2.1:free",
        ],
      },
    ],
    [
      "pool-sonnet-antigravity",
      {
        strategy: "reset-aware",
        models: ["antigravity/gemini-3.6-flash-medium", "antigravity/claude-sonnet-4-6"],
      },
    ],
    [
      "pool-sonnet-credits",
      { strategy: "reset-aware", models: ["command-code/poolside/laguna-s-2.1-free"] },
    ],
    [
      "pool-opus-antigravity",
      {
        strategy: "reset-aware",
        models: ["antigravity/gemini-3.7-flash-tiered", "antigravity/claude-opus-4-6-thinking"],
      },
    ],
    ["pool-opus-credits", { strategy: "reset-aware", models: ["agentrouter/claude-opus-5"] }],
    ["pool-opus-codex", { strategy: "priority", models: ["codex/gpt-5.6-luna"] }],
    [
      "pool-fable-antigravity",
      {
        strategy: "reset-aware",
        models: ["antigravity/gemini-3.7-flash-tiered", "antigravity/claude-opus-4-6-thinking"],
      },
    ],
    [
      "pool-fable-credits",
      {
        strategy: "reset-aware",
        models: ["agentrouter/claude-opus-5", "command-code/meta/muse-spark-1.2-contributor"],
      },
    ],
    ["pool-fable-codex", { strategy: "priority", models: ["codex/gpt-5.6-terra"] }],
    ["pool-fable-premium", { strategy: "priority", models: ["codex/gpt-5.6-sol"] }],
  ]);
  for (const [name, expected] of expectedLeaves) {
    const combo = findCombo(combos, name);
    assert.equal(combo.strategy, expected.strategy, name);
    assert.deepEqual(modelNames(combo), expected.models, name);
  }
  assert.deepEqual(manifest.obsoleteNames, [
    "pool-haiku-paid",
    "pool-sonnet-paid",
    "pool-opus-free",
    "pool-opus-paid",
    "pool-fable-free",
    "pool-fable-paid",
  ]);
  assert.equal(
    combos.some((combo) => modelNames(combo).some((model) => /x-preview/i.test(model))),
    false
  );
  assert.equal(
    modelNames(findCombo(combos, "pool-haiku-free")).includes(
      "openrouter/cohere/north-mini-code:free"
    ),
    false
  );
  assert.equal(
    modelNames(findCombo(combos, "pool-haiku-free")).includes(
      "openrouter/dots-studio/dots-3-note-preview:free"
    ),
    false
  );
});

test("planner requires reviewed adoption, preserves unrelated fields, and becomes idempotent", () => {
  const existing = {
    id: "operator-stable-id",
    name: "pool-opus",
    strategy: "priority",
    models: ["opencode-zen/x-preview-f-free"],
    config: { customOperatorSetting: true },
    description: "keep this",
    sortOrder: 7,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };
  const refused = planCanonicalComboReconciliation([existing], {
    now: "2026-08-22T00:00:00.000Z",
  });
  assert.deepEqual(refused.conflicts, [
    { name: "pool-opus", action: "update", reason: "requires --adopt" },
  ]);

  const adopted = planCanonicalComboReconciliation([existing], {
    adopt: true,
    now: "2026-08-22T00:00:00.000Z",
  });
  const update = adopted.operations.find(
    (operation: { action: string; name: string }) =>
      operation.action === "update" && operation.name === "pool-opus"
  );
  assert.ok(update);
  const updated = update.combo as typeof existing & {
    config: Record<string, unknown>;
    schemaVersion: number;
  };
  assert.equal(updated.id, existing.id);
  assert.equal(updated.createdAt, existing.createdAt);
  assert.equal(updated.sortOrder, existing.sortOrder);
  assert.equal(updated.description, existing.description);
  assert.equal(updated.config.customOperatorSetting, true);
  assert.equal(updated.config._managedBy, CANONICAL_COMBO_MANAGER);
  assert.equal(updated.config._managedVersion, CANONICAL_COMBO_VERSION);

  const fullyApplied = adopted.operations
    .filter((operation: { action: string }) => operation.action !== "delete")
    .map((operation: { combo: CanonicalCombo }) => operation.combo);
  const second = planCanonicalComboReconciliation(fullyApplied, {
    now: "2026-08-23T00:00:00.000Z",
  });
  assert.deepEqual(second.operations, []);
  assert.deepEqual(second.conflicts, []);
  assert.equal(second.drift, false);
});

test("nested alias executes the child reset-aware strategy instead of flattening it", async () => {
  const combos = manifestCombos();
  const child = findCombo(combos, "pool-opus-antigravity");
  child.models = child.models.map((step, index) => ({
    ...step,
    connectionId: index === 0 ? "stored-first" : "quota-first",
  }));
  registerQuotaFetcher("antigravity", async (connectionId: string) => ({
    used: connectionId === "quota-first" ? 75 : 10,
    total: 100,
    percentUsed: connectionId === "quota-first" ? 0.75 : 0.1,
    resetAt: new Date(
      Date.now() + (connectionId === "quota-first" ? 30 * 60 * 1000 : 6 * 24 * 3600 * 1000)
    ).toISOString(),
  }));

  const calls: Array<{ model: string; connectionId: string | null }> = [];
  const response = await handleComboChat({
    body: { model: "gpt-5.6-luna", messages: [{ role: "user", content: "test" }] },
    combo: findCombo(combos, "gpt-5.6-luna"),
    allCombos: combos,
    settings: {},
    log: makeLog(),
    handleSingleModel: async (_body, model, target) => {
      calls.push({ model, connectionId: target?.connectionId ?? null });
      return okResponse(model);
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { model: "antigravity/claude-opus-4-6-thinking", connectionId: "quota-first" },
  ]);
});

test("canonical parent exhausts one tier, succeeds in the next, and never reaches tier three", async () => {
  const combos = manifestCombos();
  const antigravity = findCombo(combos, "pool-fable-antigravity");
  antigravity.models = antigravity.models.slice(0, 1);
  const antigravityModels = new Set(modelNames(antigravity));
  const creditsModels = new Set(modelNames(findCombo(combos, "pool-fable-credits")));
  const codexModels = new Set(modelNames(findCombo(combos, "pool-fable-codex")));
  const calls: string[] = [];

  const response = await handleComboChat({
    body: { model: "gpt-5.6-terra", messages: [{ role: "user", content: "test" }] },
    combo: findCombo(combos, "gpt-5.6-terra"),
    allCombos: combos,
    settings: {},
    log: makeLog(),
    handleSingleModel: async (_body, model) => {
      calls.push(model);
      if (antigravityModels.has(model)) return errorResponse();
      return okResponse(model);
    },
  });

  assert.equal(response.status, 200);
  const firstCreditIndex = calls.findIndex((model) => creditsModels.has(model));
  assert.equal(firstCreditIndex, antigravityModels.size);
  assert.equal(
    calls.slice(0, firstCreditIndex).every((model) => antigravityModels.has(model)),
    true
  );
  assert.equal(
    calls.some((model) => codexModels.has(model)),
    false
  );
  assert.equal(calls.length, antigravityModels.size + 1, "maxRetries=0 must avoid wrapper retries");
});

test("CLI is dry-run by default, backs up reviewed apply, and passes the drift gate", () => {
  const cliDataDir = path.join(TEST_DATA_DIR, "cli");
  fs.mkdirSync(cliDataDir, { recursive: true });
  const dbPath = path.join(cliDataDir, "storage.sqlite");
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE combos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const oldCombo = {
    id: "old-opus",
    name: "pool-opus",
    models: ["opencode-zen/x-preview-f-free"],
    strategy: "priority",
    config: { preserveMe: "yes" },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    sortOrder: 4,
  };
  const obsolete = {
    id: "old-opus-free",
    name: "pool-opus-free",
    models: ["opencode-zen/x-preview-f-free"],
    strategy: "priority",
    config: {},
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    sortOrder: 5,
  };
  const insert = database.prepare(
    "INSERT INTO combos (id, name, data, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const combo of [oldCombo, obsolete]) {
    insert.run(
      combo.id,
      combo.name,
      JSON.stringify(combo),
      combo.sortOrder,
      combo.createdAt,
      combo.updatedAt
    );
  }
  database.close();

  const cli = path.resolve("scripts/ops/reconcile-canonical-combos.mjs");
  const dryRun = spawnSync(process.execPath, [cli, "--db", dbPath, "--json"], {
    encoding: "utf8",
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryRunDb = new Database(dbPath, { readonly: true });
  const dryRunCount = dryRunDb.prepare("SELECT count(*) count FROM combos").get() as {
    count: number;
  };
  dryRunDb.close();
  assert.equal(dryRunCount.count, 2);
  assert.equal(fs.existsSync(path.join(cliDataDir, "db_backups")), false);

  const refused = spawnSync(process.execPath, [cli, "--db", dbPath, "--apply", "--json"], {
    encoding: "utf8",
  });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Refusing 2 unowned row/);

  const applied = spawnSync(
    process.execPath,
    [cli, "--db", dbPath, "--apply", "--adopt", "--json"],
    { encoding: "utf8" }
  );
  assert.equal(applied.status, 0, applied.stderr);
  const appliedOutput = JSON.parse(applied.stdout) as {
    applied: number;
    backupPath: string;
  };
  assert.equal(appliedOutput.applied > 0, true);
  assert.equal(fs.existsSync(appliedOutput.backupPath), true);

  const verifiedDb = new Database(dbPath, { readonly: true });
  const rows = verifiedDb.prepare("SELECT name, data FROM combos").all() as Array<{
    name: string;
    data: string;
  }>;
  verifiedDb.close();
  assert.equal(rows.length, getCanonicalComboManifest().combos.length);
  assert.equal(
    rows.some((row) => row.name === "pool-opus-free"),
    false
  );
  const storedOpus = JSON.parse(rows.find((row) => row.name === "pool-opus")?.data || "null") as {
    id: string;
    config: Record<string, unknown>;
  };
  assert.equal(storedOpus.id, oldCombo.id);
  assert.equal(storedOpus.config.preserveMe, "yes");
  assert.equal(storedOpus.config._managedBy, CANONICAL_COMBO_MANAGER);

  const check = spawnSync(process.execPath, [cli, "--db", dbPath, "--check", "--json"], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
  const checkOutput = JSON.parse(check.stdout) as { drift: boolean; operations: unknown[] };
  assert.equal(checkOutput.drift, false);
  assert.deepEqual(checkOutput.operations, []);
});

test("CLI delegates every combos-table and backup operation to the typed DB domain", () => {
  const cliSource = fs.readFileSync(
    path.resolve("scripts/ops/reconcile-canonical-combos.mjs"),
    "utf8"
  );
  assert.doesNotMatch(cliSource, /better-sqlite3|\.prepare\(|\.backup\(|\.transaction\(/);
  assert.doesNotMatch(cliSource, /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*\bcombos\b/i);
  assert.match(cliSource, /src\/lib\/db\/canonicalEconomicCombos\.ts/);
});

test("DB domain never overwrites an existing backup and publishes an integral rollback point", async () => {
  const backupDataDir = path.join(TEST_DATA_DIR, "backup-no-clobber");
  const backupDir = path.join(backupDataDir, "db_backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const dbPath = path.join(backupDataDir, "storage.sqlite");
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE combos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  database.close();

  const now = "2026-08-22T01:02:03.456Z";
  const occupiedPath = path.join(
    backupDir,
    "db_2026-08-22T01-02-03-456Z_pre-canonical-combos.sqlite"
  );
  const sentinel = Buffer.from("existing rollback point must not be replaced\n");
  fs.writeFileSync(occupiedPath, sentinel, { flag: "wx" });

  const result = await reconcileCanonicalComboDatabase({ dbPath, now });
  assert.ok(result.backupPath);
  assert.notEqual(result.backupPath, occupiedPath);
  assert.equal(
    path.basename(result.backupPath),
    "db_2026-08-22T01-02-03-456Z_pre-canonical-combos-1.sqlite"
  );
  assert.deepEqual(fs.readFileSync(occupiedPath), sentinel);

  const backupDatabase = new Database(result.backupPath, {
    readonly: true,
    fileMustExist: true,
  });
  const integrity = backupDatabase.pragma("integrity_check", { simple: true });
  backupDatabase.close();
  assert.equal(integrity, "ok");
  assert.equal(
    fs.readdirSync(backupDir).some((name) => name.startsWith(".canonical-combo-backup-")),
    false,
    "unique partial staging paths must be removed after finalization"
  );
});

test("CLI applies every managed combo in one rollback-safe transaction", () => {
  const atomicDataDir = path.join(TEST_DATA_DIR, "atomic");
  fs.mkdirSync(atomicDataDir, { recursive: true });
  const dbPath = path.join(atomicDataDir, "storage.sqlite");
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE combos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TRIGGER reject_second_canonical_combo
      BEFORE INSERT ON combos
      WHEN NEW.name = 'pool-haiku-antigravity'
    BEGIN
      SELECT RAISE(ABORT, 'injected transaction failure');
    END;
  `);
  database.close();

  const cli = path.resolve("scripts/ops/reconcile-canonical-combos.mjs");
  const failedApply = spawnSync(process.execPath, [cli, "--db", dbPath, "--apply", "--json"], {
    encoding: "utf8",
  });
  assert.equal(failedApply.status, 2);
  assert.match(failedApply.stderr, /injected transaction failure/);

  const verifiedDb = new Database(dbPath, { readonly: true });
  const count = verifiedDb.prepare("SELECT count(*) count FROM combos").get() as {
    count: number;
  };
  verifiedDb.close();
  assert.equal(count.count, 0, "the first insert must roll back when a later insert fails");
  assert.equal(
    fs
      .readdirSync(path.join(atomicDataDir, "db_backups"))
      .some((name) => name.endsWith("_pre-canonical-combos.sqlite")),
    true,
    "a durable pre-change backup must exist even when the transaction rolls back"
  );
  assert.equal(
    fs
      .readdirSync(path.join(atomicDataDir, "db_backups"))
      .some((name) => name.startsWith(".canonical-combo-backup-")),
    false,
    "failed applies must not leave partial backup staging paths"
  );
});
