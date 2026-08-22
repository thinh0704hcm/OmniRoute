/**
 * Pure Oracle VPS deployment policy.
 *
 * The side-effecting SSH/Docker adapter lives in oracle-deploy.mjs. Keeping the
 * promotion transaction here makes the rollback guarantees testable without a host.
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

export interface RuntimeGate {
  healthy: boolean;
  expectedBuildSha: string;
  actualBuildSha: string | null;
  expectedImageId: string;
  actualImageId: string | null;
  restartCount: number;
  completionOk: boolean;
  streamingOk: boolean;
  mixedCaseToolOk: boolean;
  comboOk: boolean;
  callLogAdvanced: boolean;
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
}

export interface DeploymentManifest {
  schemaVersion: 1;
  state: "pending" | "active" | "rolled_back";
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
}

export interface OracleDeployAdapter {
  acquireLock(): Promise<unknown>;
  releaseLock(): Promise<unknown>;
  captureCurrent(): Promise<RunningDeployment>;
  backupDatabase(): Promise<string>;
  tagRollback(imageRef: string, imageId: string): Promise<unknown>;
  reconcileConfiguration(): Promise<unknown>;
  writeCandidateImage(imageRef: string): Promise<unknown>;
  recreateProduction(): Promise<unknown>;
  probeRuntime(candidate: CandidateImage): Promise<RuntimeGate>;
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

export function isImmutableOmniRouteImage(imageRef: string): boolean {
  const ref = imageRef.trim();
  if (DIGEST_PATTERN.test(ref)) return true;
  if (!TAG_PATTERN.test(ref)) return false;

  const tag = ref.slice(ref.lastIndexOf(":") + 1).toLowerCase();
  if (["latest", "next", "main", "stable"].includes(tag)) return false;
  return SHA_BEARING_TAG_PATTERN.test(tag);
}

export function evaluateRuntimeGate(input: RuntimeGate): RuntimeGateVerdict {
  const failures: string[] = [];
  if (!input.healthy) failures.push("health endpoint is not healthy");
  if (!input.actualBuildSha) {
    failures.push("image build SHA is missing");
  } else if (input.actualBuildSha !== input.expectedBuildSha) {
    failures.push("image build SHA does not match the candidate");
  }
  if (input.actualImageId !== input.expectedImageId) {
    failures.push("running image ID does not match the candidate");
  }
  if (input.restartCount !== 0) failures.push("container restarted during qualification");
  if (!input.completionOk) failures.push("completion probe failed");
  if (!input.streamingOk) failures.push("streaming probe failed");
  if (!input.mixedCaseToolOk) failures.push("mixed-case tool continuation failed");
  if (!input.comboOk) failures.push("combo-routing probe failed");
  if (!input.callLogAdvanced) failures.push("call_logs did not advance");
  return { ok: failures.length === 0, failures };
}

export function createDeploymentManifest(input: DeploymentManifestInput): DeploymentManifest {
  return {
    schemaVersion: 1,
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
  };
}

export function planProtectedImageCleanup(
  imageIds: string[],
  protectedImageIds: ReadonlySet<string>
): string[] {
  return [...new Set(imageIds)].filter((imageId) => !protectedImageIds.has(imageId));
}

async function restoreAndVerify(
  previous: RunningDeployment,
  adapter: OracleDeployAdapter
): Promise<void> {
  await adapter.restorePreviousImage(ROLLBACK_IMAGE_REF, previous.imageId);
  await adapter.recreateProduction();
  const verified = await adapter.verifyRollback(previous.imageId);
  if (!verified) {
    throw new Error(`rollback image verification failed for ${previous.imageId}`);
  }
}

function createRolledBackManifest(
  manifest: DeploymentManifest,
  previous: RunningDeployment,
  failures: string[]
): DeploymentManifest {
  if (!previous.buildSha) {
    throw new Error("cannot record rollback state without the previous build SHA");
  }
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

export async function promoteWithRollback(
  candidate: CandidateImage,
  adapter: OracleDeployAdapter,
  now: () => string = () => new Date().toISOString()
): Promise<PromotionResult> {
  if (!isImmutableOmniRouteImage(candidate.imageRef)) {
    throw new Error(`candidate image is not immutable: ${candidate.imageRef}`);
  }

  await adapter.acquireLock();
  let previous: RunningDeployment | null = null;
  let manifest: DeploymentManifest | null = null;
  let cutoverStarted = false;

  try {
    previous = await adapter.captureCurrent();
    if (!previous.buildSha) {
      throw new Error("previous deployment has no recoverable build SHA");
    }
    const databaseBackupPath = await adapter.backupDatabase();
    await adapter.tagRollback("omniroute:rollback-canary", previous.imageId);
    await adapter.reconcileConfiguration();

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
    });
    await adapter.writeManifest(manifest);
    // From this point onward a partial configuration write must be treated as
    // a cutover attempt and restored through the pinned rollback tag.
    cutoverStarted = true;
    await adapter.writeCandidateImage(candidate.imageRef);
    await adapter.recreateProduction();
    const verdict = evaluateRuntimeGate(await adapter.probeRuntime(candidate));
    if (verdict.ok) {
      const activeManifest: DeploymentManifest = { ...manifest, state: "active" };
      await adapter.writeManifest(activeManifest);
      return { ok: true, rolledBack: false, failures: [], manifest: activeManifest };
    }

    await restoreAndVerify(previous, adapter);
    const rolledBackManifest = createRolledBackManifest(manifest, previous, verdict.failures);
    await adapter.writeManifest(rolledBackManifest);
    return {
      ok: false,
      rolledBack: true,
      failures: verdict.failures,
      manifest: rolledBackManifest,
    };
  } catch (error) {
    if (cutoverStarted && previous && manifest) {
      await restoreAndVerify(previous, adapter);
      const reason = error instanceof Error ? error.message : String(error);
      await adapter.writeManifest(createRolledBackManifest(manifest, previous, [reason]));
    }
    throw error;
  } finally {
    await adapter.releaseLock();
  }
}
