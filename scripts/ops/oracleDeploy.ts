/**
 * Pure Oracle VPS deployment policy.
 *
 * The side-effecting SSH/Docker adapter lives in oracle-deploy.mjs. Keeping
 * the promotion transaction here makes the rollback guarantees testable
 * without a host. The two gate contracts below are deliberately separate:
 * local qualification proves the container and application, while the public
 * gate proves the exposed gateway and authentication boundary.
 */

export interface CandidateImage {
  imageRef: string;
  imageId: string;
  buildSha: string;
}

export interface RunningDeployment {
  imageRef: string;
  imageId: string;
  buildSha: string | null;
  composeHash: string;
}

/** Values returned by the local Docker/runtime probe. */
export interface LocalRuntimeGate {
  containerName: string | null;
  containerStatus: string | null;
  healthStatus: string | null;
  expectedBuildSha: string | null;
  actualBuildSha: string | null;
  expectedImageId: string | null;
  actualImageId: string | null;
  restartCount: number | null;
  oomKilled: boolean | null;
  memoryBytes: number | null;
  nanoCpus: number | null;
  dashboardOk: boolean | null;
  healthOk: boolean | null;
  apiModelsOk: boolean | null;
  completionOk: boolean | null;
  streamingOk: boolean | null;
  comboOk: boolean | null;
  callLogAdvanced: boolean | null;
  liveWsOk: boolean | null;
}

/** Values returned by the public Funnel/API probe. */
export interface PublicGate {
  healthzStatus: number | null;
  unauthenticatedModelsStatus: number | null;
  authenticatedModelsStatus: number | null;
  authenticatedModelIds: string[] | null;
  configuredSmokeModels: string[] | null;
  completionOk: boolean | null;
  liveWsOk: boolean | null;
}

export interface RuntimeGateVerdict {
  ok: boolean;
  failures: string[];
}

export interface DeploymentManifestInput {
  candidateImageRef: string;
  candidateImageId: string;
  candidateBuildSha: string;
  previousImageRef: string;
  previousImageId: string;
  previousBuildSha: string | null;
  databaseBackupPath: string;
  composeHash: string;
  createdAt: string;
  gatewayBackupDir: string;
  configBackupPath: string;
  tsGatewayImage: string;
  envHash: string;
}

export interface DeploymentManifest {
  schemaVersion: 2;
  state: "pending" | "active" | "rolled_back" | "rollback_failed";
  createdAt: string;
  current: {
    imageRef: string;
    imageId: string;
    buildSha: string;
  };
  rollback: {
    imageRef: string;
    imageId: string;
    buildSha: string | null;
  };
  databaseBackupPath: string;
  composeHash: string;
  failures?: string[];
  gatewayBackupDir: string;
  configBackupPath: string;
  tsGatewayImage: string;
  envHash: string;
}

/** Every operation in this interface is mandatory for production promotion. */
export interface OracleDeployAdapter {
  acquireLock(): Promise<unknown>;
  releaseLock(): Promise<unknown>;
  captureCurrent(): Promise<RunningDeployment>;
  backupDatabase(): Promise<string>;
  backupGateway(): Promise<{ dir: string; tsGatewayImage: string }>;
  backupConfig(): Promise<{ path: string; hash: string }>;
  tagRollback(imageRef: string, imageId: string): Promise<unknown>;
  tagGatewayRollback(imageRef: string): Promise<unknown>;
  reconcileEnvironment(): Promise<unknown>;
  writeCandidateImage(imageRef: string): Promise<unknown>;
  recreateProduction(): Promise<unknown>;
  probeLocalGates(candidate: CandidateImage): Promise<LocalRuntimeGate>;
  reconcileGateway(): Promise<unknown>;
  probePublicGates(candidate: CandidateImage): Promise<PublicGate>;
  restoreGateway(backupDir: string): Promise<unknown>;
  restoreConfig(backupPath: string): Promise<unknown>;
  restorePreviousImage(imageRef: string, imageId: string): Promise<unknown>;
  verifyRollback(imageId: string): Promise<boolean>;
  writeManifest(manifest: DeploymentManifest): Promise<unknown>;
}

export interface PromotionResult {
  ok: boolean;
  rolledBack: boolean;
  failures: string[];
  manifest: DeploymentManifest;
}

