import assert from "node:assert/strict";
import test from "node:test";

import { getModelToolNamePolicy } from "../../open-sse/config/providerModels.ts";
import { extractRequestToolMetadata } from "../../open-sse/handlers/chatCore/requestToolIdentity.ts";
import {
  remapToolNamesInRequest,
  restoreClaudeToolName,
} from "../../open-sse/services/claudeCodeToolRemapper.ts";
import { FORMATS } from "../../open-sse/translator/formats.ts";
import {
  caseInsensitiveToolNameLookup,
  restoreOpenAIResponsesToolNames,
} from "../../open-sse/translator/helpers/toolCallHelper.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { openaiResponsesToOpenAIResponse } from "../../open-sse/translator/response/openai-responses.ts";

type JsonRecord = Record<string, unknown>;

function claudeTool(name: string): JsonRecord {
  return {
    name,
    description: `${name} description`,
    input_schema: { type: "object", properties: {} },
  };
}

function translateClaudeToGitHubResponses(provider = "github"): JsonRecord {
  return translateRequest(
    FORMATS.CLAUDE,
    FORMATS.OPENAI_RESPONSES,
    "gpt-5.6-luna",
    {
      model: "gpt-5.6-luna",
      max_tokens: 256,
      messages: [
        { role: "user", content: [{ type: "text", text: "inspect" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_1", name: "Bash", input: { command: "pwd" } },
            { type: "tool_use", id: "call_2", name: "read", input: { path: "a" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_1", content: "/tmp" },
            { type: "tool_result", tool_use_id: "call_2", content: "a" },
          ],
        },
      ],
      tools: [claudeTool("Bash"), claudeTool("bash"), claudeTool("Read"), claudeTool("read")],
      tool_choice: { type: "tool", name: "Bash" },
    },
    true,
    null,
    provider
  ) as JsonRecord;
}

test("tool-name policy is scoped to GitHub/GHE gpt-5.6-luna", () => {
  assert.equal(getModelToolNamePolicy("github", "gpt-5.6-luna"), "lowercase");
  assert.equal(getModelToolNamePolicy("gh", "gh/gpt-5.6-luna"), "lowercase");
  assert.equal(getModelToolNamePolicy("ghe-copilot", "gpt-5.6-luna"), "lowercase");
  assert.equal(getModelToolNamePolicy("github", "gpt-5.6-terra"), "preserve");
  assert.equal(getModelToolNamePolicy("openai", "gpt-5.6-luna"), "preserve");
});

test("Claude -> Responses keeps a non-enumerable, collision-safe exact-name ledger", () => {
  const translated = translateClaudeToGitHubResponses();
  const aliases = translated._toolNameAliasMap;
  assert.ok(aliases instanceof Map);

  const wireFor = (original: string): string => {
    const match = [...(aliases as Map<string, string>)].find(([, value]) => value === original);
    assert.ok(match, `missing alias for ${original}`);
    return match[0];
  };

  assert.equal(wireFor("bash"), "bash", "the exact lowercase declaration owns the base name");
  assert.match(wireFor("Bash"), /^bash_[0-9a-f]+$/);
  assert.notEqual(wireFor("Read"), wireFor("read"));
  for (const wireName of (aliases as Map<string, string>).keys()) {
    assert.equal(wireName, wireName.toLowerCase());
    assert.ok(wireName.length <= 64);
  }

  const tools = translated.tools as JsonRecord[];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [wireFor("Bash"), wireFor("bash"), wireFor("Read"), wireFor("read")]
  );

  const calls = (translated.input as JsonRecord[]).filter((item) => item.type === "function_call");
  assert.deepEqual(
    calls.map((call) => call.name),
    [wireFor("Bash"), wireFor("read")]
  );
  assert.deepEqual(translated.tool_choice, { type: "function", name: wireFor("Bash") });
  assert.equal(Object.prototype.propertyIsEnumerable.call(translated, "_toolNameAliasMap"), false);
  assert.equal(JSON.stringify(translated).includes("_toolNameAliasMap"), false);
});

test("preserve policy leaves wire spelling exact while retaining identity aliases", () => {
  const translated = translateClaudeToGitHubResponses("openai");
  const tools = translated.tools as JsonRecord[];
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["Bash", "bash", "Read", "read"]
  );
  assert.deepEqual(
    translated._toolNameAliasMap,
    new Map([
      ["Bash", "Bash"],
      ["bash", "bash"],
      ["Read", "Read"],
      ["read", "read"],
    ])
  );
});

for (const targetFormat of [
  FORMATS.OPENAI,
  FORMATS.OPENAI_RESPONSES,
  FORMATS.GEMINI,
  FORMATS.ANTIGRAVITY,
  FORMATS.KIRO,
  FORMATS.CURSOR,
  FORMATS.CLAUDE,
]) {
  test(`Claude exact-name aliases survive the ${targetFormat} request path`, () => {
    const translated = translateRequest(
      FORMATS.CLAUDE,
      targetFormat,
      "some-model",
      {
        max_tokens: 64,
        messages: [{ role: "user", content: "inspect" }],
        tools: [claudeTool("Read")],
      },
      true,
      null,
      "some-provider"
    ) as JsonRecord;
    const aliases = translated._toolNameAliasMap;
    assert.ok(aliases instanceof Map);
    assert.ok([...(aliases as Map<string, string>).values()].includes("Read"));
    assert.equal(
      Object.prototype.propertyIsEnumerable.call(translated, "_toolNameAliasMap"),
      false
    );
    assert.equal(JSON.stringify(translated).includes("_toolNameAliasMap"), false);
  });
}

test("alias and namespace channels are extracted independently", () => {
  const aliases = new Map([["read_a1", "Read"]]);
  const identities = new Map([["functions__exec", { namespace: "functions", name: "exec" }]]);
  const body: JsonRecord = {};
  Object.defineProperty(body, "_toolNameAliasMap", { value: aliases, configurable: true });
  Object.defineProperty(body, "_namespaceToolIdentityMap", {
    value: identities,
    configurable: true,
  });

  const metadata = extractRequestToolMetadata(body);
  assert.deepEqual(metadata.toolNameAliasMap, aliases);
  assert.deepEqual(metadata.namespaceToolIdentityMap, identities);
  assert.equal("_toolNameAliasMap" in body, false);
  assert.equal("_namespaceToolIdentityMap" in body, false);
});

test("lowercase policy rewrites namespace children without conflating namespace identity", () => {
  const translated = translateRequest(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.OPENAI_RESPONSES,
    "gpt-5.6-luna",
    {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }],
      tools: [
        {
          type: "namespace",
          name: "functions",
          tools: [
            {
              name: "Read",
              description: "read",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
      ],
    },
    true,
    null,
    "github"
  ) as JsonRecord;
  const namespace = (translated.tools as JsonRecord[])[0];
  const child = (namespace.tools as JsonRecord[])[0];
  assert.equal(namespace.name, "functions");
  assert.equal(child.name, "read");
  assert.equal((translated._toolNameAliasMap as Map<string, string>).get("read"), "Read");
  assert.equal(translated._namespaceToolIdentityMap, undefined);
});

test("case-fold fallback refuses an ambiguous Read/read echo", () => {
  const aliases = new Map([
    ["Read", "Read"],
    ["read", "read"],
  ]);
  assert.equal(caseInsensitiveToolNameLookup("Read", aliases), "Read");
  assert.equal(caseInsensitiveToolNameLookup("read", aliases), "read");
  assert.equal(caseInsensitiveToolNameLookup("READ", aliases), undefined);
  assert.equal(restoreClaudeToolName("READ", aliases), "READ");
});

test("Responses stream and completed payloads restore the exact client name", () => {
  const aliases = new Map([["read_ab12", "Read"]]);
  const state: JsonRecord = { toolNameMap: aliases };
  const translated = openaiResponsesToOpenAIResponse(
    {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "read_ab12",
        arguments: "",
      },
    },
    state
  ) as JsonRecord;
  const choice = (translated.choices as JsonRecord[])[0];
  const delta = choice.delta as JsonRecord;
  const toolCall = (delta.tool_calls as JsonRecord[])[0];
  assert.equal((toolCall.function as JsonRecord).name, "Read");

  const completed: JsonRecord = {
    type: "response.completed",
    response: {
      output: [{ type: "function_call", call_id: "call_1", name: "read_ab12", arguments: "{}" }],
    },
  };
  assert.equal(restoreOpenAIResponsesToolNames(completed, aliases), true);
  const output = ((completed.response as JsonRecord).output as JsonRecord[])[0];
  assert.equal(output.name, "Read");
});

test("Claude remapping is copy-on-write for shared combo request children", () => {
  const originalTools = [claudeTool("bash")];
  const originalMessages = [
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "bash", input: {} }],
    },
  ];
  const originalToolChoice = { type: "tool", name: "bash" };
  const attempt: JsonRecord = {
    tools: originalTools,
    messages: originalMessages,
    tool_choice: originalToolChoice,
  };

  assert.equal(remapToolNamesInRequest(attempt), true);
  assert.equal(((attempt.tools as JsonRecord[])[0] as JsonRecord).name, "Bash");
  assert.equal(
    (((attempt.messages as JsonRecord[])[0].content as JsonRecord[])[0] as JsonRecord).name,
    "Bash"
  );
  assert.equal((attempt.tool_choice as JsonRecord).name, "Bash");
  assert.equal(originalTools[0].name, "bash");
  assert.equal(originalMessages[0].content[0].name, "bash");
  assert.equal(originalToolChoice.name, "bash");
});
