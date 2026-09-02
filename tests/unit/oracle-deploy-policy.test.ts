import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createDeploymentManifest,
  evaluateLocalRuntimeGate,
  evaluatePublicGate,
  isImmutableOmniRouteImage,
  promoteWithRollback,
  type LocalRuntimeGate,
  type OracleDeployAdapter,
  type PublicGate,
} from "../../scripts/ops/oracleDeploy.ts";

const deployCli = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../scripts/ops/oracle-deploy.mjs"),
  "utf8"
);
const remoteHelper = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../scripts/ops/oracle-deploy-remote.sh"),
  "utf8"
);

const CANDIDATE = {
  imageRef: "omniroute:canary-abc1234-20260822",
  imageId: "sha256:candidate",
  buildSha: "abc1234",
};
const PREVIOUS = {
  imageRef: "omniroute:canary-old-20260821",
  imageId: "sha256:previous",
  buildSha: "old1234",
  composeHash: "compose-hash",
};
const PASSING_LOCAL: LocalRuntimeGate = {
  containerName: "omniroute-parallel",
  containerStatus: "running",
  healthStatus: "healthy",
  expectedBuildSha: CANDIDATE.buildSha,
  actualBuildSha: CANDIDATE.buildSha,
  expectedImageId: CANDIDATE.imageId,
  actualImageId: CANDIDATE.imageId,
  restartCount: 0,
  oomKilled: false,
  memoryBytes: 6442450944,
  nanoCpus: 2000000000,
  dashboardOk: true,
  healthOk: true,
  apiModelsOk: true,
  completionOk: true,
  streamingOk: true,
  comboOk: true,
  callLogAdvanced: true,
  liveWsOk: true,
};
const PASSING_PUBLIC: PublicGate = {
  healthzStatus: 200,
  unauthenticatedModelsStatus: 401,
  authenticatedModelsStatus: 200,
  authenticatedModelIds: ["gpt-5.4-mini", "gpt-5.6-luna"],
  configuredSmokeModels: ["gpt-5.4-mini", "gpt-5.6-luna"],
  completionOk: true,
  liveWsOk: true,
};

test("readiness probes use the dashboard port rather than the API-only port", () => {
  assert.match(deployCli, /runTrafficProbesWithGates[\s\S]*?waitForHealth\(dashboardUrl\)/);
  assert.doesNotMatch(deployCli, /waitForHealth\(api\)/);
  assert.doesNotMatch(deployCli, /probeMixedCaseTool/);
  assert.doesNotMatch(deployCli, /DEFAULT_MODELS[^\n]*gpt-5\.4-mini/);
  assert.match(deployCli, /MODEL_CATALOG_TIMEOUT_MS = 60_000/);
  assert.match(remoteHelper, /docker image inspect "\$img" --format/);
});

function makeAdapter(
  calls: string[],
  overrides: Partial<OracleDeployAdapter> = {}
): OracleDeployAdapter {
  const adapter: OracleDeployAdapter = {
    acquireLock: async () => calls.push("lock"),
    releaseLock: async () => calls.push("unlock"),
    captureCurrent: async () => {
      calls.push("capture");
      return PREVIOUS;
    },
    backupDatabase: async () => {
      calls.push("backup-db");
      return "/backup.sqlite";
    },
    backupConfig: async () => {
      calls.push("backup-config");
      return { path: "/backup.env", hash: "env-hash" };
    },
    backupGateway: async () => {
      calls.push("backup-gateway");
      return { dir: "/backup-gateway", tsGatewayImage: "ts-gateway@sha256:old" };
    },
    tagRollback: async () => calls.push("tag-image"),
    tagGatewayRollback: async () => calls.push("tag-gateway"),
    reconcileEnvironment: async () => calls.push("env"),
    writeCandidateImage: async () => calls.push("write-image"),
    recreateProduction: async () => calls.push("recreate"),
    probeLocalGates: async () => {
      calls.push("local");
      return PASSING_LOCAL;
    },
    reconcileGateway: async () => calls.push("gateway"),
    probePublicGates: async () => {
      calls.push("public");
      return PASSING_PUBLIC;
    },
    restoreGateway: async () => calls.push("restore-gateway"),
    restoreConfig: async () => calls.push("restore-config"),
    restorePreviousImage: async () => calls.push("restore-image"),
    verifyRollback: async () => {
      calls.push("verify-image");
      return true;
    },
    writeManifest: async (manifest) => calls.push(`manifest:${manifest.state}`),
  };
  return { ...adapter, ...overrides };
}

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