const DIGEST_PATTERN = /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._/-]*:[a-zA-Z0-9_.-]+$/;
const SHA_BEARING_TAG_PATTERN = /(?:^|[-_.])[a-f0-9]{7,40}(?:[-_.]|$)/;
export const ROLLBACK_IMAGE_REF = "omniroute:rollback-canary";
export const ROLLBACK_GATEWAY_IMAGE_REF = "ts-gateway:rollback";
// Extreme-limits host (4c/12g): the local gate must expect the NEW envelope,
// not the old 2c/6g one. These flow from compose.oracle.yaml (mem_limit,
// cpus) — update together or qualify fails closed on resource identity.
const EXPECTED_MEMORY_BYTES = 12 * 1024 * 1024 * 1024;
const EXPECTED_NANO_CPUS = 4_000_000_000;

export function isImmutableOmniRouteImage(imageRef: string): boolean {
  const ref = imageRef.trim();
  if (DIGEST_PATTERN.test(ref)) return true;
  if (!TAG_PATTERN.test(ref)) return false;

  const tag = ref.slice(ref.lastIndexOf(":") + 1).toLowerCase();
  if (["latest", "next", "main", "stable"].includes(tag)) return false;
  return SHA_BEARING_TAG_PATTERN.test(tag);
}

function strictFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function strictNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Strict local contract. Missing, null, malformed, and false values fail closed. */
export function evaluateLocalRuntimeGate(input: unknown): RuntimeGateVerdict {
  const gate = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const failures: string[] = [];
  const expect = (condition: boolean, failure: string) => {
    if (!condition) failures.push(failure);
  };

  expect(
    gate.containerName === "omniroute-parallel" || gate.containerName === "omniroute-canary",
    "container identity is missing or unexpected"
  );
  expect(gate.containerStatus === "running", "container is not running");
  expect(gate.healthStatus === "healthy", "container health is not healthy");
  expect(strictNonEmptyString(gate.expectedBuildSha), "expected image build SHA is missing");
  expect(strictNonEmptyString(gate.actualBuildSha), "image build SHA is missing");
  if (strictNonEmptyString(gate.expectedBuildSha) && strictNonEmptyString(gate.actualBuildSha)) {
    expect(
      gate.actualBuildSha === gate.expectedBuildSha,
      "image build SHA does not match the candidate"
    );
  }
  expect(strictNonEmptyString(gate.expectedImageId), "expected image ID is missing");
  expect(strictNonEmptyString(gate.actualImageId), "running image ID is missing");
  if (strictNonEmptyString(gate.expectedImageId) && strictNonEmptyString(gate.actualImageId)) {
    expect(
      gate.actualImageId === gate.expectedImageId,
      "running image ID does not match the candidate"
    );
  }
  expect(
    strictFiniteNumber(gate.restartCount) && gate.restartCount === 0,
    "container restart count is not zero"
  );
  expect(gate.oomKilled === false, "container was OOMKilled or value is missing");
  expect(
    strictFiniteNumber(gate.memoryBytes) && gate.memoryBytes === EXPECTED_MEMORY_BYTES,
    `memory limit is not exactly ${EXPECTED_MEMORY_BYTES} bytes`
  );
  expect(
    strictFiniteNumber(gate.nanoCpus) && gate.nanoCpus === EXPECTED_NANO_CPUS,
    `CPU limit is not exactly ${EXPECTED_NANO_CPUS} nanoCPUs`
  );
  expect(gate.dashboardOk === true, "dashboard probe failed");
  expect(gate.healthOk === true, "health probe failed");
  expect(gate.apiModelsOk === true, "local models probe failed");
  expect(gate.completionOk === true, "completion probe failed");
  expect(gate.streamingOk === true, "streaming probe failed");
  expect(gate.comboOk === true, "combo-routing probe failed");
  expect(gate.callLogAdvanced === true, "call_logs did not advance");
  expect(gate.liveWsOk === true, "local LiveWS probe failed");
  return { ok: failures.length === 0, failures };
}

/** Strict public contract; status and model identity are checked independently. */
export function evaluatePublicGate(input: unknown): RuntimeGateVerdict {
  const gate = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const failures: string[] = [];
  const expect = (condition: boolean, failure: string) => {
    if (!condition) failures.push(failure);
  };
  expect(gate.healthzStatus === 200, "public /healthz did not return 200");
  // A public 404 is deliberately not treated as an auth success.
  expect(gate.unauthenticatedModelsStatus === 401, "unauthenticated /v1/models did not return 401");
  expect(gate.authenticatedModelsStatus === 200, "authenticated /v1/models did not return 200");
  const ids = gate.authenticatedModelIds;
  const configured = gate.configuredSmokeModels;
  expect(Array.isArray(ids), "authenticated model IDs are missing or malformed");
  expect(Array.isArray(configured) && configured.length > 0, "configured smoke models are missing");
  if (Array.isArray(ids) && Array.isArray(configured) && configured.length > 0) {
    for (const model of configured) {
      expect(
        typeof model === "string" && model.length > 0 && ids.includes(model),
        `authenticated model is missing: ${String(model)}`
      );
    }
  }
  expect(gate.completionOk === true, "public completion probe failed");
  expect(gate.liveWsOk === true, "public LiveWS probe failed");
  return { ok: failures.length === 0, failures };
}

