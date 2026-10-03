import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENCODE_CLI_VERSION_FALLBACK,
  OPENCODE_CLI_VERSION_TTL_MS,
  configureOpencodeCliVersionForTests,
  getCachedOpencodeCliVersion,
  isOpencodeCliVersion,
  refreshOpencodeCliVersion,
  resetOpencodeCliVersionCache,
} from "../../open-sse/utils/opencodeCliVersion.ts";
import { resolveOpencodeCliDefaults } from "../../open-sse/utils/opencodeHeaders.ts";

test.afterEach(() => {
  resetOpencodeCliVersionCache();
});

test("cold cache returns the pinned fallback without networking", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("must not fetch on sync path");
  }) as typeof fetch;
  try {
    assert.equal(getCachedOpencodeCliVersion(), OPENCODE_CLI_VERSION_FALLBACK);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refresh resolves live from the npm registry JSON API (no npm binary)", async () => {
  const originalFetch = globalThis.fetch;
  let url = "";
  globalThis.fetch = (async (input: unknown) => {
    url = String(input);
    return new Response(JSON.stringify({ version: "9.9.9" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    assert.equal(await refreshOpencodeCliVersion(), "9.9.9");
    assert.equal(url, "https://registry.npmjs.org/opencode-ai/latest");
    assert.equal(getCachedOpencodeCliVersion(), "9.9.9");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refresh keeps stale cache / pin when the registry is unreachable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  try {
    assert.equal(await refreshOpencodeCliVersion(), OPENCODE_CLI_VERSION_FALLBACK);
    configureOpencodeCliVersionForTests("1.18.31", Date.now() - OPENCODE_CLI_VERSION_TTL_MS - 1);
    assert.equal(await refreshOpencodeCliVersion(), "1.18.31");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("concurrent refreshes coalesce into one registry lookup", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  globalThis.fetch = (async () => {
    calls += 1;
    await gate;
    return new Response(JSON.stringify({ version: "2.0.0" }), { status: 200 });
  }) as typeof fetch;
  try {
    const pending = [refreshOpencodeCliVersion(), refreshOpencodeCliVersion()];
    release();
    const [a, b] = await Promise.all(pending);
    assert.equal(a, "2.0.0");
    assert.equal(b, "2.0.0");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("malformed registry payloads are rejected", () => {
  assert.equal(isOpencodeCliVersion("1.18.31"), true);
  assert.equal(isOpencodeCliVersion(" 2.0.0 "), true);
  assert.equal(isOpencodeCliVersion("latest"), false);
  assert.equal(isOpencodeCliVersion("1.18"), false);
  assert.equal(isOpencodeCliVersion(""), false);
  assert.equal(isOpencodeCliVersion(null), false);
  assert.throws(() => configureOpencodeCliVersionForTests("not-a-version"), TypeError);
});

test("header synthesis combines the refreshed version with native CLI metadata", () => {
  const names = ["OPENCODE_USER_AGENT", "OPENCODE_CLIENT", "OPENCODE_SYNTHESIZE_CLI_HEADERS"];
  const previous = names.map((name) => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    configureOpencodeCliVersionForTests("9.9.9", Date.now());
    const gated = resolveOpencodeCliDefaults("opencode", true);
    assert.equal(
      gated?.userAgent,
      "opencode/9.9.9 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14"
    );
    assert.equal(gated?.client, "cli");
    assert.equal(resolveOpencodeCliDefaults("opencode-go", false)?.client, "desktop");
    process.env.OPENCODE_USER_AGENT = "opencode/8.8.8 custom-client";
    assert.equal(
      resolveOpencodeCliDefaults("opencode", true)?.userAgent,
      process.env.OPENCODE_USER_AGENT
    );
  } finally {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
  }
});
