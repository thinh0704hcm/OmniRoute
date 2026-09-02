#!/usr/bin/env node
/**
 * Oracle Docker deployment orchestrator. Run from a trusted workstation:
 *
 *   node --import tsx/esm scripts/ops/oracle-deploy.mjs status
 *   node --import tsx/esm scripts/ops/oracle-deploy.mjs qualify --image <ref> --sha <sha>
 *   node --import tsx/esm scripts/ops/oracle-deploy.mjs promote --image <ref> --sha <sha>
 *   node --import tsx/esm scripts/ops/oracle-deploy.mjs rollback
 *
 * The remote helper receives runtime values as argv and performs only fixed,
 * validated operations inside /home/ubuntu/OmniRoute-src.
 */

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

import {
  evaluateLocalRuntimeGate,
  isImmutableOmniRouteImage,
  promoteWithRollback,
} from "./oracleDeploy.ts";

const REMOTE_HELPER = "/home/ubuntu/OmniRoute-src/scripts/ops/oracle-deploy-remote.sh";
const DEFAULT_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];
const MODEL_CATALOG_TIMEOUT_MS = 60_000;
const PUBLIC_ORIGIN = "https://squrvq.tail0bec0f.ts.net";
const PUBLIC_WS_URL = "wss://squrvq.tail0bec0f.ts.net/live-ws";

function parseArgs(argv) {
  const args = {
    command: argv[0] || "status",
    host: "oracle-vps",
    models: [],
    dryRun: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--host") {
      args.host = value;
      index += 1;
    } else if (flag === "--image") {
      args.image = value;
      index += 1;
    } else if (flag === "--sha") {
      args.sha = value;
      index += 1;
    } else if (flag === "--model") {
      args.models.push(value);
      index += 1;
    } else if (flag === "--dry-run") {
      args.dryRun = true;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function validateHost(host) {
  if (!/^[A-Za-z0-9_.@-]+$/.test(host)) throw new Error("invalid SSH host");
}

function runRemote(host, action, values = [], options = {}) {
  validateHost(host);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(action)) throw new Error("invalid remote action");
  if (!values.every((value) => typeof value === "string")) {
    throw new Error("remote values must be strings");
  }
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    host,
    "bash",
    REMOTE_HELPER,
    "dispatch-json",
  ];
  const result = spawnSync("ssh", args, {
    encoding: "utf8",
    input: JSON.stringify({ action, values, payload: options.input ?? null }),
    timeout: options.timeoutMs ?? 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "remote command failed").trim();
    throw new Error(`${action}: ${detail}`);
  }
  return (result.stdout || "").trim();
}

function readRemoteJson(host, action, values = [], options = {}) {
  return JSON.parse(runRemote(host, action, values, options));
}

async function waitForComboLogEvidence(host, databasePath, sinceTimestamp) {
  let evidence = { comboRows: 0, forbiddenPreviewRows: 0 };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    evidence = readRemoteJson(host, "combo-log-evidence", [databasePath, sinceTimestamp]);
    if (evidence.comboRows > 0) return evidence;
    await sleep(500);
  }
  return evidence;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTunnel(host, localPort, remotePort, callback) {
  validateHost(host);
  const tunnel = spawn(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-N",
      "-L",
      `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      host,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  let tunnelError = "";
  tunnel.stderr.on("data", (chunk) => {
    tunnelError += chunk.toString();
  });
  await sleep(1_000);
  if (tunnel.exitCode !== null) {
    throw new Error(`SSH tunnel failed: ${tunnelError.trim()}`);
  }
  try {
    return await callback(`http://127.0.0.1:${localPort}`);
  } finally {
    tunnel.kill("SIGTERM");
  }
}