export function createDeploymentManifest(input: DeploymentManifestInput): DeploymentManifest {
  return {
    schemaVersion: 2,
    state: "pending",
    createdAt: input.createdAt,
    current: {
      imageRef: input.candidateImageRef,
      imageId: input.candidateImageId,
      buildSha: input.candidateBuildSha,
    },
    rollback: {
      imageRef: input.previousImageRef,
      imageId: input.previousImageId,
      buildSha: input.previousBuildSha,
    },
    databaseBackupPath: input.databaseBackupPath,
    composeHash: input.composeHash,
    gatewayBackupDir: input.gatewayBackupDir,
    configBackupPath: input.configBackupPath,
    tsGatewayImage: input.tsGatewayImage,
    envHash: input.envHash,
  };
}

function sanitizeFailure(component: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const safe = raw
    .replace(/Bearer\s+[^\s]+/gi, "Bearer <redacted>")
    .replace(/https?:\/\/[^\s]+/gi, "<url-redacted>")
    .replace(/[?&](?:key|token|secret|api_key|authorization)=[^\s&]+/gi, "<$&-redacted>");
  return `${component} restoration failed${safe ? `: ${safe.slice(0, 240)}` : ""}`;
}

class RollbackFailure extends Error {
  constructor(readonly failures: string[]) {
    super(`rollback_failed: ${failures.join("; ")}`);
    this.name = "RollbackFailure";
  }
}

async function restoreAndVerify(
  previous: RunningDeployment,
  adapter: OracleDeployAdapter,
  manifest: DeploymentManifest
): Promise<void> {
  const failures: string[] = [];

  try {
    await adapter.restoreGateway(manifest.gatewayBackupDir);
  } catch (error) {
    failures.push(sanitizeFailure("gateway", error));
  }
  try {
    await adapter.restoreConfig(manifest.configBackupPath);
  } catch (error) {
    failures.push(sanitizeFailure("config", error));
  }
  try {
    await adapter.restorePreviousImage(ROLLBACK_IMAGE_REF, previous.imageId);
    await adapter.recreateProduction();
    if (!(await adapter.verifyRollback(previous.imageId))) {
      throw new Error(`image ID did not verify: ${previous.imageId}`);
    }
  } catch (error) {
    failures.push(sanitizeFailure("image", error));
  }
  if (failures.length > 0) throw new RollbackFailure(failures);
}

function createRolledBackManifest(
  manifest: DeploymentManifest,
  previous: RunningDeployment,
  failures: string[]
): DeploymentManifest {
  if (!previous.buildSha)
    throw new Error("cannot record rollback state without the previous build SHA");
  return {
    ...manifest,
    state: "rolled_back",
    current: {
      imageRef: ROLLBACK_IMAGE_REF,
      imageId: previous.imageId,
      buildSha: previous.buildSha,
    },
    rollback: {
      imageRef: ROLLBACK_IMAGE_REF,
      imageId: previous.imageId,
      buildSha: previous.buildSha,
    },
    failures,
  };
}

function createRollbackFailedManifest(
  manifest: DeploymentManifest,
  failures: string[]
): DeploymentManifest {
  return { ...manifest, state: "rollback_failed", failures };
}

function assertAdapterContract(adapter: OracleDeployAdapter): void {
  const required: (keyof OracleDeployAdapter)[] = [
    "acquireLock",
    "releaseLock",
    "captureCurrent",
    "backupDatabase",
    "backupGateway",
    "backupConfig",
    "tagRollback",
    "tagGatewayRollback",
    "reconcileEnvironment",
    "writeCandidateImage",
    "recreateProduction",
    "probeLocalGates",
    "reconcileGateway",
    "probePublicGates",
    "restoreGateway",
    "restoreConfig",
    "restorePreviousImage",
    "verifyRollback",
    "writeManifest",
  ];
  for (const method of required) {
    if (typeof adapter[method] !== "function") {
      throw new Error(`deployment adapter missing required operation: ${method}`);
    }
  }
}

