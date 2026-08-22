/**
 * Bounded, idempotent recovery of call-log summary rows from filesystem artifacts.
 *
 * This is intentionally an operator-only DB domain operation. Runtime request
 * logging remains owned by src/lib/usage/callLogs.ts.
 */

import fs from "node:fs";
import path from "node:path";

import { classifyProviderError } from "@omniroute/open-sse/services/errorClassifier.ts";

import {
  buildArtifactRelativePath,
  computeCallLogArtifactChecksum,
  listCallLogArtifactFiles,
} from "../usage/callLogArtifacts";
import type { SqliteAdapter } from "./adapters/types";

type JsonRecord = Record<string, unknown>;

type RecoveryRow = {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  status: number;
  model: string;
  requestedModel: string | null;
  provider: string;
  account: string;
  connectionId: string | null;
  duration: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number | null;
  tokensCacheCreation: number | null;
  tokensReasoning: number | null;
  tokensCompressed: number | null;
  requestType: string | null;
  sourceFormat: string | null;
  targetFormat: string | null;
  apiKeyId: string | null;
  apiKeyName: string | null;
  comboName: string | null;
  comboStepId: string | null;
  comboExecutionKey: string | null;
  errorSummary: string | null;
  errorType: string | null;
  detailState: "ready";
  artifactRelPath: string;
  artifactSizeBytes: number;
  artifactSha256: string;
  hasRequestBody: number;
  hasResponseBody: number;
  hasPipelineDetails: number;
  requestSummary: string | null;
  responseId: string | null;
};

export type CallLogRecoveryIssue = {
  artifact: string;
  kind: "corrupt" | "invalid" | "checksum_mismatch" | "collision";
  reason: string;
};

export type CallLogRecoveryResult = {
  dryRun: boolean;
  fromExclusive: string;
  throughInclusive: string;
  scanned: number;
  outOfWindow: number;
  valid: number;
  wouldInsert: number;
  inserted: number;
  duplicates: number;
  collisions: number;
  corrupt: number;
  invalid: number;
  checksumMismatches: number;
  capacitySkipped: number;
  issues: CallLogRecoveryIssue[];
};

export type RecoverCallLogsOptions = {
  artifactDir: string;
  fromExclusive: string;
  throughInclusive: string;
  apply?: boolean;
  maxRows?: number;
  maxReportedIssues?: number;
};

const REQUIRED_COLUMNS = [
  "id",
  "timestamp",
  "method",
  "path",
  "status",
  "model",
  "requested_model",
  "provider",
  "account",
  "connection_id",
  "duration",
  "tokens_in",
  "tokens_out",
  "tokens_cache_read",
  "tokens_cache_creation",
  "tokens_reasoning",
  "tokens_compressed",
  "reasoning_source",
  "reasoning_chars",
  "cache_source",
  "request_type",
  "source_format",
  "target_format",
  "api_key_id",
  "api_key_name",
  "combo_name",
  "combo_step_id",
  "combo_execution_key",
  "error_summary",
  "detail_state",
  "artifact_relpath",
  "artifact_size_bytes",
  "artifact_sha256",
  "has_request_body",
  "has_response_body",
  "has_pipeline_details",
  "request_summary",
  "correlation_id",
  "model_pinned",
  "session_tag",
  "response_id",
  "error_type",
] as const;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,240}$/;
const DEFAULT_MAX_ROWS = 100_000;
const DEFAULT_MAX_ORPHAN_FILES = 100_000;
const DATE_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function requiredString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  return value;
}

function optionalString(value: unknown, maxLength: number): string | null | undefined {
  if (value === null || value === undefined) return null;
  return requiredString(value, maxLength) ?? undefined;
}

function requiredInteger(value: unknown, min: number, max: number): number | null {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : null;
}

function optionalInteger(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return requiredInteger(value, 0, Number.MAX_SAFE_INTEGER) ?? undefined;
}

