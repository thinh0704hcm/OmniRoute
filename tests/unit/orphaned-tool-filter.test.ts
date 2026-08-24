import test from "node:test";
import assert from "node:assert/strict";

const { openaiResponsesToOpenAIRequest, openaiToOpenAIResponsesRequest } =
  await import("../../open-sse/translator/request/openai-responses.ts");

const { openaiToClaudeRequest } =
  await import("../../open-sse/translator/request/openai-to-claude.ts");
const { prepareClaudeRequest } = await import("../../open-sse/translator/helpers/claudeHelper.ts");
const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");

test("openaiResponsesToOpenAIRequest: filters orphaned tool messages", () => {
  const body = {
    model: "gpt-4",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "function_call_output", call_id: "call_orphan_1", output: "stale result" },
      { type: "function_call", call_id: "call_valid_1", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call_valid_1", output: "file contents" },
    ],
  };
  const result = openaiResponsesToOpenAIRequest("gpt-4", body, true, null);
  const toolMessages = (result as any).messages.filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 1, "should have exactly 1 tool message");
  assert.equal(toolMessages[0].tool_call_id, "call_valid_1");
});

test("openaiResponsesToOpenAIRequest: preserves all messages when no orphans", () => {
  const body = {
    model: "gpt-4",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
      { type: "function_call", call_id: "call_2", name: "write_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call_2", output: "done" },
    ],
  };
  const result = openaiResponsesToOpenAIRequest("gpt-4", body, true, null);
  const toolMessages = (result as any).messages.filter((m) => m.role === "tool");
  assert.equal(toolMessages.length, 2, "both valid tool results should be preserved");
});

test("openaiToOpenAIResponsesRequest: filters orphaned function_call_output", () => {
  const body = {
    messages: [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "hello" },
      { role: "tool", tool_call_id: "call_orphan_2", content: "stale" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_valid_2", type: "function", function: { name: "ls", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_valid_2", content: "files" },
    ],
  };
  const result = openaiToOpenAIResponsesRequest("gpt-4", body, true, null);
  const outputs = (result as any).input.filter((i) => i.type === "function_call_output");
  assert.equal(outputs.length, 1, "should have exactly 1 function_call_output");
  assert.equal(outputs[0].call_id, "call_valid_2");
});

test("openaiToOpenAIResponsesRequest: preserves all items when no orphans", () => {
  const body = {
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_a", type: "function", function: { name: "ls", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_a", content: "result" },
    ],
  };
  const result = openaiToOpenAIResponsesRequest("gpt-4", body, true, null);
  const outputs = (result as any).input.filter((i) => i.type === "function_call_output");
  assert.equal(outputs.length, 1, "valid function_call_output should be preserved");
});

test("openaiToClaudeRequest: filters orphaned tool_result blocks", () => {
  const body = {
    _disableToolPrefix: true,
    messages: [
      { role: "user", content: "hello" },
      { role: "tool", tool_call_id: "tu_orphan_1", content: "stale result" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_valid_1", name: "read_file", input: {} }],
      },
      { role: "tool", tool_call_id: "tu_valid_1", content: "file contents" },
    ],
  };
  const result = openaiToClaudeRequest("claude-3", body, true);
  const toolResults = [];
  for (const msg of result.messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result") toolResults.push(block);
      }
    }
  }
  assert.equal(toolResults.length, 1, "should have exactly 1 tool_result");
  assert.equal(toolResults[0].tool_use_id, "tu_valid_1");
});

test("openaiToClaudeRequest: removes empty user messages after orphan filtering", () => {
  const body = {
    _disableToolPrefix: true,
    messages: [
      { role: "user", content: "hello" },
      { role: "tool", tool_call_id: "tu_orphan_only", content: "stale" },
      { role: "assistant", content: "I can help" },
    ],
  };
  const result = openaiToClaudeRequest("claude-3", body, true);
  for (const msg of result.messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      assert.ok(msg.content.length > 0, "user message should not have empty content");
    }
  }
});

test("openaiToClaudeRequest: removes empty assistant messages", () => {
  const body = {
    _disableToolPrefix: true,
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "", input: {} }],
      },
      { role: "assistant", content: "actual response" },
    ],
  };
  const result = openaiToClaudeRequest("claude-3", body, true);
  for (const msg of result.messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      assert.ok(msg.content.length > 0, "assistant message should not have empty content");
    }
  }
});

test("openaiToClaudeRequest: preserves valid tool pairs unchanged", () => {
  const body = {
    _disableToolPrefix: true,
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "read_file", input: {} }],
      },
      { role: "tool", tool_call_id: "tu_1", content: "file data" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_2", name: "write_file", input: {} }],
      },
      { role: "tool", tool_call_id: "tu_2", content: "written" },
    ],
  };
  const result = openaiToClaudeRequest("claude-3", body, true);
  const toolResults = [];
  for (const msg of result.messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result") toolResults.push(block);
      }
    }
  }
  assert.equal(toolResults.length, 2, "both valid tool_results should be preserved");
});

test("prepareClaudeRequest removes nameless historical calls and their matching results", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "text", text: "start" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "keeping text" },
          { type: "tool_use", id: "bad_call", name: "", input: { command: "pwd" } },
          { type: "tool_use", id: "good_call", name: "Bash", input: { command: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "bad_call", content: "bad result" },
          { type: "tool_result", tool_use_id: "good_call", content: "good result" },
        ],
      },
    ],
  };
  const prepared = prepareClaudeRequest(body);
  const blocks = prepared.messages?.flatMap((message) =>
    Array.isArray(message.content) ? message.content : []
  );
  assert.equal(
    blocks?.some((block) => block.type === "tool_use" && block.id === "bad_call"),
    false
  );
  assert.equal(
    blocks?.some((block) => block.type === "tool_result" && block.tool_use_id === "bad_call"),
    false
  );
  assert.equal(
    blocks?.some((block) => block.type === "text" && block.text === "keeping text"),
    true
  );
  assert.equal(
    blocks?.some((block) => block.type === "tool_use" && block.id === "good_call"),
    true
  );
  assert.equal(
    blocks?.some((block) => block.type === "tool_result" && block.tool_use_id === "good_call"),
    true
  );

  const antigravity = claudeToGeminiRequest("gemini-2.5-pro", prepared, true, {
    _provider: "antigravity",
  });
  const serialized = JSON.stringify(antigravity.contents);
  assert.doesNotMatch(serialized, /bad_call|bad result/);
  assert.doesNotMatch(serialized, /"name":""|"name":"tool"/);
});

test("prepareClaudeRequest preserves all declared tools", () => {
  const tools = Array.from({ length: 41 }, (_, index) => ({
    name: `Tool${index}`,
    description: `Tool ${index}`,
    input_schema: { type: "object", properties: {} },
  }));
  const prepared = prepareClaudeRequest({
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools,
  });
  assert.equal(prepared.tools?.length, 41);
  assert.deepEqual(
    prepared.tools?.map((tool) => tool.name),
    tools.map((tool) => tool.name)
  );
});
