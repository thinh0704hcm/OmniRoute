/**
 * Regression test for #5997 — opencode-go/opencode-zen upstream requests must carry
 * OpenCode CLI identity headers even when the client did not supply them.
 *
 * On a datacenter VPS, `opencode.ai/zen/go/v1/chat/completions` is fronted by
 * Cloudflare, which 403s (HTML challenge) requests lacking CLI identity. The reporter's
 * control curl proved the exact headers that succeed:
 *   User-Agent: opencode-cli/1.0.0 · x-opencode-client: cli ·
 *   x-opencode-project: default · x-opencode-request/-session: fresh UUIDs
 * Forwarding those headers from the client also fixes it — confirming the upstream
 * expects CLI identity. Since most OpenAI-compatible clients never send them,
 * `OpencodeExecutor.buildHeaders()` must synthesize the defaults when absent.
 *
 * Client-supplied values always take precedence (defaults only fill gaps), and the
 * UA/client/project defaults are env-overridable.
 *
 * PR #10571 flips the executor-level synthesis to ON BY DEFAULT (previously it was
 * OPT-IN via `OPENCODE_SYNTHESIZE_CLI_HEADERS=true`, per an earlier #5997 decision to
 * stay off-by-default pending live validation, out of concern that a wrong fabricated
 * value risks upstream rejection — #5720 regressed with "opencode/local"). It also
 * changes the synthesized default values themselves (userAgent "opencode-cli/1.0.0" →
 * "opencode", client "cli" → "desktop", project "default" → "global") to match
 * 9router's defaults. Flipping the on/off default is a deployment-behavior decision
 * this PR did NOT get explicit owner sign-off for — see the PR discussion for #10571
 * (this test file only asserts what the shipped code actually does; it does not bless
 * the decision to flip the default). Opt-out is now `OPENCODE_SYNTHESIZE_CLI_HEADERS=false`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPiUserAgent,
  forwardOpencodeClientHeaders,
  resolveOpencodeGoIdentity,
} from "../../open-sse/utils/opencodeHeaders.ts";
import { OpencodeExecutor } from "../../open-sse/executors/opencode.ts";

// Since 2026-09-17 the free tier requires the canonical OpenCode id shapes; a UUID is
// refused with a 403. The synthesized ids therefore match these patterns, not a UUID.
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

// Values passed explicitly to forwardOpencodeClientHeaders()'s `cliDefaults` option in
// the tests below — these are caller-supplied, independent of OpencodeExecutor's own
// env-driven defaults (covered separately by the OPENCODE_DEFAULTS constant + the
// OpencodeExecutor.buildHeaders tests further down).
const CLI_DEFAULTS = { userAgent: "opencode/1.18.31", client: "cli", project: "default" };

// PR #10571's new synthesized defaults for OpencodeExecutor.buildHeaders() itself.
// The user-agent default carries a version since 2026-09-17: the free tier refuses a
// bare `opencode` and answers 426 below version 1.17.
const OPENCODE_DEFAULTS = {
  userAgent: "opencode/1.18.31 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14",
  client: "desktop",
  project: "global",
};

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const saved = process.env[key];
  try {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

test("forwardOpencodeClientHeaders: cliDefaults synthesize all CLI identity headers when absent [#5997]", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(headers, {}, { cliDefaults: CLI_DEFAULTS });

  assert.equal(headers["User-Agent"], CLI_DEFAULTS.userAgent);
  assert.equal(headers["x-opencode-client"], "cli");
  assert.equal(headers["x-opencode-project"], "default");
  assert.match(headers["x-opencode-request"] ?? "", REQUEST_RE);
  assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
  assert.notEqual(headers["x-opencode-request"], headers["x-opencode-session"]);
});

test("forwardOpencodeClientHeaders: non-CLI client UA is REPLACED with the CLI UA; client-wins survives as a deterministic mapping for the ids [#5997 follow-up]", () => {
  const headers: Record<string, string> = {};
  const clientHeaders = {
    "User-Agent": "curl/8.5.0",
    "x-opencode-client": "vscode",
    "x-opencode-project": "acme",
    "x-opencode-request": "req-from-client",
    "x-opencode-session": "sess-from-client",
  };
  forwardOpencodeClientHeaders(headers, clientHeaders, { cliDefaults: CLI_DEFAULTS });

  assert.equal(headers["User-Agent"], CLI_DEFAULTS.userAgent);
  assert.equal(headers["x-opencode-client"], "vscode");
  assert.equal(headers["x-opencode-project"], "acme");
  // The client's own ids cannot go out as they are (the upstream refuses any other shape),
  // so they are translated deterministically: the same client value always maps to the
  // same upstream id, which is what session continuity and prompt caching need.
  assert.match(headers["x-opencode-request"] ?? "", REQUEST_RE);
  assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
  const again: Record<string, string> = {};
  forwardOpencodeClientHeaders(again, clientHeaders, { cliDefaults: CLI_DEFAULTS });
  assert.equal(again["x-opencode-session"], headers["x-opencode-session"]);
});

test("forwardOpencodeClientHeaders: a client UA satisfying the upstream contract is preserved", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headers,
    { "User-Agent": "opencode/2.5.0" },
    {
      cliDefaults: CLI_DEFAULTS,
    }
  );
  assert.equal(headers["User-Agent"], "opencode/2.5.0", "a real client version stays intact");
});

test("forwardOpencodeClientHeaders: an unversioned opencode-cli UA is replaced (the upstream refuses it)", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headers,
    { "User-Agent": "opencode-cli/2.5.0" },
    {
      cliDefaults: CLI_DEFAULTS,
    }
  );
  assert.equal(headers["User-Agent"], CLI_DEFAULTS.userAgent);
});

test("forwardOpencodeClientHeaders: without cliDefaults, no synthesis (DefaultExecutor path unchanged)", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(headers, {});
  assert.equal(headers["User-Agent"], undefined);
  assert.equal(headers["x-opencode-client"], undefined);
  assert.equal(headers["x-opencode-project"], undefined);
});

test("OpencodeExecutor.buildHeaders: synthesizes CLI defaults by default — flag unset [#10571]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", undefined, () => {
    // CLI impersonation lives on the zen (free-tier) surface; the go surface now
    // carries Pi's agent formulation (covered below).
    const executor = new OpencodeExecutor("opencode-zen");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");
    assert.equal(headers["User-Agent"], OPENCODE_DEFAULTS.userAgent);
    assert.equal(headers["x-opencode-client"], OPENCODE_DEFAULTS.client);
    assert.equal(headers["x-opencode-project"], OPENCODE_DEFAULTS.project);
    assert.match(headers["x-opencode-request"] ?? "", REQUEST_RE);
  });
});

test("OpencodeExecutor.buildHeaders: synthesizes CLI defaults with flag explicitly on + no client headers [#5997]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "true", () => {
    const executor = new OpencodeExecutor("opencode-zen");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");

    assert.equal(headers["User-Agent"], OPENCODE_DEFAULTS.userAgent);
    assert.equal(headers["x-opencode-client"], OPENCODE_DEFAULTS.client);
    assert.equal(headers["x-opencode-project"], OPENCODE_DEFAULTS.project);
    assert.match(headers["x-opencode-request"] ?? "", REQUEST_RE);
    assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
  });
});

test("OpencodeExecutor.buildHeaders: forward-only — no fabrication when flag is explicitly off [#10571 opt-out]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "false", () => {
    const executor = new OpencodeExecutor("opencode-zen");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");
    assert.equal(headers["User-Agent"], undefined);
    assert.equal(headers["x-opencode-client"], undefined);
    assert.equal(headers["x-opencode-project"], undefined);
  });
});

test("OpencodeExecutor.buildHeaders: OPENCODE_GO_USER_AGENT env overrides the default UA (flag on) [#5997]", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "true", () => {
    withEnv("OPENCODE_GO_USER_AGENT", "opencode-cli/2.5.0", () => {
      const executor = new OpencodeExecutor("opencode-go");
      const headers = executor.buildHeaders(null, true, null, "glm-5.2");
      assert.equal(headers["User-Agent"], "opencode-cli/2.5.0");
    });
  });
});

// The opencode-go (paid) surface copies Pi's request formulation instead of CLI
// impersonation: Pi's own User-Agent plus `x-opencode-client: pi`, no project
// header. opencode-go requires the caller's own agent UA (not a generic
// SDK/HTTP-library name) and a stable per-conversation session id for routing
// and prompt caching — a session id the gateway synthesizes or forwards.

test("buildPiUserAgent: exact pi-coding-agent getPiUserAgent() formulation", () => {
  const ua = buildPiUserAgent();
  assert.match(ua, /^pi\/1\.0\.1 \([a-z0-9_]+; (node\/v\d+\.\d+\.\d+|bun\/[\d.]+); (x64|arm64)\)$/);
});

test("resolveOpencodeGoIdentity: Pi formulation by default, env-overridable, master opt-out respected", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", undefined, () => {
    withEnv("OPENCODE_GO_USER_AGENT", undefined, () => {
      withEnv("OPENCODE_GO_CLIENT", undefined, () => {
        const identity = resolveOpencodeGoIdentity();
        assert.equal(identity?.userAgent, buildPiUserAgent());
        assert.equal(identity?.client, "pi");
        assert.equal(identity?.project, undefined);
        assert.equal(identity?.preserveClientUA, true);
      });
    });
  });
  withEnv("OPENCODE_GO_USER_AGENT", "my-agent/9.9", () => {
    withEnv("OPENCODE_GO_CLIENT", "my-client", () => {
      const identity = resolveOpencodeGoIdentity();
      assert.equal(identity?.userAgent, "my-agent/9.9");
      assert.equal(identity?.client, "my-client");
    });
  });
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "false", () => {
    assert.equal(resolveOpencodeGoIdentity(), undefined);
  });
});

test("OpencodeExecutor.buildHeaders: go surface sends Pi agent identity, no project header", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", undefined, () => {
    const executor = new OpencodeExecutor("opencode-go");
    const headers = executor.buildHeaders(null, true, null, "glm-5.2");
    assert.equal(headers["User-Agent"], buildPiUserAgent());
    assert.equal(headers["x-opencode-client"], "pi");
    assert.equal(headers["x-opencode-project"], undefined);
    // The session/request half of the contract still applies: Go routes and
    // caches on a stable per-conversation session id.
    assert.match(headers["x-opencode-request"] ?? "", REQUEST_RE);
    assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
  });
});

test("OpencodeExecutor.buildHeaders: go surface KEEPS any client UA — even a generic one the zen surface would replace", () => {
  withEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", undefined, () => {
    const executor = new OpencodeExecutor("opencode-go");
    for (const ua of ["curl/8.5.0", "opencode/2.5.0", "my-agent/1.0"]) {
      const headers = executor.buildHeaders(null, true, { "User-Agent": ua }, "glm-5.2");
      assert.equal(headers["User-Agent"], ua, `client UA ${ua} must survive on the go surface`);
      assert.equal(headers["x-opencode-client"], "pi");
    }
  });
});

test("forwardOpencodeClientHeaders: agent-mode cliDefaults keep a generic client UA and skip the project header", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headers,
    { "User-Agent": "curl/8.5.0" },
    {
      cliDefaults: {
        userAgent: "pi/1.0.1 (linux; node/v1.2.3; x64)",
        client: "pi",
        preserveClientUA: true,
      },
    }
  );
  assert.equal(headers["User-Agent"], "curl/8.5.0");
  assert.equal(headers["x-opencode-client"], "pi");
  assert.equal(headers["x-opencode-project"], undefined);
  assert.match(headers["x-opencode-session"] ?? "", SESSION_RE);
});

test("forwardOpencodeClientHeaders: agent-mode cliDefaults fill a missing UA with the agent default", () => {
  const headers: Record<string, string> = {};
  forwardOpencodeClientHeaders(
    headers,
    {},
    {
      cliDefaults: {
        userAgent: "pi/1.0.1 (linux; node/v1.2.3; x64)",
        client: "pi",
        preserveClientUA: true,
      },
    }
  );
  assert.equal(headers["User-Agent"], "pi/1.0.1 (linux; node/v1.2.3; x64)");
  assert.equal(headers["x-opencode-client"], "pi");
});
