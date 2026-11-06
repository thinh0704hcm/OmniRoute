import type {
  ExecutionContext,
  ExecutedToolResult,
  NonStreamingProviderLegResult,
  ProviderLegUsage,
  ServerOwnedToolLoopResult,
  ToolCall,
} from "@/lib/skills/toolLoopTypes.ts";
import { executeServerOwned } from "@/lib/skills/interception";
import { runServerOwnedToolLoop, LOOP_BUDGET_MS } from "@/lib/skills/serverOwnedToolLoop.ts";
import { deriveToolRequestIdentity } from "@/lib/skills/stableJson.ts";
import { getIdempotencyKey } from "@/lib/idempotencyLayer";
import { aliasMuseToolNames } from "../../executors/museToolNameAliases.ts";
import { FORMATS } from "../../translator/formats.ts";
import { runNonStreamingProviderLeg } from "./nonStreamingProviderLeg.ts";
import type { ProviderLegInput } from "./nonStreamingProviderLeg.ts";
import { extractRequestToolMetadata, type NamespaceIdentity } from "./requestToolIdentity.ts";
import { shouldRunServerOwnedToolLoop } from "./serverOwnedToolLoopGate.ts";

export function derivePostInjectionRequestIdentity(input: {
  apiKeyId: string;
  headers: unknown;
  skillRequestId: string;
  postInjectionBody: Record<string, unknown>;
}): string {
  const stableClientRequestId = getIdempotencyKey(input.headers as never);
  return deriveToolRequestIdentity({
    apiKeyId: input.apiKeyId,
    stableClientRequestId,
    skillRequestId: input.skillRequestId,
    postInjectionBody: input.postInjectionBody,
  });
}

export function finalizeServerOwnedFollowUpRequest(input: {
  translatedBody: Record<string, unknown>;
  provider: string;
  targetFormat: string;
}): {
  translatedBody: Record<string, unknown>;
  toolNameMap: Map<string, string> | null;
  requestToolIdentityMap: Map<string, NamespaceIdentity> | null;
} {
  const translatedBody =
    input.provider === "muse-code" && input.targetFormat === FORMATS.OPENAI_RESPONSES
      ? (aliasMuseToolNames(input.translatedBody) as Record<string, unknown>)
      : input.translatedBody;
  const { requestToolIdentityMap, toolNameAliasMap } = extractRequestToolMetadata(translatedBody);
  delete translatedBody._disableToolPrefix;
  return {
    translatedBody,
    toolNameMap: toolNameAliasMap,
    requestToolIdentityMap,
  };
}

export async function continueServerOwnedToolLoop(input: {
  initialLeg: NonStreamingProviderLegResult & { kind: "ok" };
  sourceBody: Record<string, unknown>;
  sourceFormat: "openai" | "claude";
  skillsModelId: string;
  executionContext: ExecutionContext;
  abortSignal?: AbortSignal;
  deadlineAtMs: number;
  expectedConnectionId?: string;
  followUpLeg: (nextSourceBody: Record<string, unknown>) => Promise<NonStreamingProviderLegResult>;
  executeServerOwned?: (
    calls: ToolCall[],
    context: ExecutionContext
  ) => Promise<import("@/lib/skills/toolLoopTypes.ts").ExecutedToolResult[]>;
}): Promise<ServerOwnedToolLoopResult> {
  const runOwned = input.executeServerOwned ?? executeServerOwned;
  return runServerOwnedToolLoop({
    initialLeg: input.initialLeg,
    sourceBody: input.sourceBody,
    sourceFormat: input.sourceFormat,
    skillsModelId: input.skillsModelId,
    executionContext: input.executionContext,
    abortSignal: input.abortSignal,
    deadlineAtMs: input.deadlineAtMs,
    executeServerOwned: (calls: ToolCall[], context: ExecutionContext) => runOwned(calls, context),
    resumeUpstream: async (nextSourceBody, expectedConnectionId) => {
      if (
        expectedConnectionId &&
        input.expectedConnectionId &&
        expectedConnectionId !== input.expectedConnectionId
      ) {
        return {
          kind: "error",
          result: {
            success: false,
            status: 409,
            response: new Response(null, { status: 409 }),
            error: "Follow-up connection mismatch",
            errorCode: "LEASE_CONNECTION_MISMATCH",
          },
          receipt: input.initialLeg.receipt,
          usage: null,
        };
      }
      return input.followUpLeg(nextSourceBody);
    },
  });
}

export function followUpLegInput(
  base: Omit<
    ProviderLegInput,
    "phase" | "allowAccountRotation" | "allowModelFallback" | "sourceBody"
  >,
  nextSourceBody: Record<string, unknown>,
  expectedConnectionId?: string
): ProviderLegInput {
  return {
    ...base,
    phase: "follow-up",
    sourceBody: nextSourceBody,
    expectedConnectionId,
    allowAccountRotation: false,
    allowModelFallback: false,
  };
}

export function mergeLoopIntoOkLeg(
  leg: NonStreamingProviderLegResult & { kind: "ok" },
  loop: ServerOwnedToolLoopResult
): NonStreamingProviderLegResult & { kind: "ok" } {
  return {
    ...leg,
    upstreamHttpSelection: loop.upstreamHttpSelection ?? null,
    response: loop.response ?? leg.response,
    responseForMemoryExtraction:
      loop.responseForMemoryExtraction ?? leg.responseForMemoryExtraction,
    providerBody: loop.finalProviderBody ?? leg.providerBody,
    providerRequest: loop.finalProviderRequest ?? leg.providerRequest,
    usage: loop.cumulativeUsage,
  };
}

