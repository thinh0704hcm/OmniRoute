// command-code claude models are served ONLY on /provider/v1/messages
// (Anthropic shape); posting them to /provider/v1/chat/completions answers
// 400 "must be called via /provider/v1/messages". The executor must route
// Claude-shaped bodies for claude-format models to the messages endpoint
// with the provider prefix stripped, and leave every other path untouched.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { command_codeProvider } from "../../open-sse/config/providers/registry/command-code/index.ts";

const mod = await import("../../open-sse/executors/commandCode.ts");

const CLAUDE_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

describe("command-code claude registry", () => {
  it("declares targetFormat claude for all claude models", () => {
    for (const id of CLAUDE_MODELS) {
      const entry = command_codeProvider.models.find((m) => m.id === id);
      assert.ok(entry, `registry entry missing: ${id}`);
      assert.equal(entry.targetFormat, "claude", `${id} must route to /messages`);
    }
  });
});

function claudeBody() {
  return {
    model: "command-code/claude-opus-4-7",
    system: "You are helpful.",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    max_tokens: 16,
  };
}

async function captureExecute(model: string, body: unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(String(init?.body ?? "null"));
    } catch {}
    calls.push({ url: String(url), body: parsed });
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;
  try {
    await new mod.CommandCodeExecutor().execute({
      model,
      body,
      stream: false,
      credentials: { apiKey: "fake-key" },
      signal: null,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  return calls;
}

describe("CommandCodeExecutor claude path", () => {
  it("posts Claude-shaped bodies for claude models to /provider/v1/messages", async () => {
    const calls = await captureExecute("command-code/claude-opus-4-7", claudeBody());
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/provider/v1/messages"), `wrong endpoint: ${calls[0].url}`);
  });

  it("strips the provider prefix from the wire model id", async () => {
    const calls = await captureExecute("command-code/claude-opus-4-7", claudeBody());
    const sent = calls[0].body as Record<string, unknown>;
    assert.equal(sent["model"], "claude-opus-4-7");
  });

  it("keeps OpenAI-shaped bodies on the legacy chat/completions path", async () => {
    const calls = await captureExecute("command-code/claude-opus-4-7", {
      model: "command-code/claude-opus-4-7",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
    });
    assert.equal(calls.length, 1);
    assert.ok(
      calls[0].url.endsWith("/provider/v1/chat/completions"),
      `wrong endpoint: ${calls[0].url}`
    );
  });

  it("keeps non-claude models on chat/completions", async () => {
    const calls = await captureExecute("command-code/deepseek/deepseek-v4-flash", {
      model: "command-code/deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
    });
    assert.ok(
      calls[0].url.endsWith("/provider/v1/chat/completions"),
      `wrong endpoint: ${calls[0].url}`
    );
  });
});