function requestHeaders(extra = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  const apiKey = requireSmokeApiKey();
  headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function requireSmokeApiKey() {
  const apiKey = process.env.OMNIROUTE_SMOKE_API_KEY?.trim();
  if (!apiKey) throw new Error("OMNIROUTE_SMOKE_API_KEY is required for deployment gates");
  return apiKey;
}

async function waitForHealth(baseUrl) {
  let lastError = "health did not become ready";
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const response = await fetch(new URL("/api/monitoring/health", baseUrl), {
        headers: requestHeaders(),
        signal: AbortSignal.timeout(8_000),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.status === "healthy") return true;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(5_000);
  }
  throw new Error(lastError);
}

async function probeCompletion(baseUrl, model) {
  try {
    const response = await fetch(new URL("/v1/chat/completions", baseUrl), {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: 24,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await response.json().catch(() => null);
    const content = body?.choices?.[0]?.message?.content;
    return response.ok && typeof content === "string" && content.trim().length > 0;
  } catch {
    return false;
  }
}

async function probeStreaming(baseUrl, model) {
  try {
    const response = await fetch(new URL("/v1/chat/completions", baseUrl), {
      method: "POST",
      headers: requestHeaders(),
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        max_tokens: 24,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) return false;
    const text = await response.text();
    return text.includes("data:") && text.includes("[DONE]") && text.trim().length > 0;
  } catch {
    return false;
  }
}

async function probeModels(baseUrl, expectedModels) {
  try {
    const unauthenticated = await fetch(new URL("/v1/models", baseUrl), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    const authenticated = await fetch(new URL("/v1/models", baseUrl), {
      headers: requestHeaders({ Accept: "application/json" }),
      signal: AbortSignal.timeout(MODEL_CATALOG_TIMEOUT_MS),
    });
    const body = await authenticated.json().catch(() => null);
    const ids = Array.isArray(body?.data)
      ? body.data.map((entry) => entry?.id).filter((id) => typeof id === "string")
      : null;
    const allPresent =
      Array.isArray(ids) &&
      Array.isArray(expectedModels) &&
      expectedModels.length > 0 &&
      expectedModels.every((model) => ids.includes(model));
    return {
      unauthenticatedStatus: unauthenticated.status,
      authenticatedStatus: authenticated.status,
      modelIds: ids,
      ok: unauthenticated.status === 401 && authenticated.status === 200 && allPresent,
    };
  } catch {
    return {
      unauthenticatedStatus: null,
      authenticatedStatus: null,
      modelIds: null,
      ok: false,
    };
  }
}

async function probeDashboard(baseUrl) {
  try {
    const res = await fetch(new URL("/", baseUrl), {
      headers: requestHeaders(),
      signal: AbortSignal.timeout(8_000),
    });
    const text = await res.text().catch(() => "");
    return res.ok && /<html/i.test(text);
  } catch {
    return false;
  }
}
async function probeHealthz(baseUrl) {
  try {
    const res = await fetch(new URL("/healthz", baseUrl), {
      headers: {},
      signal: AbortSignal.timeout(8_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}
async function probeLiveWs(baseUrl, origin = PUBLIC_ORIGIN) {
  // Protocol-level LiveWS gate. It intentionally sends both Authorization and
  // Origin because a TCP connection alone does not prove the public gateway's
  // auth/origin policy.
  const wsUrl = baseUrl.startsWith("ws") ? baseUrl : baseUrl.replace(/^http/, "ws") + "/live-ws";
  try {
    const WebSocket = (await import("ws")).default;
    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${requireSmokeApiKey()}`,
        Origin: origin,
      },
    });
    const ok = await new Promise((resolve) => {
      let settled = false;
      let timer;
      const done = (v) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        resolve(v);
      };
      ws.on("open", () => {
        try {
          ws.send(JSON.stringify({ type: "subscribe", channels: ["requests"] }));
        } catch {
          done(false);
        }
      });
      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message?.type === "welcome") done(true);
        } catch {
          done(false);
        }
      });
      ws.on("error", () => done(false));
      timer = setTimeout(() => done(false), 8000);
    });
    return ok;
  } catch {
    return false;
  }
}
async function probePublicHealthz() {
  try {
    const res = await fetch(`${PUBLIC_ORIGIN}/healthz`, { signal: AbortSignal.timeout(8_000) });
    return res.status;
  } catch {
    return null;
  }
}
async function probePublicModelsAuth(expectedModels) {
  const result = await probeModels(PUBLIC_ORIGIN, expectedModels);
  return {
    unauthenticatedStatus: result.unauthenticatedStatus,
    authenticatedStatus: result.authenticatedStatus,
    modelIds: result.modelIds,
    ok: result.ok,
  };
}
async function probePublicCompletion(model) {
  return probeCompletion(PUBLIC_ORIGIN, model);
}
async function runTrafficProbesWithGates(dashboardUrl, apiUrl, models) {
  await waitForHealth(dashboardUrl);
  const dashOk = await probeDashboard(dashboardUrl);
  const healthOk = await probeHealthz(dashboardUrl);
  const liveWsOk = await probeLiveWs(dashboardUrl, PUBLIC_ORIGIN);
  const core = await runTrafficProbes(apiUrl, models);
  return { ...core, dashboardOk: dashOk, healthOk, liveWsOk };
}
async function runTrafficProbes(baseUrl, models) {
  const modelProbe = await probeModels(baseUrl, models);
  const completionResults = [];
  for (const model of models) {
    const ok = await probeCompletion(baseUrl, model);
    console.log(`[probe] ${model}: ${ok ? "ok" : "failed"}`);
    completionResults.push(ok);
  }
  const streamingOk = await probeStreaming(baseUrl, models[0]);
  const comboModel = models.includes("gpt-5.6-luna") ? "gpt-5.6-luna" : models[0];
  const comboRequestOk = await probeCompletion(baseUrl, comboModel);
  return {
    modelsOk: modelProbe.ok,
    modelIds: modelProbe.modelIds,
    modelsUnauthenticatedStatus: modelProbe.unauthenticatedStatus,
    modelsAuthenticatedStatus: modelProbe.authenticatedStatus,
    completionOk: completionResults.every(Boolean),
    comboRequestOk,
    streamingOk,
  };
}

function requireCandidate(args) {
  if (!args.image || !isImmutableOmniRouteImage(args.image)) {
    throw new Error("--image must be an immutable digest or SHA-bearing tag");
  }
  if (!args.sha || !/^[a-f0-9]{7,40}$/.test(args.sha)) {
    throw new Error("--sha must be a 7-40 character lowercase Git SHA");
  }
  return { imageRef: args.image, buildSha: args.sha };
}

function sanitizeFailure(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/Bearer\s+[^\s]+/gi, "Bearer <redacted>")
    .replace(/https?:\/\/[^\s]+/gi, "<url-redacted>")
    .slice(0, 240);
}

async function withDualTunnels(host, canary, callback) {
  return withTunnel(host, canary ? 30130 : 31130, canary ? 30130 : 20130, async (dashUrl) => {
    return withTunnel(host, canary ? 30131 : 31131, canary ? 30131 : 20131, async (apiUrl) => {
      return callback({ dashboard: dashUrl, api: apiUrl });
    });
  });
}

async function qualify(host, input, models) {
  requireSmokeApiKey();
  runRemote(host, "lock-canary");
  let canaryDir = null;
  try {
    runRemote(host, "preflight");
    const image = readRemoteJson(host, "inspect-image", [input.imageRef]);
    if (image.revision !== input.buildSha) {
      throw new Error(
        `image revision ${image.revision || "(missing)"} does not match ${input.buildSha}`
      );
    }
    canaryDir = runRemote(host, "prepare-canary", [input.buildSha], {
      timeoutMs: 600_000,
    });
    const databasePath = `${canaryDir}/storage.sqlite`;
    const before = runRemote(host, "call-log-max", [databasePath]);
    try {
      runRemote(host, "start-canary", [input.imageRef, input.buildSha, canaryDir], {
        timeoutMs: 600_000,
      });
      const probes = await withDualTunnels(host, true, ({ dashboard, api }) =>
        runTrafficProbesWithGates(dashboard, api, models)
      );
      const after = runRemote(host, "call-log-max", [databasePath]);
      const comboEvidence = await waitForComboLogEvidence(host, databasePath, before);
      const runtime = readRemoteJson(host, "inspect-canary");
      const gate = {
        containerName: String(runtime.containerName || "").replace(/^\//, "") || null,
        containerStatus: runtime.status ?? null,
        healthStatus: runtime.health ?? null,
        expectedBuildSha: input.buildSha,
        actualBuildSha: image.revision,
        actualImageId: runtime.imageId,
        expectedImageId: image.imageId,
        restartCount: runtime.restartCount ?? null,
        oomKilled: runtime.oomKilled ?? null,
        memoryBytes: runtime.memoryBytes ?? null,
        nanoCpus: runtime.nanoCpus ?? null,
        dashboardOk: probes.dashboardOk,
        healthOk: probes.healthOk,
        apiModelsOk: probes.modelsOk,
        completionOk: probes.completionOk,
        streamingOk: probes.streamingOk,
        comboOk:
          probes.comboRequestOk &&
          comboEvidence.comboRows > 0 &&
          comboEvidence.forbiddenPreviewRows === 0,
        callLogAdvanced: Boolean(after) && after > before,
        liveWsOk: probes.liveWsOk,
      };
      const verdict = evaluateLocalRuntimeGate(gate);
      if (!verdict.ok) throw new Error(`qualification failed: ${verdict.failures.join("; ")}`);
      return { imageId: image.imageId, gate };
    } finally {
      runRemote(host, "stop-canary", [], { timeoutMs: 300_000 });
    }
  } finally {
    try {
      if (canaryDir) {
        runRemote(host, "delete-canary-data", [canaryDir], { timeoutMs: 300_000 });
      }
    } finally {
      runRemote(host, "unlock-canary");
    }
  }
}

async function promote(host, candidate, models) {
  const qualified = await qualify(host, candidate, models);
  let previousBuildSha = null;
  let logBefore = "";
  let configBackupHash = null;

  const adapter = {
    acquireLock: async () => runRemote(host, "lock"),
    releaseLock: async () => runRemote(host, "unlock"),
    captureCurrent: async () => {
      const runtime = readRemoteJson(host, "inspect-prod");
      const image = readRemoteJson(host, "inspect-image", [runtime.imageRef]);
      const composeHash = runRemote(host, "compose-hash");
      previousBuildSha = image.revision || runtime.imageRef.match(/[a-f0-9]{7,40}/)?.[0] || null;
      logBefore = runRemote(host, "call-log-max");
      return {
        imageRef: runtime.imageRef,
        imageId: runtime.imageId,
        buildSha: previousBuildSha,
        composeHash,
      };
    },
    backupDatabase: async () => runRemote(host, "backup", [], { timeoutMs: 600_000 }),
    tagRollback: async (_rollbackRef, imageId) => runRemote(host, "tag-rollback", [imageId]),
    tagGatewayRollback: async (rollbackRef) =>
      runRemote(host, "tag-gateway-rollback", [rollbackRef]),
    backupGateway: async () => readRemoteJson(host, "backup-gateway", [], { timeoutMs: 300_000 }),
    backupConfig: async () => {
      const backup = await readRemoteJson(host, "backup-config", [], { timeoutMs: 60_000 });
      configBackupHash = backup.hash;
      return backup;
    },
    reconcileEnvironment: async () => runRemote(host, "reconcile-squrvq-env"),
    writeCandidateImage: async (imageRef) =>
      runRemote(host, "set-image", [imageRef, candidate.buildSha]),
    recreateProduction: async () => runRemote(host, "recreate-prod", [], { timeoutMs: 600_000 }),
    probeLocalGates: async () => {
      const probes = await withDualTunnels(host, false, ({ dashboard, api }) =>
        runTrafficProbesWithGates(dashboard, api, models)
      );
      const after = runRemote(host, "call-log-max");
      const comboEvidence = await waitForComboLogEvidence(host, "", logBefore);
      const runtime = readRemoteJson(host, "inspect-prod");
      const image = readRemoteJson(host, "inspect-image", [candidate.imageRef]);
      return {
        containerName: String(runtime.containerName || "").replace(/^\//, "") || null,
        containerStatus: runtime.status ?? null,
        healthStatus: runtime.health ?? null,
        expectedBuildSha: candidate.buildSha,
        actualBuildSha: image.revision,
        expectedImageId: qualified.imageId,
        actualImageId: runtime.imageId,
        restartCount: runtime.restartCount ?? null,
        oomKilled: runtime.oomKilled ?? null,
        memoryBytes: runtime.memoryBytes ?? null,
        nanoCpus: runtime.nanoCpus ?? null,
        dashboardOk: probes.dashboardOk,
        healthOk: probes.healthOk,
        apiModelsOk: probes.modelsOk,
        completionOk: probes.completionOk,
        streamingOk: probes.streamingOk,
        comboOk:
          probes.comboRequestOk &&
          comboEvidence.comboRows > 0 &&
          comboEvidence.forbiddenPreviewRows === 0,
        callLogAdvanced: Boolean(after) && after > logBefore,
        liveWsOk: probes.liveWsOk,
      };
    },
    reconcileGateway: async () => runRemote(host, "reconcile-gateway", [], { timeoutMs: 60_000 }),
    probePublicGates: async () => {
      const modelsProbe = await probePublicModelsAuth(models);
      return {
        healthzStatus: await probePublicHealthz(),
        unauthenticatedModelsStatus: modelsProbe.unauthenticatedStatus,
        authenticatedModelsStatus: modelsProbe.authenticatedStatus,
        authenticatedModelIds: modelsProbe.modelIds,
        configuredSmokeModels: models,
        completionOk: await probePublicCompletion(models[0]),
        liveWsOk: await probeLiveWs(PUBLIC_WS_URL, PUBLIC_ORIGIN),
      };
    },
    restoreGateway: async (backupDir) =>
      runRemote(host, "restore-gateway", [backupDir], { timeoutMs: 300_000 }),
    restoreConfig: async (backupPath) =>
      runRemote(host, "restore-config", [backupPath, configBackupHash || ""], {
        timeoutMs: 60_000,
      }),
    restorePreviousImage: async (imageRef, imageId) => {
      if (!previousBuildSha) throw new Error("previous build SHA is unavailable");
      runRemote(host, "verify-rollback-tag", [imageId]);
      runRemote(host, "set-image", [imageRef, previousBuildSha]);
    },
    verifyRollback: async (imageId) => {
      try {
        runRemote(host, "verify-image", [imageId]);
        return withDualTunnels(host, false, async ({ dashboard, api }) => {
          await waitForHealth(dashboard);
          const [dashboardOk, completionOk] = await Promise.all([
            probeDashboard(dashboard),
            probeCompletion(api, models[0]),
          ]);
          return dashboardOk && completionOk;
        });
      } catch {
        return false;
      }
    },
    writeManifest: async (manifest) =>
      runRemote(host, "write-manifest", [], { input: `${JSON.stringify(manifest)}\n` }),
  };

  return promoteWithRollback(
    {
      imageRef: candidate.imageRef,
      imageId: qualified.imageId,
      buildSha: candidate.buildSha,
    },
    adapter
  );
}

async function rollback(host, models) {
  requireSmokeApiKey();
  runRemote(host, "lock");
  let manifest = null;
  let mutationStarted = false;
  try {
    manifest = readRemoteJson(host, "read-manifest");
    if (manifest?.schemaVersion !== 2) {
      throw new Error("deployment manifest is not schema version 2");
    }
    if (manifest?.state === "rolled_back") {
      throw new Error("the latest promotion is already rolled back");
    }
    if (manifest?.state !== "active") {
      throw new Error("deployment manifest is not active");
    }
    if (runRemote(host, "compose-hash") !== manifest?.composeHash) {
      throw new Error("effective Compose configuration changed since promotion");
    }
    if (
      !manifest.gatewayBackupDir ||
      !manifest.configBackupPath ||
      !manifest.envHash ||
      !manifest.tsGatewayImage
    ) {
      throw new Error("deployment manifest has no complete gateway/config rollback state");
    }
    const rollbackTarget = manifest?.rollback;
    if (!rollbackTarget?.imageRef || !rollbackTarget?.imageId || !rollbackTarget?.buildSha) {
      throw new Error("deployment manifest has no complete rollback target");
    }
    const image = readRemoteJson(host, "inspect-image", [rollbackTarget.imageRef]);
    if (image.imageId !== rollbackTarget.imageId) {
      throw new Error("rollback tag no longer resolves to the recorded image ID");
    }
    const currentTarget = manifest?.current;
    if (
      !currentTarget?.imageRef ||
      !currentTarget?.imageId ||
      !currentTarget?.buildSha ||
      !isImmutableOmniRouteImage(currentTarget.imageRef)
    ) {
      throw new Error("deployment manifest has no recoverable current target");
    }
    mutationStarted = true;
    // Keep manual rollback in the same component order as automatic rollback:
    // gateway state/config first, then environment, then the application image.
    runRemote(host, "restore-gateway", [manifest.gatewayBackupDir], { timeoutMs: 300_000 });
    runRemote(host, "restore-config", [manifest.configBackupPath, manifest.envHash], {
      timeoutMs: 60_000,
    });
    runRemote(host, "set-image", [rollbackTarget.imageRef, rollbackTarget.buildSha]);
    runRemote(host, "recreate-prod", [], { timeoutMs: 600_000 });
    runRemote(host, "verify-image", [rollbackTarget.imageId]);
    const smokeOk = await withDualTunnels(host, false, async ({ dashboard, api }) => {
      await waitForHealth(dashboard);
      const [dashboardOk, completionOk] = await Promise.all([
        probeDashboard(dashboard),
        probeCompletion(api, models[0]),
      ]);
      return dashboardOk && completionOk;
    });
    if (!smokeOk) throw new Error("rollback completion probe failed");
    const rolledBackManifest = {
      ...manifest,
      state: "rolled_back",
      current: rollbackTarget,
      failures: ["manual rollback"],
    };
    runRemote(host, "write-manifest", [], {
      input: `${JSON.stringify(rolledBackManifest)}\n`,
    });
  } catch (error) {
    const currentTarget = manifest?.current;
    if (mutationStarted && manifest?.schemaVersion === 2) {
      const failures = [];
      try {
        runRemote(host, "restore-gateway", [manifest.gatewayBackupDir], { timeoutMs: 300_000 });
      } catch (restoreError) {
        failures.push(`gateway restoration failed: ${sanitizeFailure(restoreError)}`);
      }
      try {
        runRemote(host, "restore-config", [manifest.configBackupPath, manifest.envHash], {
          timeoutMs: 60_000,
        });
      } catch (restoreError) {
        failures.push(`config restoration failed: ${sanitizeFailure(restoreError)}`);
      }
      try {
        if (!currentTarget?.imageRef || !currentTarget?.buildSha) {
          throw new Error("current target is incomplete");
        }
        runRemote(host, "set-image", [currentTarget.imageRef, currentTarget.buildSha]);
        runRemote(host, "recreate-prod", [], { timeoutMs: 600_000 });
        runRemote(host, "verify-image", [currentTarget.imageId]);
      } catch (restoreError) {
        failures.push(`image restoration failed: ${sanitizeFailure(restoreError)}`);
      }
      try {
        runRemote(host, "write-manifest", [], {
          input: `${JSON.stringify({
            ...manifest,
            state: "rollback_failed",
            failures,
          })}\n`,
        });
      } catch (manifestError) {
        failures.push(`manifest restoration failed: ${sanitizeFailure(manifestError)}`);
      }
      const original = sanitizeFailure(error);
      throw new Error(`${original}; rollback_failed: ${failures.join("; ")}`);
    }
    throw error;
  } finally {
    runRemote(host, "unlock");
  }
}

const args = parseArgs(process.argv.slice(2));
const models = args.models.length > 0 ? args.models : DEFAULT_MODELS;

try {
  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          command: args.command,
          host: args.host,
          image: args.image ?? null,
          sha: args.sha ?? null,
          models,
          remoteHelper: REMOTE_HELPER,
        },
        null,
        2
      )
    );
  } else if (args.command === "status") {
    console.log(runRemote(args.host, "status", [], { timeoutMs: 30_000 }));
  } else if (args.command === "qualify") {
    const candidate = requireCandidate(args);
    const result = await qualify(args.host, candidate, models);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else if (args.command === "promote") {
    const candidate = requireCandidate(args);
    const result = await promote(args.host, candidate, models);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else if (args.command === "rollback") {
    await rollback(args.host, models);
    console.log("rollback verified");
  } else if (args.command === "adopt-gateway") {
    console.log(runRemote(args.host, "adopt-gateway", [], { timeoutMs: 600_000 }));
  } else {
    throw new Error("command must be status, qualify, promote, rollback, or adopt-gateway");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
