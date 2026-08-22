import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeploymentManifest,
  evaluateRuntimeGate,
  isImmutableOmniRouteImage,
  planProtectedImageCleanup,
  promoteWithRollback,
  type OracleDeployAdapter,
  type RuntimeGate,
} from "../../scripts/ops/oracleDeploy.ts";

const PASSING_GATE: RuntimeGate = {
  healthy: true,
  expectedBuildSha: "abc1234",
  actualBuildSha: "abc1234",
  expectedImageId: "sha256:candidate",
  actualImageId: "sha256:candidate",
  restartCount: 0,
  completionOk: true,
  streamingOk: true,
  mixedCaseToolOk: true,
  comboOk: true,
  callLogAdvanced: true,
};

test("Oracle deploy accepts immutable digests and unique SHA tags only", () => {
  assert.equal(isImmutableOmniRouteImage("omniroute:canary-abc1234-20260822"), true);
  assert.equal(
    isImmutableOmniRouteImage(
      "ghcr.io/example/omniroute@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ),
    true
  );
  assert.equal(isImmutableOmniRouteImage("omniroute:latest"), false);
  assert.equal(isImmutableOmniRouteImage("omniroute:next"), false);
  assert.equal(isImmutableOmniRouteImage("omniroute:3.8.50"), false);
  assert.equal(isImmutableOmniRouteImage("not a ref"), false);
});

test("runtime gate requires identity, zero restarts, real probes, and a new call-log row", () => {
  assert.deepEqual(evaluateRuntimeGate(PASSING_GATE), { ok: true, failures: [] });

  const verdict = evaluateRuntimeGate({
    ...PASSING_GATE,
    actualBuildSha: null,
    actualImageId: "sha256:wrong",
    restartCount: 1,
    mixedCaseToolOk: false,
    callLogAdvanced: false,
  });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.failures, [
    "image build SHA is missing",
    "running image ID does not match the candidate",
    "container restarted during qualification",
    "mixed-case tool continuation failed",
    "call_logs did not advance",
  ]);
});