function normalizeIso(value: string, optionName: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${optionName} must be a valid timestamp`);
  return parsed.toISOString();
}

function serializeSummaryValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return serialized.length > 4000 ? serialized.slice(0, 4000) : serialized;
  } catch {
    return String(value).slice(0, 4000);
  }
}

function buildSearchSummary(requestType: string | null, requestBody: unknown): string | null {
  if (requestType !== "search") return null;
  const body = asRecord(requestBody);
  if (!body) return null;
  const summary: JsonRecord = {};
  if (typeof body.query === "string" && body.query.trim().length > 0) {
    summary.query = body.query;
  }
  const filters = Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "query" && key !== "provider")
  );
  if (Object.keys(filters).length > 0) summary.filters = filters;
  return Object.keys(summary).length > 0 ? JSON.stringify(summary) : null;
}

function extractResponseId(
  responseBody: unknown,
  pipeline: JsonRecord | null,
  targetFormat: string | null,
  requestPath: string
): string | null {
  if (targetFormat !== "openai-responses" && !requestPath.includes("/responses")) return null;
  const candidates = [asRecord(responseBody), asRecord(pipeline?.clientResponse)];
  for (const candidate of candidates) {
    const id = candidate && optionalString(candidate.id, 512);
    if (typeof id === "string") return id;
  }
  return null;
}

function buildRecoveryRow(
  artifact: JsonRecord,
  relativePath: string,
  raw: string
): { row?: RecoveryRow; reason?: string } {
  if (artifact.schemaVersion !== 5) return { reason: "unsupported schemaVersion" };
  const summary = asRecord(artifact.summary);
  if (!summary) return { reason: "summary must be an object" };

  const id = requiredString(summary.id, 240);
  const timestampValue = requiredString(summary.timestamp, 80);
  const method = requiredString(summary.method, 32);
  const requestPath = requiredString(summary.path, 4096);
  const status = requiredInteger(summary.status, 0, 599);
  const model = requiredString(summary.model, 1024);
  const provider = requiredString(summary.provider, 512);
  const account = requiredString(summary.account, 1024);
  const duration = requiredInteger(summary.duration, 0, Number.MAX_SAFE_INTEGER);
  const tokens = asRecord(summary.tokens);
  if (
    !id ||
    !SAFE_ID.test(id) ||
    !timestampValue ||
    !method ||
    !requestPath ||
    status === null ||
    !model ||
    !provider ||
    !account ||
    duration === null ||
    !tokens
  ) {
    return { reason: "summary has missing or invalid required fields" };
  }

  const timestamp = normalizeIso(timestampValue, "artifact summary timestamp");
  if (buildArtifactRelativePath(timestamp, id) !== relativePath) {
    return { reason: "artifact path does not match summary timestamp and id" };
  }

  const tokensIn = requiredInteger(tokens.in, 0, Number.MAX_SAFE_INTEGER);
  const tokensOut = requiredInteger(tokens.out, 0, Number.MAX_SAFE_INTEGER);
  const tokensCacheRead = optionalInteger(tokens.cacheRead);
  const tokensCacheCreation = optionalInteger(tokens.cacheWrite);
  const tokensReasoning = optionalInteger(tokens.reasoning);
  const tokensCompressed = optionalInteger(tokens.compressed);
  if (
    tokensIn === null ||
    tokensOut === null ||
    tokensCacheRead === undefined ||
    tokensCacheCreation === undefined ||
    tokensReasoning === undefined ||
    tokensCompressed === undefined
  ) {
    return { reason: "summary token counters are invalid" };
  }

  const nullableFields = {
    requestedModel: optionalString(summary.requestedModel, 1024),
    connectionId: optionalString(summary.connectionId, 512),
    requestType: optionalString(summary.requestType, 128),
    sourceFormat: optionalString(summary.sourceFormat, 128),
    targetFormat: optionalString(summary.targetFormat, 128),
    apiKeyId: optionalString(summary.apiKeyId, 512),
    apiKeyName: optionalString(summary.apiKeyName, 1024),
    comboName: optionalString(summary.comboName, 512),
    comboStepId: optionalString(summary.comboStepId, 512),
    comboExecutionKey: optionalString(summary.comboExecutionKey, 512),
  };
  if (Object.values(nullableFields).some((value) => value === undefined)) {
    return { reason: "summary has an invalid optional string field" };
  }

  const pipeline = asRecord(artifact.pipeline);
  const errorSummary = serializeSummaryValue(artifact.error);
  const artifactSha256 = computeCallLogArtifactChecksum(raw);
  return {
    row: {
      id,
      timestamp,
      method,
      path: requestPath,
      status,
      model,
      requestedModel: nullableFields.requestedModel ?? null,
      provider,
      account,
      connectionId: nullableFields.connectionId ?? null,
      duration,
      tokensIn,
      tokensOut,
      tokensCacheRead,
      tokensCacheCreation,
      tokensReasoning,
      tokensCompressed,
      requestType: nullableFields.requestType ?? null,
      sourceFormat: nullableFields.sourceFormat ?? null,
      targetFormat: nullableFields.targetFormat ?? null,
      apiKeyId: nullableFields.apiKeyId ?? null,
      apiKeyName: nullableFields.apiKeyName ?? null,
      comboName: nullableFields.comboName ?? null,
      comboStepId: nullableFields.comboStepId ?? null,
      comboExecutionKey: nullableFields.comboExecutionKey ?? null,
      errorSummary,
      errorType:
        status < 400 && !errorSummary
          ? null
          : classifyProviderError(status, errorSummary ?? "", provider),
      detailState: "ready",
      artifactRelPath: relativePath,
      artifactSizeBytes: Buffer.byteLength(raw),
      artifactSha256,
      hasRequestBody: artifact.requestBody !== null && artifact.requestBody !== undefined ? 1 : 0,
      hasResponseBody:
        artifact.responseBody !== null && artifact.responseBody !== undefined ? 1 : 0,
      hasPipelineDetails: pipeline && Object.keys(pipeline).length > 0 ? 1 : 0,
      requestSummary: buildSearchSummary(nullableFields.requestType ?? null, artifact.requestBody),
      responseId: extractResponseId(
        artifact.responseBody,
        pipeline,
        nullableFields.targetFormat ?? null,
        requestPath
      ),
    },
  };
}

function assertRecoverySchema(db: SqliteAdapter): void {
  const columns = db.prepare("PRAGMA table_info(call_logs)").all() as Array<{ name?: string }>;
  const names = new Set(columns.map((column) => column.name));
  const missing = REQUIRED_COLUMNS.filter((column) => !names.has(column));
  if (missing.length > 0) {
    throw new Error(`call_logs schema is missing required column(s): ${missing.join(", ")}`);
  }
}

function prepareInsert(db: SqliteAdapter) {
  return db.prepare(`
    INSERT INTO call_logs (
      id, timestamp, method, path, status, model, requested_model, provider, account,
      connection_id, duration, tokens_in, tokens_out, tokens_cache_read,
      tokens_cache_creation, tokens_reasoning, tokens_compressed, reasoning_source,
      reasoning_chars, cache_source, request_type, source_format, target_format,
      api_key_id, api_key_name, combo_name, combo_step_id, combo_execution_key,
      error_summary, detail_state, artifact_relpath, artifact_size_bytes, artifact_sha256,
      has_request_body, has_response_body, has_pipeline_details, request_summary,
      correlation_id, model_pinned, session_tag, response_id, error_type
    ) VALUES (
      @id, @timestamp, @method, @path, @status, @model, @requestedModel, @provider, @account,
      @connectionId, @duration, @tokensIn, @tokensOut, @tokensCacheRead,
      @tokensCacheCreation, @tokensReasoning, @tokensCompressed, NULL, NULL, 'upstream',
      @requestType, @sourceFormat, @targetFormat, @apiKeyId, @apiKeyName, @comboName,
      @comboStepId, @comboExecutionKey, @errorSummary, @detailState, @artifactRelPath,
      @artifactSizeBytes, @artifactSha256, @hasRequestBody, @hasResponseBody,
      @hasPipelineDetails, @requestSummary, NULL, 0, NULL, @responseId, @errorType
    )
  `);
}

export function recoverCallLogsFromArtifacts(
  db: SqliteAdapter,
  options: RecoverCallLogsOptions
): CallLogRecoveryResult {
  assertRecoverySchema(db);
  const fromExclusive = normalizeIso(options.fromExclusive, "fromExclusive");
  const throughInclusive = normalizeIso(options.throughInclusive, "throughInclusive");
  if (fromExclusive >= throughInclusive) {
    throw new Error("fromExclusive must be earlier than throughInclusive");
  }
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  if (!Number.isInteger(maxRows) || maxRows < 1)
    throw new Error("maxRows must be a positive integer");
  const maxReportedIssues = options.maxReportedIssues ?? 500;
  if (!Number.isInteger(maxReportedIssues) || maxReportedIssues < 0) {
    throw new Error("maxReportedIssues must be a non-negative integer");
  }
  if (!fs.existsSync(options.artifactDir) || !fs.statSync(options.artifactDir).isDirectory()) {
    throw new Error("artifactDir must be an existing directory");
  }

  const result: CallLogRecoveryResult = {
    dryRun: options.apply !== true,
    fromExclusive,
    throughInclusive,
    scanned: 0,
    outOfWindow: 0,
    valid: 0,
    wouldInsert: 0,
    inserted: 0,
    duplicates: 0,
    collisions: 0,
    corrupt: 0,
    invalid: 0,
    checksumMismatches: 0,
    capacitySkipped: 0,
    issues: [],
  };
  const report = (issue: CallLogRecoveryIssue) => {
    if (result.issues.length < maxReportedIssues) result.issues.push(issue);
  };

  const existingRows = db
    .prepare("SELECT id, artifact_relpath, artifact_sha256 FROM call_logs")
    .all() as Array<{
    id: string;
    artifact_relpath: string | null;
    artifact_sha256: string | null;
  }>;
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const existingByPath = new Map(
    existingRows.filter((row) => row.artifact_relpath).map((row) => [row.artifact_relpath!, row])
  );
  const candidates: RecoveryRow[] = [];
  const candidateIds = new Map<string, RecoveryRow>();
  const rejectedCandidateIds = new Set<string>();
  const firstDay = fromExclusive.slice(0, 10);
  const lastDay = throughInclusive.slice(0, 10);

  for (const file of listCallLogArtifactFiles(options.artifactDir)) {
    const artifactDay = file.relativePath.split("/", 1)[0];
    if (artifactDay < firstDay || artifactDay > lastDay) {
      result.outOfWindow++;
      continue;
    }
    result.scanned++;
    let raw: string;
    let parsed: JsonRecord | null;
    try {
      raw = fs.readFileSync(file.absPath, "utf8");
      parsed = asRecord(JSON.parse(raw));
    } catch {
      result.corrupt++;
      report({ artifact: file.relativePath, kind: "corrupt", reason: "invalid JSON" });
      continue;
    }
    if (!parsed) {
      result.invalid++;
      report({
        artifact: file.relativePath,
        kind: "invalid",
        reason: "artifact must be an object",
      });
      continue;
    }

    let built: { row?: RecoveryRow; reason?: string };
    try {
      built = buildRecoveryRow(parsed, file.relativePath, raw);
    } catch (error) {
      built = { reason: error instanceof Error ? error.message : "invalid artifact" };
    }
    if (!built.row) {
      result.invalid++;
      report({
        artifact: file.relativePath,
        kind: "invalid",
        reason: built.reason ?? "invalid artifact",
      });
      continue;
    }
    const row = built.row;
    if (row.timestamp <= fromExclusive || row.timestamp > throughInclusive) {
      result.outOfWindow++;
      continue;
    }
    result.valid++;

    const existingId = existingById.get(row.id);
    const existingPath = existingByPath.get(row.artifactRelPath);
    if (
      existingId &&
      existingId.artifact_relpath === row.artifactRelPath &&
      (!existingId.artifact_sha256 || existingId.artifact_sha256 === row.artifactSha256)
    ) {
      result.duplicates++;
      continue;
    }
    const priorCandidate = candidateIds.get(row.id);
    if (existingId || existingPath || priorCandidate) {
      const checksumMismatch = Boolean(
        (existingId?.artifact_relpath === row.artifactRelPath &&
          existingId.artifact_sha256 &&
          existingId.artifact_sha256 !== row.artifactSha256) ||
        (existingPath?.artifact_sha256 && existingPath.artifact_sha256 !== row.artifactSha256)
      );
      if (checksumMismatch) result.checksumMismatches++;
      if (priorCandidate) rejectedCandidateIds.add(row.id);
      result.collisions++;
      report({
        artifact: file.relativePath,
        kind: checksumMismatch ? "checksum_mismatch" : "collision",
        reason:
          existingId || priorCandidate
            ? "call-log id already exists"
            : "artifact path already referenced",
      });
      continue;
    }
    candidateIds.set(row.id, row);
    candidates.push(row);
  }

  const currentCount = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM call_logs").get() as { count: number }).count
  );
  const available = Math.max(0, maxRows - currentCount);
  const unambiguousCandidates = candidates.filter((row) => !rejectedCandidateIds.has(row.id));
  unambiguousCandidates.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const selected =
    available === 0
      ? []
      : unambiguousCandidates.length > available
        ? unambiguousCandidates.slice(-available)
        : unambiguousCandidates;
  result.capacitySkipped = unambiguousCandidates.length - selected.length;
  result.wouldInsert = selected.length;

  if (options.apply === true && selected.length > 0) {
    const insert = prepareInsert(db);
    const insertAll = db.transaction(() => {
      for (const row of selected) insert.run(row);
    });
    insertAll();
    result.inserted = selected.length;
  }

  return result;
}

export type CallLogOrphanIssue = {
  artifact: string;
  kind: "unsafe" | "corrupt" | "invalid" | "changed" | "unlink_failed";
  reason: string;
};

export type CallLogOrphanArtifact = {
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
};

export type CallLogOrphanInventory = {
  modifiedBeforeExclusive: string;
  scanned: number;
  atOrAfterCutoff: number;
  valid: number;
  referenced: number;
  orphanCount: number;
  orphanBytes: number;
  corrupt: number;
  invalid: number;
  unsafeEntries: number;
  orphans: CallLogOrphanArtifact[];
  issues: CallLogOrphanIssue[];
};

export type InventoryCallLogOrphansOptions = {
  artifactDir: string;
  /** Files with an mtime equal to this timestamp are excluded. */
  modifiedBeforeExclusive: string;
  maxFiles?: number;
  maxReportedIssues?: number;
};

export type PruneCallLogOrphansOptions = InventoryCallLogOrphansOptions & {
  /** Exact orphanCount printed by a preceding dry-run inventory. */
  confirmedCount: number;
  /** Exact orphanBytes printed by a preceding dry-run inventory. */
  confirmedBytes: number;
};

export type CallLogOrphanPruneResult = CallLogOrphanInventory & {
  confirmedCount: number;
  confirmedBytes: number;
  deletedCount: number;
  deletedBytes: number;
  preservedByReferenceRace: number;
  preservedChanged: number;
  unlinkErrors: number;
  emptyDayDirsRemoved: number;
};

type CallLogOrphanCandidate = CallLogOrphanArtifact & {
  absolutePath: string;
  checksum: string;
  device: number;
  inode: number;
  modifiedTimeMs: number;
};

type CallLogOrphanScan = {
  inventory: CallLogOrphanInventory;
  candidates: CallLogOrphanCandidate[];
  rootDir: string;
};

function assertCallLogArtifactReferenceSchema(db: SqliteAdapter): void {
  const columns = db.prepare("PRAGMA table_info(call_logs)").all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === "artifact_relpath")) {
    throw new Error("call_logs schema is missing required column: artifact_relpath");
  }
}

function resolveArtifactRoot(artifactDir: string): string {
  const requestedRoot = path.resolve(artifactDir);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(requestedRoot);
  } catch {
    throw new Error("artifactDir must be an existing directory");
  }
  if (!rootStat.isDirectory()) throw new Error("artifactDir must be an existing directory");
  return fs.realpathSync(requestedRoot);
}

function isBoundedChild(rootDir: string, absolutePath: string): boolean {
  const relative = path.relative(rootDir, absolutePath);
  return (
    relative.length > 0 &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function isCanonicalDayDirectory(value: string): boolean {
  if (!DATE_DIRECTORY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function scanCallLogOrphans(
  db: SqliteAdapter,
  options: InventoryCallLogOrphansOptions
): CallLogOrphanScan {
  assertCallLogArtifactReferenceSchema(db);
  const modifiedBeforeExclusive = normalizeIso(
    options.modifiedBeforeExclusive,
    "modifiedBeforeExclusive"
  );
  const cutoffMs = Date.parse(modifiedBeforeExclusive);
  if (cutoffMs >= Date.now()) {
    throw new Error("modifiedBeforeExclusive must be earlier than the current time");
  }
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_ORPHAN_FILES;
  if (!Number.isInteger(maxFiles) || maxFiles < 1) {
    throw new Error("maxFiles must be a positive integer");
  }
  const maxReportedIssues = options.maxReportedIssues ?? 500;
  if (!Number.isInteger(maxReportedIssues) || maxReportedIssues < 0) {
    throw new Error("maxReportedIssues must be a non-negative integer");
  }
  const rootDir = resolveArtifactRoot(options.artifactDir);
  const inventory: CallLogOrphanInventory = {
    modifiedBeforeExclusive,
    scanned: 0,
    atOrAfterCutoff: 0,
    valid: 0,
    referenced: 0,
    orphanCount: 0,
    orphanBytes: 0,
    corrupt: 0,
    invalid: 0,
    unsafeEntries: 0,
    orphans: [],
    issues: [],
  };
  const candidates: CallLogOrphanCandidate[] = [];
  const report = (issue: CallLogOrphanIssue) => {
    if (inventory.issues.length < maxReportedIssues) inventory.issues.push(issue);
  };
  const reportUnsafe = (artifact: string, reason: string) => {
    inventory.unsafeEntries++;
    report({ artifact, kind: "unsafe", reason });
  };
  const referenced = db.prepare(
    "SELECT 1 AS referenced FROM call_logs WHERE artifact_relpath = ? LIMIT 1"
  );

  for (const dayEntry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!dayEntry.isDirectory() || !isCanonicalDayDirectory(dayEntry.name)) {
      if (dayEntry.isSymbolicLink() || dayEntry.isDirectory()) {
        reportUnsafe(dayEntry.name, "entry is not a regular dated artifact directory");
      }
      continue;
    }
    const dayDir = path.resolve(rootDir, dayEntry.name);
    if (!isBoundedChild(rootDir, dayDir) || path.dirname(dayDir) !== rootDir) {
      reportUnsafe(dayEntry.name, "dated directory resolves outside artifactDir");
      continue;
    }
    const dayStat = fs.lstatSync(dayDir);
    if (!dayStat.isDirectory() || dayStat.isSymbolicLink()) {
      reportUnsafe(dayEntry.name, "dated directory is not a regular directory");
      continue;
    }

    for (const fileEntry of fs.readdirSync(dayDir, { withFileTypes: true })) {
      const relativePath = path.posix.join(dayEntry.name, fileEntry.name);
      if (!fileEntry.isFile()) {
        reportUnsafe(relativePath, "artifact entry is not a regular file");
        continue;
      }
      if (!fileEntry.name.endsWith(".json")) continue;
      inventory.scanned++;
      if (inventory.scanned > maxFiles) {
        throw new Error(`artifact scan exceeds maxFiles (${maxFiles})`);
      }

      const absolutePath = path.resolve(dayDir, fileEntry.name);
      if (!isBoundedChild(rootDir, absolutePath) || path.dirname(absolutePath) !== dayDir) {
        reportUnsafe(relativePath, "artifact path resolves outside its dated directory");
        continue;
      }
      let fileStat: fs.Stats;
      try {
        fileStat = fs.lstatSync(absolutePath);
      } catch {
        reportUnsafe(relativePath, "artifact disappeared during inventory");
        continue;
      }
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        reportUnsafe(relativePath, "artifact is not a regular file");
        continue;
      }
      if (fileStat.mtimeMs >= cutoffMs) {
        inventory.atOrAfterCutoff++;
        continue;
      }

      let raw: string;
      let parsed: JsonRecord | null;
      try {
        raw = fs.readFileSync(absolutePath, "utf8");
        parsed = asRecord(JSON.parse(raw));
      } catch {
        inventory.corrupt++;
        report({ artifact: relativePath, kind: "corrupt", reason: "invalid JSON" });
        continue;
      }
      if (!parsed) {
        inventory.invalid++;
        report({
          artifact: relativePath,
          kind: "invalid",
          reason: "artifact must be an object",
        });
        continue;
      }
      let built: { row?: RecoveryRow; reason?: string };
      try {
        built = buildRecoveryRow(parsed, relativePath, raw);
      } catch (error) {
        built = { reason: error instanceof Error ? error.message : "invalid artifact" };
      }
      if (!built.row) {
        inventory.invalid++;
        report({
          artifact: relativePath,
          kind: "invalid",
          reason: built.reason ?? "invalid artifact",
        });
        continue;
      }
      inventory.valid++;
      if (referenced.get(relativePath)) {
        inventory.referenced++;
        continue;
      }

      const sizeBytes = Buffer.byteLength(raw);
      if (!Number.isSafeInteger(inventory.orphanBytes + sizeBytes)) {
        throw new Error("orphan artifact bytes exceed the safe integer range");
      }
      const publicCandidate: CallLogOrphanArtifact = {
        relativePath,
        sizeBytes,
        modifiedAt: new Date(fileStat.mtimeMs).toISOString(),
      };
      inventory.orphans.push(publicCandidate);
      inventory.orphanCount++;
      inventory.orphanBytes += sizeBytes;
      candidates.push({
        ...publicCandidate,
        absolutePath,
        checksum: computeCallLogArtifactChecksum(raw),
        device: fileStat.dev,
        inode: fileStat.ino,
        modifiedTimeMs: fileStat.mtimeMs,
      });
    }
  }

  candidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  inventory.orphans.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return { inventory, candidates, rootDir };
}

export function inventoryCallLogOrphans(
  db: SqliteAdapter,
  options: InventoryCallLogOrphansOptions
): CallLogOrphanInventory {
  return scanCallLogOrphans(db, options).inventory;
}

function revalidateOrphanCandidate(
  rootDir: string,
  candidate: CallLogOrphanCandidate
): { valid: true } | { valid: false; reason: string } {
  const absolutePath = path.resolve(rootDir, candidate.relativePath);
  if (
    absolutePath !== candidate.absolutePath ||
    !isBoundedChild(rootDir, absolutePath) ||
    path.dirname(path.dirname(absolutePath)) !== rootDir
  ) {
    return { valid: false, reason: "artifact path is no longer bounded by artifactDir" };
  }
  try {
    const fileStat = fs.lstatSync(absolutePath);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      return { valid: false, reason: "artifact is no longer a regular file" };
    }
    if (
      fileStat.dev !== candidate.device ||
      fileStat.ino !== candidate.inode ||
      fileStat.size !== candidate.sizeBytes ||
      fileStat.mtimeMs !== candidate.modifiedTimeMs
    ) {
      return { valid: false, reason: "artifact changed since inventory" };
    }
    const raw = fs.readFileSync(absolutePath, "utf8");
    if (computeCallLogArtifactChecksum(raw) !== candidate.checksum) {
      return { valid: false, reason: "artifact content changed since inventory" };
    }
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed || !buildRecoveryRow(parsed, candidate.relativePath, raw).row) {
      return { valid: false, reason: "artifact is no longer valid recovery JSON" };
    }
  } catch {
    return { valid: false, reason: "artifact disappeared or became unreadable" };
  }
  return { valid: true };
}

function removeEmptyCandidateDayDirs(rootDir: string, dayDirs: Set<string>): number {
  let removed = 0;
  for (const dayDir of [...dayDirs].sort()) {
    if (
      path.dirname(dayDir) !== rootDir ||
      !isBoundedChild(rootDir, dayDir) ||
      !isCanonicalDayDirectory(path.basename(dayDir))
    ) {
      continue;
    }
    try {
      const stat = fs.lstatSync(dayDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(dayDir).length > 0) {
        continue;
      }
      // Deliberately non-recursive. The call_logs root is never a candidate here.
      fs.rmdirSync(dayDir);
      removed++;
    } catch {
      // Concurrent writers or already-removed directories are safe to leave alone.
    }
  }
  return removed;
}

export function pruneCallLogOrphans(
  db: SqliteAdapter,
  options: PruneCallLogOrphansOptions
): CallLogOrphanPruneResult {
  if (!Number.isSafeInteger(options.confirmedCount) || options.confirmedCount < 0) {
    throw new Error("confirmedCount must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(options.confirmedBytes) || options.confirmedBytes < 0) {
    throw new Error("confirmedBytes must be a non-negative safe integer");
  }
  const scan = scanCallLogOrphans(db, options);
  if (
    options.confirmedCount !== scan.inventory.orphanCount ||
    options.confirmedBytes !== scan.inventory.orphanBytes
  ) {
    throw new Error(
      `confirmation does not match current inventory: expected ${scan.inventory.orphanCount} ` +
        `file(s) and ${scan.inventory.orphanBytes} byte(s)`
    );
  }

  const result: CallLogOrphanPruneResult = {
    ...scan.inventory,
    confirmedCount: options.confirmedCount,
    confirmedBytes: options.confirmedBytes,
    deletedCount: 0,
    deletedBytes: 0,
    preservedByReferenceRace: 0,
    preservedChanged: 0,
    unlinkErrors: 0,
    emptyDayDirsRemoved: 0,
  };
  const maxReportedIssues = options.maxReportedIssues ?? 500;
  const report = (issue: CallLogOrphanIssue) => {
    if (result.issues.length < maxReportedIssues) result.issues.push(issue);
  };
  const referenced = db.prepare(
    "SELECT 1 AS referenced FROM call_logs WHERE artifact_relpath = ? LIMIT 1"
  );
  const candidateDayDirs = new Set<string>();

  for (const candidate of scan.candidates) {
    const validation = revalidateOrphanCandidate(scan.rootDir, candidate);
    if (!validation.valid) {
      result.preservedChanged++;
      report({
        artifact: candidate.relativePath,
        kind: "changed",
        reason: validation.reason,
      });
      continue;
    }
    // This is intentionally the final operation before unlink so a row created after
    // the inventory cannot turn a referenced artifact into a deletion candidate.
    if (referenced.get(candidate.relativePath)) {
      result.preservedByReferenceRace++;
      continue;
    }
    try {
      fs.unlinkSync(candidate.absolutePath);
      result.deletedCount++;
      result.deletedBytes += candidate.sizeBytes;
      candidateDayDirs.add(path.dirname(candidate.absolutePath));
    } catch (error) {
      result.unlinkErrors++;
      report({
        artifact: candidate.relativePath,
        kind: "unlink_failed",
        reason: error instanceof Error ? error.message : "unlink failed",
      });
    }
  }

  result.emptyDayDirsRemoved = removeEmptyCandidateDayDirs(scan.rootDir, candidateDayDirs);
  return result;
}
