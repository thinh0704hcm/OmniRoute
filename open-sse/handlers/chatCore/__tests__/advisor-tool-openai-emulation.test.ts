// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { claudeToOpenAIRequest } from "../../../translator/request/claude-to-openai.ts";
import { applyServerOwnedToolLoopIfNeeded } from "../serverOwnedToolLoopWire.ts";

function leg(response: Record<string, unknown>, index: number) {
  return {
    kind: "ok" as const,
    response,
    responseForMemoryExtraction: response,
    providerBody: {},
    providerRequest: {},
    usage: null,
    responsePayloadFormat: "claude",
    looksLikeSSE: false,
    connectionId: "connection-main",
    headers: new Headers(),
    receipt: {
      index,
      connectionId: "connection-main",
      provider: "hh",
      model: "claude-sonnet-5-5",
      startedAt: "2026-10-20T00:00:00.000Z",
      endedAt: "2026-10-20T00:00:00.000Z",
      latencyMs: 0,
      httpStatus: 200,
      errorType: null,
      usage: null,
      serviceTier: null,
      computedCostUsd: null,
      toolCalls: [],
      termination: "tool_calls",
      clientVisible: true,
    },
  };
}

const sourceBody = {
  model: "hh/claude-sonnet-5-5",
  max_tokens: 128,
  tools: [{ type: "advisor_20260301", name: "advisor", model: "hh/claude-opus-5-5" }],
  messages: [{ role: "user", content: "Review this migration plan." }],
};

const executionContext = {
  apiKeyId: "key-test",
  sessionId: "session-test",
  requestId: "request-test",
  builtinToolNames: [],
  executionFenceEnabled: true,
  provider: "hh",
  model: "claude-sonnet-5-5",
};

describe("Claude advisor tool on OpenAI-protocol upstreams", () => {
  it("drops an advisor function when its model is unavailable", () => {
    const converted = claudeToOpenAIRequest(
      "claude-sonnet-5-5",
      {
        tools: [{ type: "advisor_20260301", name: "advisor" }],
      },
      false
    );

    expect(converted.tools).toBeUndefined();
  });

  it("translates a configured advisor as a zero-schema function without forwarding its model field", () => {
    const converted = claudeToOpenAIRequest(
      "claude-sonnet-5-5",
      {
        tools: [{ type: "advisor_20260301", model: "hh/claude-opus-5-5" }],
      },
      false
    );

    expect(converted.tools).toEqual([
      {
        type: "function",
        function: {
          name: "advisor",
          description: "",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("logs an unavailable advisor route and resumes with a fallback tool_result", async () => {
    const advisorCall = {
      type: "tool_use",
      id: "call_advisor_503",
      name: "advisor",
      input: {},
    };
    const followUpBodies: Array<Record<string, unknown>> = [];
    const warning = vi.fn();
    const result = await applyServerOwnedToolLoopIfNeeded({
      enabled: true,
      stream: false,
      isResponsesEndpoint: false,
      sourceFormat: "claude",
      initialLeg: leg({ content: [advisorCall], stop_reason: "tool_use" }, 0) as never,
      sourceBody,
      skillsModelId: "hh/claude-sonnet-5-5",
      executionContext,
      deadlineAtMs: Date.now() + 60_000,
      followUpLeg: async (body: Record<string, unknown>) => {
        followUpBodies.push(body);
        return leg(
          { content: [{ type: "text", text: "Proceeding without advisor." }] },
          1
        ) as never;
      },
      logReceipt: vi.fn(),
      advisorModel: "hh/claude-opus-5-5",
      runAdvisorModel: async () => new Response("unavailable", { status: 503 }),
      log: { warn: warning },
    });

    expect(warning).toHaveBeenCalledWith(
      "ADVISOR",
      expect.stringContaining("Advisor model hh/claude-opus-5-5 unavailable (503)")
    );
    expect(followUpBodies).toHaveLength(1);
    const followUpMessages = followUpBodies[0].messages as Array<{
      role: string;
      content: unknown;
    }>;
    expect(followUpMessages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_advisor_503",
          content: '"Advisor unavailable."',
        },
      ],
    });
    expect(result.kind).toBe("ok");
  });

  it("routes an advisor call and returns its answer in the follow-up tool_result", async () => {
    const advisorCall = {
      type: "tool_use",
      id: "call_advisor_1",
      name: "advisor",
      input: {},
    };
    const followUpBodies: Array<Record<string, unknown>> = [];
    const routed: Array<{ model: string; body: Record<string, unknown> }> = [];
    const finalResponse = {
      content: [{ type: "text", text: "Migration plan revised." }],
      stop_reason: "end_turn",
    };

    const result = await applyServerOwnedToolLoopIfNeeded({
      enabled: true,
      stream: false,
      isResponsesEndpoint: false,
      sourceFormat: "claude",
      initialLeg: leg({ content: [advisorCall], stop_reason: "tool_use" }, 0) as never,
      sourceBody,
      skillsModelId: "hh/claude-sonnet-5-5",
      executionContext,
      deadlineAtMs: Date.now() + 60_000,
      followUpLeg: async (body: Record<string, unknown>) => {
        followUpBodies.push(body);
        return leg(finalResponse, 1) as never;
      },
      logReceipt: vi.fn(),
      advisorModel: "hh/claude-opus-5-5",
      runAdvisorModel: async (model: string, body: Record<string, unknown>) => {
        routed.push({ model, body });
        return new Response(
          JSON.stringify({
            content: [
              {
                type: "text",
                text: "The migration should keep the old index until backfill finishes.",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      },
    });

    expect(routed).toHaveLength(1);
    expect(routed[0]).toEqual({
      model: "hh/claude-opus-5-5",
      body: {
        model: "hh/claude-opus-5-5",
        max_tokens: 128,
        messages: sourceBody.messages,
        stream: false,
      },
    });
    expect(followUpBodies).toHaveLength(1);
    expect(followUpBodies[0].messages).toEqual([
      ...sourceBody.messages,
      { role: "assistant", content: [advisorCall] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_advisor_1",
            content: '"The migration should keep the old index until backfill finishes."',
          },
        ],
      },
    ]);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.leg.response).toBe(finalResponse);
  });
});
