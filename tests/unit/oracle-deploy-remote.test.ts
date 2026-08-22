import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const HELPER = path.join(REPO_ROOT, "scripts/ops/oracle-deploy-remote.sh");
const HELPER_SOURCE = fs.readFileSync(HELPER, "utf8");

function runHelper(root: string, dataDir: string, ...args: string[]) {
  return spawnSync("bash", [HELPER, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      OMNIROUTE_REPO_DIR: root,
      OMNIROUTE_DATA_DIR: dataDir,
      OMNIROUTE_CANARY_ROOT: path.join(root, "canary"),
    },
  });
}

function dispatchHelper(
  root: string,
  dataDir: string,
  action: string,
  values: string[],
  payload: string | null = null
) {
  return spawnSync("bash", [HELPER, "dispatch-json"], {
    encoding: "utf8",
    input: JSON.stringify({ action, values, payload }),
    env: {
      ...process.env,
      OMNIROUTE_REPO_DIR: root,
      OMNIROUTE_DATA_DIR: dataDir,
      OMNIROUTE_CANARY_ROOT: path.join(root, "canary"),
    },
  });
}

function createDeployLayout(root: string): string {
  const deployDir = path.join(root, "contrib/vps");
  fs.mkdirSync(deployDir, { recursive: true });
  for (const name of ["compose.yaml", "compose.oracle.yaml", "compose.canary.yaml"]) {
    fs.writeFileSync(path.join(deployDir, name), "services: {}\n");
  }
  fs.writeFileSync(path.join(deployDir, ".env"), "JWT_SECRET=test\n");
  return deployDir;
}

test("Oracle remote preflight fails closed when the canonical Compose tree is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-missing-compose-"));
  const dataDir = path.join(root, "data");
  try {
    const result = runHelper(root, dataDir, "preflight");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required file is missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Oracle remote helper updates only image identity keys and rejects unsafe refs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-set-image-"));
  const dataDir = path.join(root, "data");
  const deployDir = createDeployLayout(root);
  fs.writeFileSync(
    path.join(deployDir, ".env"),
    "JWT_SECRET=keep-me\nOMNIROUTE_IMAGE=omniroute:old-abcdef1\n"
  );

  try {
    const applied = runHelper(
      root,
      dataDir,
      "set-image",
      "omniroute:canary-abcdef1-20260822",
      "abcdef1"
    );
    assert.equal(applied.status, 0, applied.stderr);
    const env = fs.readFileSync(path.join(deployDir, ".env"), "utf8");
    assert.match(env, /^JWT_SECRET=keep-me$/m);
    assert.match(env, /^OMNIROUTE_IMAGE=omniroute:canary-abcdef1-20260822$/m);
    assert.match(env, /^OMNIROUTE_BUILD_SHA=abcdef1$/m);

    const rejected = runHelper(root, dataDir, "set-image", "bad ref;touch /tmp/x", "abcdef1");
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /invalid image reference/);

    const floating = runHelper(root, dataDir, "set-image", "omniroute:latest", "abcdef1");
    assert.notEqual(floating.status, 0);
    assert.match(floating.stderr, /floating image references/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Oracle SQLite backups are unique, integrity-checked, and never overwrite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-backup-"));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  createDeployLayout(root);
  const source = new Database(path.join(dataDir, "storage.sqlite"));
  source.exec("CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('kept');");
  source.close();

  try {
    const first = runHelper(root, dataDir, "backup");
    const second = runHelper(root, dataDir, "backup");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const firstPath = first.stdout.trim();
    const secondPath = second.stdout.trim();
    assert.notEqual(firstPath, secondPath);
    for (const backupPath of [firstPath, secondPath]) {
      assert.match(backupPath, /deployments\/backups\/storage_/);
      const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
      assert.equal(backup.pragma("integrity_check", { simple: true }), "ok");
      assert.equal(
        (backup.prepare("SELECT value FROM sentinel").get() as { value: string }).value,
        "kept"
      );
      backup.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Oracle remote helper serializes canaries and allocates a unique data copy", () => {
  assert.match(HELPER_SOURCE, /lock-canary\)/);
  assert.match(HELPER_SOURCE, /unlock-canary\)/);
  assert.match(HELPER_SOURCE, /mktemp -d/);
  assert.doesNotMatch(HELPER_SOURCE, /canary_dir="\$CANARY_ROOT\/\$build_sha"/);
  assert.doesNotMatch(HELPER_SOURCE, /chown -R 1000:1000/);
  assert.match(HELPER_SOURCE, /install -m 600 "\$DATA_DIR\/server\.env"/);
  assert.match(HELPER_SOURCE, /OMNIROUTE_RUNTIME_UID="\$\(id -u\)"/);
  assert.match(HELPER_SOURCE, /runtime_user="1000:1000"/);
  assert.match(HELPER_SOURCE, /runtime_user="\$\(id -u\):\$\(id -g\)"/);
  assert.match(HELPER_SOURCE, /--user "\$runtime_user"/);
});