test("manifest records the exact current image as rollback anchor", () => {
  const manifest = createDeploymentManifest({
    candidateImageRef: "omniroute:canary-abc1234-20260822",
    candidateImageId: "sha256:candidate",
    candidateBuildSha: "abc1234",
    previousImageRef: "omniroute:canary-old-20260821",
    previousImageId: "sha256:previous",
    previousBuildSha: "old1234",
    databaseBackupPath: "/home/ubuntu/.omniroute/db_backups/pre-promote.sqlite",
    composeHash: "compose-hash",
    createdAt: "2026-08-22T00:00:00.000Z",
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.state, "pending");
  assert.equal(manifest.rollback.imageId, "sha256:previous");
  assert.equal(manifest.current.imageId, "sha256:candidate");
  assert.equal(manifest.databaseBackupPath.endsWith("pre-promote.sqlite"), true);
});

test("cleanup never selects current or rollback image IDs", () => {
  assert.deepEqual(
    planProtectedImageCleanup(
      ["sha256:old-a", "sha256:current", "sha256:old-b", "sha256:rollback"],
      new Set(["sha256:current", "sha256:rollback"])
    ),
    ["sha256:old-a", "sha256:old-b"]
  );
});

test("failed post-cutover gate restores and verifies the exact previous image", async () => {
  const calls: string[] = [];
  const adapter: OracleDeployAdapter = {
    acquireLock: async () => calls.push("lock"),
    releaseLock: async () => calls.push("unlock"),
    backupDatabase: async () => {
      calls.push("backup");
      return "/backup.sqlite";
    },
    captureCurrent: async () => ({
      imageRef: "omniroute:canary-old-20260821",
      imageId: "sha256:previous",
      buildSha: "old1234",
      composeHash: "compose-hash",
    }),
    tagRollback: async (_ref, id) => calls.push(`tag:${id}`),
    reconcileConfiguration: async () => calls.push("reconcile"),
    writeCandidateImage: async (ref) => calls.push(`write:${ref}`),
    recreateProduction: async () => calls.push("recreate"),
    probeRuntime: async () => ({ ...PASSING_GATE, healthy: false }),
    restorePreviousImage: async (ref, id) => calls.push(`restore:${ref}:${id}`),
    verifyRollback: async (id) => {
      calls.push(`verify:${id}`);
      return true;
    },
    writeManifest: async () => calls.push("manifest"),
  };

  const result = await promoteWithRollback(
    {
      imageRef: "omniroute:canary-abc1234-20260822",
      imageId: "sha256:candidate",
      buildSha: "abc1234",
    },
    adapter,
    () => "2026-08-22T00:00:00.000Z"
  );

  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.ok(calls.includes("restore:omniroute:rollback-canary:sha256:previous"));
  assert.ok(calls.includes("verify:sha256:previous"));
  assert.equal(result.manifest.state, "rolled_back");
  assert.equal(result.manifest.current.imageId, "sha256:previous");
  assert.equal(result.manifest.rollback.imageId, "sha256:previous");
  assert.equal(
    calls.filter((call) => call === "manifest").length,
    2,
    "write pending state before cutover, then durable rolled-back state"
  );
  assert.equal(calls.at(-1), "unlock");
});

test("successful promotion commits the manifest from pending to active", async () => {
  const manifestStates: string[] = [];
  const adapter: OracleDeployAdapter = {
    acquireLock: async () => undefined,
    releaseLock: async () => undefined,
    backupDatabase: async () => "/backup.sqlite",
    captureCurrent: async () => ({
      imageRef: "omniroute:canary-old-20260821",
      imageId: "sha256:previous",
      buildSha: "old1234",
      composeHash: "compose-hash",
    }),
    tagRollback: async () => undefined,
    reconcileConfiguration: async () => undefined,
    writeCandidateImage: async () => undefined,
    recreateProduction: async () => undefined,
    probeRuntime: async () => PASSING_GATE,
    restorePreviousImage: async () => undefined,
    verifyRollback: async () => true,
    writeManifest: async (manifest) => manifestStates.push(manifest.state),
  };

  const result = await promoteWithRollback(
    {
      imageRef: "omniroute:canary-abc1234-20260822",
      imageId: "sha256:candidate",
      buildSha: "abc1234",
    },
    adapter
  );

  assert.equal(result.ok, true);
  assert.equal(result.manifest.state, "active");
  assert.deepEqual(manifestStates, ["pending", "active"]);
});

test("backup failure aborts before any production recreation", async () => {
  const calls: string[] = [];
  const adapter: OracleDeployAdapter = {
    acquireLock: async () => calls.push("lock"),
    releaseLock: async () => calls.push("unlock"),
    backupDatabase: async () => {
      calls.push("backup");
      throw new Error("backup failed");
    },
    captureCurrent: async () => ({
      imageRef: "omniroute:old",
      imageId: "sha256:previous",
      buildSha: "old",
      composeHash: "hash",
    }),
    tagRollback: async () => calls.push("tag"),
    reconcileConfiguration: async () => calls.push("reconcile"),
    writeCandidateImage: async () => calls.push("write"),
    recreateProduction: async () => calls.push("recreate"),
    probeRuntime: async () => PASSING_GATE,
    restorePreviousImage: async () => calls.push("restore"),
    verifyRollback: async () => true,
    writeManifest: async () => calls.push("manifest"),
  };

  await assert.rejects(
    promoteWithRollback(
      {
        imageRef: "omniroute:canary-abc1234-20260822",
        imageId: "sha256:candidate",
        buildSha: "abc1234",
      },
      adapter
    ),
    /backup failed/
  );
  assert.equal(calls.includes("recreate"), false);
  assert.equal(calls.at(-1), "unlock");
});

test("configuration reconciliation failure aborts before image or container mutation", async () => {
  const calls: string[] = [];
  const adapter: OracleDeployAdapter = {
    acquireLock: async () => calls.push("lock"),
    releaseLock: async () => calls.push("unlock"),
    captureCurrent: async () => ({
      imageRef: "omniroute:old-abcdef1",
      imageId: "sha256:previous",
      buildSha: "abcdef1",
      composeHash: "hash",
    }),
    backupDatabase: async () => {
      calls.push("backup");
      return "/backup.sqlite";
    },
    tagRollback: async () => calls.push("tag"),
    reconcileConfiguration: async () => {
      calls.push("reconcile");
      throw new Error("combo drift refused");
    },
    writeCandidateImage: async () => calls.push("write"),
    recreateProduction: async () => calls.push("recreate"),
    probeRuntime: async () => PASSING_GATE,
    restorePreviousImage: async () => calls.push("restore"),
    verifyRollback: async () => true,
    writeManifest: async () => calls.push("manifest"),
  };

  await assert.rejects(
    promoteWithRollback(
      {
        imageRef: "omniroute:canary-abc1234-20260822",
        imageId: "sha256:candidate",
        buildSha: "abc1234",
      },
      adapter
    ),
    /combo drift refused/
  );
  assert.deepEqual(calls, ["lock", "backup", "tag", "reconcile", "unlock"]);
});
