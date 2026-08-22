import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-xml-tool-args-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { translateNonStreamingResponse } =
  await import("../../open-sse/handlers/responseTranslator.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { normalizeXmlToolCallArgs } = await import("../../open-sse/utils/toolCallXmlNormalizer.ts");

const XML_ARGS = `<tool_calls:6124c78e>
<tool_call:6124c78e>health_check<tool_sep:6124c78e>
<arg_key:6124c78e>status</arg_key:6124c78e>
<arg_value:6124c78e>ok &amp; ready</arg_value:6124c78e>
<arg_key:6124c78e>mode</arg_key:6124c78e>
<arg_value:6124c78e>deep</arg_value:6124c78e>
</tool_call:6124c78e>
</tool_calls:6124c78e>`;

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("Tencent-style XML tool arguments normalize to a JSON object string", () => {
  const normalized = normalizeXmlToolCallArgs(XML_ARGS);
  assert.ok(normalized);
  assert.deepEqual(JSON.parse(normalized), { status: "ok & ready", mode: "deep" });
});

test("valid JSON, unrelated XML, and incomplete XML remain unchanged", () => {
  assert.equal(normalizeXmlToolCallArgs('{"status":"ok"}'), null);
  assert.equal(normalizeXmlToolCallArgs("<tool_call>health_check</tool_call>"), null);
  assert.equal(normalizeXmlToolCallArgs("<tool_calls:6124c78e>"), null);
});

test("OpenAI non-stream response boundary normalizes XML tool arguments copy-on-write", () => {
  const original = {
    choices: [
      {
        message: {
          role: "assistant",
          tool_calls: [
            {
              id: "call_xml",
              type: "function",
              function: { name: "health_check", arguments: XML_ARGS },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };

  const translated = translateNonStreamingResponse(
    original,
    FORMATS.OPENAI,
    FORMATS.OPENAI
  ) as typeof original;

  assert.notEqual(translated, original);
  assert.equal(original.choices[0].message.tool_calls[0].function.arguments, XML_ARGS);
  assert.deepEqual(JSON.parse(translated.choices[0].message.tool_calls[0].function.arguments), {
    status: "ok & ready",
    mode: "deep",
  });
});