export async function promoteWithRollback(
  candidate: CandidateImage,
  adapter: OracleDeployAdapter,
  now: () => string = () => new Date().toISOString()
): Promise<PromotionResult> {
  if (!isImmutableOmniRouteImage(candidate.imageRef)) {
    throw new Error(`candidate image is not immutable: ${candidate.imageRef}`);
  }
  assertAdapterContract(adapter);

  await adapter.acquireLock();
  let previous: RunningDeployment | null = null;
  let manifest: DeploymentManifest | null = null;
  let pendingWritten = false;
  let rollbackAttempted = false;

  try {
    previous = await adapter.captureCurrent();
    if (!previous.buildSha) throw new Error("previous deployment has no recoverable build SHA");

    // Capture every rollback component before the first mutation. The adapter
    // must fail closed: no cutover mutation is allowed after a partial backup.
    const databaseBackupPath = await adapter.backupDatabase();
    const configBackup = await adapter.backupConfig();
    const gatewayBackup = await adapter.backupGateway();
    await adapter.tagRollback(ROLLBACK_IMAGE_REF, previous.imageId);
    await adapter.tagGatewayRollback(ROLLBACK_GATEWAY_IMAGE_REF);

    manifest = createDeploymentManifest({
      candidateImageRef: candidate.imageRef,
      candidateImageId: candidate.imageId,
      candidateBuildSha: candidate.buildSha,
      previousImageRef: ROLLBACK_IMAGE_REF,
      previousImageId: previous.imageId,
      previousBuildSha: previous.buildSha,
      databaseBackupPath,
      composeHash: previous.composeHash,
      createdAt: now(),
      gatewayBackupDir: gatewayBackup.dir,
      configBackupPath: configBackup.path,
      tsGatewayImage: gatewayBackup.tsGatewayImage,
      envHash: configBackup.hash,
    });
    await adapter.writeManifest(manifest);
    pendingWritten = true;

    // Configuration mutations begin only after the durable v2 pending marker.
    await adapter.reconcileEnvironment();
    await adapter.writeCandidateImage(candidate.imageRef);
    await adapter.recreateProduction();

    const localVerdict = evaluateLocalRuntimeGate(await adapter.probeLocalGates(candidate));
    if (!localVerdict.ok) {
      rollbackAttempted = true;
      await restoreAndVerify(previous, adapter, manifest);
      const rolledBack = createRolledBackManifest(manifest, previous, localVerdict.failures);
      await adapter.writeManifest(rolledBack);
      return { ok: false, rolledBack: true, failures: localVerdict.failures, manifest: rolledBack };
    }

    // Expose Funnel only after the complete local contract passes.
    await adapter.reconcileGateway();
    const publicVerdict = evaluatePublicGate(await adapter.probePublicGates(candidate));
    if (!publicVerdict.ok) {
      rollbackAttempted = true;
      await restoreAndVerify(previous, adapter, manifest);
      const rolledBack = createRolledBackManifest(manifest, previous, publicVerdict.failures);
      await adapter.writeManifest(rolledBack);
      return {
        ok: false,
        rolledBack: true,
        failures: publicVerdict.failures,
        manifest: rolledBack,
      };
    }

    const activeManifest: DeploymentManifest = { ...manifest, state: "active" };
    await adapter.writeManifest(activeManifest);
    return { ok: true, rolledBack: false, failures: [], manifest: activeManifest };
  } catch (error) {
    if (pendingWritten && previous && manifest && !rollbackAttempted) {
      rollbackAttempted = true;
      try {
        await restoreAndVerify(previous, adapter, manifest);
        const reason = error instanceof Error ? error.message : String(error);
        await adapter.writeManifest(createRolledBackManifest(manifest, previous, [reason]));
      } catch (rollbackError) {
        const failures =
          rollbackError instanceof RollbackFailure
            ? rollbackError.failures
            : [sanitizeFailure("rollback", rollbackError)];
        try {
          await adapter.writeManifest(createRollbackFailedManifest(manifest, failures));
        } catch (manifestError) {
          failures.push(sanitizeFailure("manifest", manifestError));
        }
        throw new RollbackFailure(failures);
      }
    } else if (
      pendingWritten &&
      manifest &&
      rollbackAttempted &&
      error instanceof RollbackFailure
    ) {
      // A gate failure already attempted all three rollback components. Do not
      // repeat them (which could overwrite the quarantine or state snapshot).
      try {
        await adapter.writeManifest(createRollbackFailedManifest(manifest, error.failures));
      } catch {
        // Preserve the original rollback failure; the manifest writer is part
        // of the same incident and its failure is reported by the caller.
      }
    }
    throw error;
  } finally {
    await adapter.releaseLock();
  }
}