test("strict local and public gates fail closed on missing or malformed values", () => {
  assert.deepEqual(evaluateLocalRuntimeGate(PASSING_LOCAL), { ok: true, failures: [] });
  assert.equal(evaluateLocalRuntimeGate({ ...PASSING_LOCAL, memoryBytes: null }).ok, false);
  assert.equal(evaluateLocalRuntimeGate({ ...PASSING_LOCAL, liveWsOk: undefined }).ok, false);
  assert.deepEqual(evaluatePublicGate(PASSING_PUBLIC), { ok: true, failures: [] });
  assert.equal(
    evaluatePublicGate({ ...PASSING_PUBLIC, unauthenticatedModelsStatus: 404 }).ok,
    false
  );
  assert.equal(evaluatePublicGate({ ...PASSING_PUBLIC, authenticatedModelIds: null }).ok, false);
});

test("schema-v2 manifest records gateway/config rollback anchors", () => {
  const manifest = createDeploymentManifest({
    candidateImageRef: CANDIDATE.imageRef,
    candidateImageId: CANDIDATE.imageId,
    candidateBuildSha: CANDIDATE.buildSha,
    previousImageRef: "omniroute:canary-old-20260821",
    previousImageId: PREVIOUS.imageId,
    previousBuildSha: PREVIOUS.buildSha,
    databaseBackupPath: "/home/ubuntu/.omniroute/deployments/backups/pre-promote.sqlite",
    composeHash: PREVIOUS.composeHash,
    createdAt: "2026-08-22T00:00:00.000Z",
    gatewayBackupDir: "/backup-gateway",
    configBackupPath: "/backup.env",
    tsGatewayImage: "ts-gateway@sha256:old",
    envHash: "env-hash",
  });
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.state, "pending");
  assert.equal(manifest.gatewayBackupDir, "/backup-gateway");
  assert.equal(manifest.rollback.imageId, PREVIOUS.imageId);
});

test("promotion writes pending before mutation and restores gateway/config/image in order", async () => {
  const calls: string[] = [];
  const result = await promoteWithRollback(CANDIDATE, makeAdapter(calls));
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    "lock",
    "capture",
    "backup-db",
    "backup-config",
    "backup-gateway",
    "tag-image",
    "tag-gateway",
    "manifest:pending",
    "env",
    "write-image",
    "recreate",
    "local",
    "gateway",
    "public",
    "manifest:active",
    "unlock",
  ]);
});

test("local failure avoids gateway exposure and restores every component", async () => {
  const calls: string[] = [];
  const result = await promoteWithRollback(
    CANDIDATE,
    makeAdapter(calls, {
      probeLocalGates: async () => {
        calls.push("local");
        return { ...PASSING_LOCAL, healthOk: false };
      },
    })
  );
  assert.equal(result.rolledBack, true);
  assert.deepEqual(calls.slice(calls.indexOf("local")), [
    "local",
    "restore-gateway",
    "restore-config",
    "restore-image",
    "recreate",
    "verify-image",
    "manifest:rolled_back",
    "unlock",
  ]);
  assert.equal(calls.includes("gateway"), false);
});

test("public failure restores all components and records rollback", async () => {
  const calls: string[] = [];
  const result = await promoteWithRollback(
    CANDIDATE,
    makeAdapter(calls, {
      probePublicGates: async () => {
        calls.push("public");
        return { ...PASSING_PUBLIC, healthzStatus: 404 };
      },
    })
  );
  assert.equal(result.rolledBack, true);
  assert.deepEqual(calls.slice(calls.indexOf("public")), [
    "public",
    "restore-gateway",
    "restore-config",
    "restore-image",
    "recreate",
    "verify-image",
    "manifest:rolled_back",
    "unlock",
  ]);
});

test("restoration failure records rollback_failed after attempting all components", async () => {
  const calls: string[] = [];
  const adapter = makeAdapter(calls, {
    probeLocalGates: async () => {
      calls.push("local");
      return { ...PASSING_LOCAL, healthOk: false };
    },
    restoreGateway: async () => {
      calls.push("restore-gateway");
      throw new Error("gateway reset failed");
    },
  });
  await assert.rejects(promoteWithRollback(CANDIDATE, adapter), /rollback_failed/);
  assert.equal(calls.filter((entry) => entry === "restore-gateway").length, 1);
  assert.equal(calls.includes("restore-config"), true);
  assert.equal(calls.includes("restore-image"), true);
  assert.equal(calls.includes("manifest:rollback_failed"), true);
});

test("backup failure causes zero cutover mutations", async () => {
  const calls: string[] = [];
  const adapter = makeAdapter(calls, {
    backupDatabase: async () => {
      calls.push("backup-db");
      throw new Error("backup failed");
    },
  });
  await assert.rejects(promoteWithRollback(CANDIDATE, adapter), /backup failed/);
  assert.deepEqual(calls, ["lock", "capture", "backup-db", "unlock"]);
});