test("Oracle rollback restore pins the dedicated rollback tag before recreation", () => {
  assert.match(HELPER_SOURCE, /verify-rollback-tag\)/);
  assert.match(HELPER_SOURCE, /ROLLBACK_TAG="omniroute:rollback-canary"/);
});

test("Oracle compose hash excludes both mutable image identity values", () => {
  assert.match(HELPER_SOURCE, /environment\.pop\("OMNIROUTE_BUILD_SHA", None\)/);
  assert.match(HELPER_SOURCE, /environment\.pop\("OMNIROUTE_IMAGE", None\)/);
});

test("Oracle canary cleanup rejects traversal and symlink escapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-canary-path-"));
  const dataDir = path.join(root, "data");
  const canaryRoot = path.join(root, "canary");
  const outside = path.join(root, "outside");
  fs.mkdirSync(canaryRoot, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "must-survive"), "keep");
  fs.symlinkSync(outside, path.join(canaryRoot, "escape"));

  try {
    const traversal = runHelper(
      root,
      dataDir,
      "delete-canary-data",
      path.join(canaryRoot, "child", "..", "..", "outside")
    );
    assert.notEqual(traversal.status, 0);
    assert.match(traversal.stderr, /outside/);

    const symlink = runHelper(root, dataDir, "delete-canary-data", path.join(canaryRoot, "escape"));
    assert.notEqual(symlink.status, 0);
    assert.match(symlink.stderr, /outside/);
    assert.equal(fs.readFileSync(path.join(outside, "must-survive"), "utf8"), "keep");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workstation transport sends values in a JSON envelope to a fixed remote command", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "scripts/ops/oracle-deploy.mjs"), "utf8");
  assert.match(source, /REMOTE_HELPER,\s*"dispatch-json"/);
  assert.match(source, /JSON\.stringify\(\{ action, values, payload:/);
  assert.doesNotMatch(source, /REMOTE_HELPER,\s*action,\s*\.\.\.values/);
});

test("remote JSON dispatcher preserves argv boundaries without invoking a shell", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-dispatch-"));
  const dataDir = path.join(root, "data");
  const deployDir = createDeployLayout(root);
  try {
    const applied = dispatchHelper(root, dataDir, "set-image", [
      "omniroute:canary-abcdef1-20260822",
      "abcdef1",
    ]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(
      fs.readFileSync(path.join(deployDir, ".env"), "utf8"),
      /^OMNIROUTE_IMAGE=omniroute:canary-abcdef1-20260822$/m
    );

    const rejected = dispatchHelper(root, dataDir, "set-image", [
      `omniroute:canary-abcdef1-20260822; touch ${path.join(root, "not-run")}`,
      "abcdef1",
    ]);
    assert.notEqual(rejected.status, 0);
    assert.equal(fs.existsSync(path.join(root, "not-run")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