export type ToolLoopApplyResult =
  | { kind: "skip" }
  | {
      kind: "ok";
      leg: NonStreamingProviderLegResult & { kind: "ok" };
      usage: ProviderLegUsage | null;
      loop: ServerOwnedToolLoopResult;
    }
  | { kind: "error"; loop: ServerOwnedToolLoopResult };

export async function applyServerOwnedToolLoopIfNeeded(input: {
  enabled: boolean;
  stream: boolean;
  isResponsesEndpoint: boolean;
  sourceFormat: string;
  initialLeg: NonStreamingProviderLegResult;
  sourceBody: Record<string, unknown>;
  skillsModelId: string;
  executionContext: ExecutionContext;
  abortSignal?: AbortSignal;
  expectedConnectionId?: string;
  followUpLeg: (nextSourceBody: Record<string, unknown>) => Promise<NonStreamingProviderLegResult>;
  logReceipt: (receipt: ServerOwnedToolLoopResult["receipts"][number]) => void;
  advisorModel?: string | null;
  runAdvisorModel?: (model: string, body: Record<string, unknown>) => Promise<Response>;
  log?: { warn?: (tag: string, message: string) => void };
  executeServerOwned?: (
    calls: ToolCall[],
    context: ExecutionContext
  ) => Promise<ExecutedToolResult[]>;
}): Promise<ToolLoopApplyResult> {
  const advisorEnabled = Boolean(input.advisorModel && input.runAdvisorModel);
  if (
    input.initialLeg.kind !== "ok" ||
    !shouldRunServerOwnedToolLoop({
      enabled: input.enabled || advisorEnabled,
      stream: input.stream,
      isResponsesEndpoint: input.isResponsesEndpoint,
      sourceFormat: input.sourceFormat,
    })
  ) {
    return { kind: "skip" };
  }

  const runOwned = input.executeServerOwned ?? executeServerOwned;
  const executionContext = advisorEnabled
    ? {
        ...input.executionContext,
        builtinToolNames: [
          ...new Set([...(input.executionContext.builtinToolNames ?? []), "advisor"]),
        ],
      }
    : input.executionContext;
  const execute = async (calls: ToolCall[], context: ExecutionContext) => {
    if (!advisorEnabled) return runOwned(calls, context);

    const advisorCalls = calls.filter((call) => call.name === "advisor");
    const otherCalls = calls.filter((call) => call.name !== "advisor");
    const byId = new Map<string, ExecutedToolResult>();
    if (otherCalls.length > 0) {
      for (const result of await runOwned(otherCalls, context)) byId.set(result.id, result);
    }

    const { tools: _tools, tool_choice: _toolChoice, ...advisorBody } = input.sourceBody;
    const routedBody = { ...advisorBody, model: input.advisorModel!, stream: false };
    const advisorResults = await Promise.all(
      advisorCalls.map(async (call): Promise<ExecutedToolResult> => {
        let result = "Advisor unavailable.";
        try {
          const response = await input.runAdvisorModel!(input.advisorModel!, routedBody);
          if (!response.ok) {
            input.log?.warn?.(
              "ADVISOR",
              `Advisor model ${input.advisorModel} unavailable (${response.status}); tool result is unavailable`
            );
          } else {
            const payload = (await response.json()) as Record<string, unknown>;
            const content = payload.content;
            const answer =
              typeof content === "string"
                ? content.trim()
                : Array.isArray(content)
                  ? content
                      .map((block) => {
                        if (!block || typeof block !== "object") return "";
                        const record = block as Record<string, unknown>;
                        return record.type === "text" && typeof record.text === "string"
                          ? record.text
                          : "";
                      })
                      .filter(Boolean)
                      .join("\n")
                      .trim()
                  : "";
            if (answer) {
              result = answer;
            } else {
              input.log?.warn?.(
                "ADVISOR",
                `Advisor model ${input.advisorModel} returned no text; tool result is unavailable`
              );
            }
          }
        } catch {
          input.log?.warn?.(
            "ADVISOR",
            `Advisor model ${input.advisorModel} failed; tool result is unavailable`
          );
        }
        return { id: call.id, name: call.name, result, replayed: false };
      })
    );
    for (const result of advisorResults) byId.set(result.id, result);
    return calls
      .map((call) => byId.get(call.id))
      .filter((result): result is ExecutedToolResult => result !== undefined);
  };

  const loop = await continueServerOwnedToolLoop({
    initialLeg: input.initialLeg,
    sourceBody: input.sourceBody,
    sourceFormat: input.sourceFormat === FORMATS.CLAUDE ? "claude" : "openai",
    skillsModelId: input.skillsModelId,
    executionContext,
    abortSignal: input.abortSignal,
    deadlineAtMs: Date.now() + LOOP_BUDGET_MS,
    expectedConnectionId: input.expectedConnectionId,
    followUpLeg: input.followUpLeg,
    executeServerOwned: execute,
  });
  for (const receipt of loop.receipts) input.logReceipt(receipt);
  if (loop.kind === "error") return { kind: "error", loop };
  return {
    kind: "ok",
    leg: mergeLoopIntoOkLeg(input.initialLeg, loop),
    usage: loop.cumulativeUsage,
    loop,
  };
}

export { LOOP_BUDGET_MS, runNonStreamingProviderLeg };
