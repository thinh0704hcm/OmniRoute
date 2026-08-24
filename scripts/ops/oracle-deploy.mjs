#!/usr/bin/env node
/**
 * Oracle Docker deployment orchestrator. Run from a trusted workstation:
 *
 *   node --import tsx/esm scripts/ops/oracle-deploy.mjs status
 *   node --import tsx/esm scripts/ops/oracle-deploy.mjs qualify --image <ref> --ops-image <ref> --sha <sha>
 *   node --import tsx/esm scripts/ops/oracle-deploy.mjs promote --image <ref> --ops-image <ref> --sha <sha>
 *   node --import tsx/esm scripts/ops/oracle-deploy.mjs rollback
 *
 * The remote helper receives runtime values as argv and performs only fixed,
 * validated operations inside /home/ubuntu/OmniRoute-src.
 */

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

import {
  evaluateRuntimeGate,
  isImmutableOmniRouteImage,
  promoteWithRollback,
} from "./oracleDeploy.ts";

const REMOTE_HELPER = "/home/ubuntu/OmniRoute-src/scripts/ops/oracle-deploy-remote.sh";
const DEFAULT_MODELS = ["gpt-5.4-mini", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];

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
    } else if (flag === "--ops-image") {
      args.opsImage = value;
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

function readRemoteJson(host, action, values = []) {
  return JSON.parse(runRemote(host, action, values));
}

async function waitForComboLogEvidence(host, databasePath, sinceTimestamp) {
  let evidence = { comboRows: 0, xPreviewRows: 0 };
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
  const apiKey = process.env.OMNIROUTE_SMOKE_API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
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
  return response.ok && Array.isArray(body?.choices) && body.choices.length > 0;
}

async function probeStreaming(baseUrl, model) {
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
  return text.includes("data:") && text.includes("[DONE]");
}

async function probeMixedCaseTool(baseUrl, model) {
  const headers = requestHeaders({
    "anthropic-version": "2023-06-01",
  });
  const firstRequest = {
    model,
    max_tokens: 128,
    tools: [
      {
        name: "GetTestValue",
        description: "Return the deterministic test value.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    tool_choice: { type: "tool", name: "GetTestValue" },
    messages: [
      {
        role: "user",
        content: "Call GetTestValue exactly once. Do not answer before calling the tool.",
      },
    ],
  };
  const first = await fetch(new URL("/v1/messages", baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(firstRequest),
    signal: AbortSignal.timeout(180_000),
  });
  const firstBody = await first.json().catch(() => null);
  const toolUse = Array.isArray(firstBody?.content)
    ? firstBody.content.find((block) => block?.type === "tool_use")
    : null;
  if (!first.ok || toolUse?.name !== "GetTestValue" || !toolUse?.id) return false;

  const second = await fetch(new URL("/v1/messages", baseUrl), {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...firstRequest,
      tool_choice: { type: "auto" },
      messages: [
        firstRequest.messages[0],
        { role: "assistant", content: firstBody.content },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "42" }],
        },
      ],
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const secondBody = await second.json().catch(() => null);
  const text = Array.isArray(secondBody?.content)
    ? secondBody.content
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("")
    : "";
  return second.ok && text.includes("42");
}

async function runTrafficProbes(baseUrl, models) {
  await waitForHealth(baseUrl);
  const completionResults = [];
  for (const model of models) {
    const ok = await probeCompletion(baseUrl, model);
    console.log(`[probe] ${model}: ${ok ? "ok" : "failed"}`);
    completionResults.push(ok);
  }
  const streamingOk = await probeStreaming(baseUrl, models[0]);
  const comboModel = models.includes("gpt-5.6-luna") ? "gpt-5.6-luna" : models[0];
  const comboRequestOk = await probeCompletion(baseUrl, comboModel);
  const mixedCaseResults = [];
  for (const model of models) {
    const ok = await probeMixedCaseTool(baseUrl, model);
    console.log(`[tool-probe] ${model}: ${ok ? "ok" : "failed"}`);
    mixedCaseResults.push(ok);
  }
  return {
    completionOk: completionResults.every(Boolean),
    comboRequestOk,
    streamingOk,
    mixedCaseToolOk: mixedCaseResults.every(Boolean),
  };
}

function requireCandidate(args) {
  if (!args.image || !isImmutableOmniRouteImage(args.image)) {
    throw new Error("--image must be an immutable digest or SHA-bearing tag");
  }
  if (!args.sha || !/^[a-f0-9]{7,40}$/.test(args.sha)) {
    throw new Error("--sha must be a 7-40 character lowercase Git SHA");
  }
  if (!args.opsImage || !isImmutableOmniRouteImage(args.opsImage)) {
    throw new Error("--ops-image must be an immutable digest or SHA-bearing tag");
  }
  return { imageRef: args.image, opsImageRef: args.opsImage, buildSha: args.sha };
}

async function qualify(host, input, models) {
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
    const opsImage = readRemoteJson(host, "inspect-image", [input.opsImageRef]);
    if (opsImage.revision !== input.buildSha) {
      throw new Error(
        `ops image revision ${opsImage.revision || "(missing)"} does not match ${input.buildSha}`
      );
    }
    canaryDir = runRemote(host, "prepare-canary", [input.buildSha], {
      timeoutMs: 600_000,
    });
    runRemote(host, "reconcile-combos", [input.opsImageRef, canaryDir], {
      timeoutMs: 600_000,
    });
    const databasePath = `${canaryDir}/storage.sqlite`;
    const before = runRemote(host, "call-log-max", [databasePath]);
    try {
      runRemote(host, "start-canary", [input.imageRef, input.buildSha, canaryDir], {
        timeoutMs: 600_000,
      });
      const probes = await withTunnel(host, 30130, 30130, (baseUrl) =>
        runTrafficProbes(baseUrl, models)
      );
      const after = runRemote(host, "call-log-max", [databasePath]);
      const comboEvidence = await waitForComboLogEvidence(host, databasePath, before);
      const runtime = readRemoteJson(host, "inspect-canary");
      const gate = {
        healthy: runtime.status === "running" && runtime.health === "healthy",
        expectedBuildSha: input.buildSha,
        actualBuildSha: image.revision,
        expectedImageId: image.imageId,
        actualImageId: runtime.imageId,
        restartCount: runtime.restartCount,
        completionOk: probes.completionOk,
        streamingOk: probes.streamingOk,
        mixedCaseToolOk: probes.mixedCaseToolOk,
        comboOk:
          probes.comboRequestOk && comboEvidence.comboRows > 0 && comboEvidence.xPreviewRows === 0,
        callLogAdvanced: Boolean(after) && after > before,
      };
      const verdict = evaluateRuntimeGate(gate);
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
    reconcileConfiguration: async () =>
      runRemote(host, "reconcile-combos", [candidate.opsImageRef, "production"], {
        timeoutMs: 600_000,
      }),
    writeCandidateImage: async (imageRef) =>
      runRemote(host, "set-image", [imageRef, candidate.buildSha]),
    recreateProduction: async () => runRemote(host, "recreate-prod", [], { timeoutMs: 600_000 }),
    probeRuntime: async () => {
      const probes = await withTunnel(host, 31130, 20130, (baseUrl) =>
        runTrafficProbes(baseUrl, models)
      );
      const after = runRemote(host, "call-log-max");
      const comboEvidence = await waitForComboLogEvidence(host, "", logBefore);
      const runtime = readRemoteJson(host, "inspect-prod");
      const image = readRemoteJson(host, "inspect-image", [candidate.imageRef]);
      return {
        healthy: runtime.status === "running" && runtime.health === "healthy",
        expectedBuildSha: candidate.buildSha,
        actualBuildSha: image.revision,
        expectedImageId: qualified.imageId,
        actualImageId: runtime.imageId,
        restartCount: runtime.restartCount,
        completionOk: probes.completionOk,
        streamingOk: probes.streamingOk,
        mixedCaseToolOk: probes.mixedCaseToolOk,
        comboOk:
          probes.comboRequestOk && comboEvidence.comboRows > 0 && comboEvidence.xPreviewRows === 0,
        callLogAdvanced: Boolean(after) && after > logBefore,
      };
    },
    restorePreviousImage: async (imageRef, imageId) => {
      if (!previousBuildSha) throw new Error("previous build SHA is unavailable");
      runRemote(host, "verify-rollback-tag", [imageId]);
      runRemote(host, "set-image", [imageRef, previousBuildSha]);
    },
    verifyRollback: async (imageId) => {
      try {
        runRemote(host, "verify-image", [imageId]);
        return withTunnel(host, 33130, 20130, async (baseUrl) => {
          await waitForHealth(baseUrl);
          return probeCompletion(baseUrl, models[0]);
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
  runRemote(host, "lock");
  let manifest = null;
  let cutoverStarted = false;
  try {
    manifest = readRemoteJson(host, "read-manifest");
    if (manifest?.state === "rolled_back") {
      throw new Error("the latest promotion is already rolled back");
    }
    if (runRemote(host, "compose-hash") !== manifest?.composeHash) {
      throw new Error("effective Compose configuration changed since promotion");
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
    cutoverStarted = true;
    runRemote(host, "set-image", [rollbackTarget.imageRef, rollbackTarget.buildSha]);
    runRemote(host, "recreate-prod", [], { timeoutMs: 600_000 });
    runRemote(host, "verify-image", [rollbackTarget.imageId]);
    const smokeOk = await withTunnel(host, 32130, 20130, async (baseUrl) => {
      await waitForHealth(baseUrl);
      return probeCompletion(baseUrl, models[0]);
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
    if (
      cutoverStarted &&
      currentTarget?.imageRef &&
      currentTarget?.imageId &&
      currentTarget?.buildSha
    ) {
      try {
        runRemote(host, "set-image", [currentTarget.imageRef, currentTarget.buildSha]);
        runRemote(host, "recreate-prod", [], { timeoutMs: 600_000 });
        runRemote(host, "verify-image", [currentTarget.imageId]);
      } catch (restoreError) {
        const original = error instanceof Error ? error.message : String(error);
        const restore = restoreError instanceof Error ? restoreError.message : String(restoreError);
        throw new Error(`${original}; candidate restoration also failed: ${restore}`);
      }
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
          opsImage: args.opsImage ?? null,
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
  } else {
    throw new Error("command must be status, qualify, promote, or rollback");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
