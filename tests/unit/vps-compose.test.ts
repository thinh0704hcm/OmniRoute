import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { defineSequenceTag, load, YAML11_SCHEMA } from "js-yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const COMPOSE_PATH = path.join(REPO_ROOT, "contrib/vps/compose.yaml");
const ORACLE_COMPOSE_PATH = path.join(REPO_ROOT, "contrib/vps/compose.oracle.yaml");
const CANARY_COMPOSE_PATH = path.join(REPO_ROOT, "contrib/vps/compose.canary.yaml");
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, "contrib/vps/.env.example");
const ORACLE_REMOTE_SCRIPT_PATH = path.join(REPO_ROOT, "scripts/ops/oracle-deploy-remote.sh");

type ComposeService = {
  container_name?: string;
  image?: string;
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  mem_limit?: string;
  memswap_limit?: string;
  cpus?: string;
};

type ComposeDocument = {
  services?: Record<string, ComposeService>;
};

const composeOverrideTag = defineSequenceTag<unknown[]>("!override", {
  create: () => [],
  addItem: (items, item) => {
    items.push(item);
  },
});
const composeOverrideSchema = YAML11_SCHEMA.withTags(composeOverrideTag);

function loadCompose(raw: string): ComposeDocument {
  return load(raw, { schema: composeOverrideSchema }) as ComposeDocument;
}

function readCompose(): { raw: string; parsed: ComposeDocument } {
  const raw = fs.readFileSync(COMPOSE_PATH, "utf8");
  return { raw, parsed: loadCompose(raw) };
}

test("VPS compose publishes only the OmniRoute dashboard on loopback by default", () => {
  const { parsed } = readCompose();
  const services = parsed.services ?? {};

  assert.deepEqual(services.redis?.ports, undefined, "Redis must not publish a host port");
  assert.deepEqual(services.omniroute?.ports, [
    "${OMNIROUTE_BIND_HOST:-127.0.0.1}:${OMNIROUTE_PORT:-20128}:20128",
  ]);
});

test("VPS compose requires an explicitly pinned image and production secrets", () => {
  const { raw, parsed } = readCompose();
  const omniroute = parsed.services?.omniroute;

  assert.equal(
    omniroute?.image,
    "${OMNIROUTE_IMAGE:?Set OMNIROUTE_IMAGE to a versioned tag or digest}"
  );
  assert.equal(omniroute?.environment?.REQUIRE_API_KEY, "${REQUIRE_API_KEY:-true}");
  assert.match(raw, /JWT_SECRET: \$\{JWT_SECRET:\?Set JWT_SECRET in \.env\}/);
  assert.match(raw, /API_KEY_SECRET: \$\{API_KEY_SECRET:\?Set API_KEY_SECRET in \.env\}/);
  assert.match(raw, /INITIAL_PASSWORD: \$\{INITIAL_PASSWORD:\?Set INITIAL_PASSWORD in \.env\}/);
  assert.match(
    raw,
    /OMNIROUTE_WS_BRIDGE_SECRET: \$\{OMNIROUTE_WS_BRIDGE_SECRET:\?Set OMNIROUTE_WS_BRIDGE_SECRET in \.env\}/
  );
});

test("VPS environment example uses a versioned image rather than a floating channel", () => {
  const env = fs.readFileSync(ENV_EXAMPLE_PATH, "utf8");

  assert.match(env, /^OMNIROUTE_IMAGE=[^\s:]+:\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/m);
  assert.doesNotMatch(env, /^OMNIROUTE_IMAGE=.*:(?:latest|next)$/m);
  assert.match(env, /^OMNIROUTE_BUILD_SHA=replace-with-git-sha$/m);
  assert.match(env, /^REDIS_BIND_HOST=127\.0\.0\.1$/m);
  assert.match(env, /^REQUIRE_API_KEY=true$/m);
});

test("Oracle overlay exposes only dashboard/API on loopback, squrvq origins, and 4-CPU enforcement", () => {
  const raw = fs.readFileSync(ORACLE_COMPOSE_PATH, "utf8");
  const parsed = loadCompose(raw);
  const service = parsed.services?.omniroute;

  assert.equal(service?.container_name, "omniroute-parallel");
  assert.deepEqual(service?.ports, [
    "${OMNIROUTE_BIND_HOST:-127.0.0.1}:20130:20130",
    "${OMNIROUTE_API_BIND_HOST:-127.0.0.1}:20131:20131",
  ]);
  assert.match(raw, /ports: !override/);
  assert.match(raw, /volumes: !override/);
  assert.deepEqual(service?.volumes, ["${OMNIROUTE_DATA_DIR:-/home/ubuntu/.omniroute}:/app/data"]);
  assert.equal(service?.environment?.PORT, "20130");
  assert.equal(service?.environment?.DASHBOARD_PORT, "20130");
  assert.equal(service?.environment?.API_PORT, "20131");
  assert.equal(service?.environment?.LIVE_WS_PORT, "20133");
  assert.equal(service?.environment?.LIVE_WS_HOST, "127.0.0.1");
  assert.equal(service?.environment?.API_HOST, "0.0.0.0");
  assert.equal(service?.environment?.ADAPTIVE_ADMISSION_MODE, "enforce");
  assert.equal(service?.environment?.OMNIROUTE_CHAT_VIRTUAL_LANES, "4");
  assert.equal(service?.environment?.NEXT_PUBLIC_BASE_URL, "https://squrvq.tail0bec0f.ts.net");
  assert.equal(service?.environment?.OMNIROUTE_PUBLIC_BASE_URL, "https://squrvq.tail0bec0f.ts.net");
  assert.equal(service?.environment?.LIVE_WS_PUBLIC_URL, "wss://squrvq.tail0bec0f.ts.net/live-ws");
  assert.equal(
    service?.environment?.NEXT_PUBLIC_LIVE_WS_PUBLIC_URL,
    "wss://squrvq.tail0bec0f.ts.net/live-ws"
  );
  assert.equal(service?.environment?.LIVE_WS_ALLOWED_ORIGINS, "https://squrvq.tail0bec0f.ts.net");
  assert.equal(service?.environment?.OMNIROUTE_BUILD_SHA, "${OMNIROUTE_BUILD_SHA:?required}");
  assert.equal(service?.mem_limit, "12g");
  assert.equal(service?.memswap_limit, "12g");
  assert.equal(service?.cpus, "4.0");
  assert.doesNotMatch(raw, /OMNIROUTE_WS_BIND_HOST/);
  assert.doesNotMatch(raw, /:20133/);
});

test("Oracle canary mirrors enforcement and exposes only dashboard/API locally", () => {
  const raw = fs.readFileSync(CANARY_COMPOSE_PATH, "utf8");
  const parsed = loadCompose(raw);
  const service = parsed.services?.omniroute;

  assert.equal(parsed.services?.redis?.image, "docker.io/library/redis:7.4.10-alpine");
  assert.equal(service?.container_name, "omniroute-canary");
  assert.deepEqual(service?.ports, ["127.0.0.1:30130:20130", "127.0.0.1:30131:20131"]);
  assert.equal(service?.environment?.LIVE_WS_HOST, "127.0.0.1");
  assert.equal(service?.environment?.ADAPTIVE_ADMISSION_MODE, "enforce");
  assert.equal(service?.environment?.OMNIROUTE_CHAT_VIRTUAL_LANES, "1");
  assert.equal(service?.cpus, "2.0");
  assert.deepEqual(service?.volumes, ["${OMNIROUTE_CANARY_DATA_DIR:?required}:/app/data"]);
  assert.match(raw, /ports: !override/);
  assert.match(raw, /volumes: !override/);
});

test("Oracle gateway keeps dashboard public and proxies LiveWS through the standalone wrapper", () => {
  const raw = fs.readFileSync(ORACLE_REMOTE_SCRIPT_PATH, "utf8");
  const exactGatewayStart = raw.indexOf("gateway_config_is_exact() {");
  const exactGatewayEnd = raw.indexOf("\nverify_gateway_runtime()", exactGatewayStart);
  const reconcileStart = raw.indexOf("reconcile_gateway() {");
  const reconcileEnd = raw.indexOf("\nrestore_gateway()", reconcileStart);

  assert.notEqual(exactGatewayStart, -1);
  assert.notEqual(exactGatewayEnd, -1);
  assert.notEqual(reconcileStart, -1);
  assert.notEqual(reconcileEnd, -1);

  const exactGateway = raw.slice(exactGatewayStart, exactGatewayEnd);
  const reconcile = raw.slice(reconcileStart, reconcileEnd);
  assert.match(exactGateway, /"\/": \{"Proxy": "http:\/\/127\.0\.0\.1:20130"\}/);
  assert.match(exactGateway, /"\/healthz": \{"Proxy": "http:\/\/127\.0\.0\.1:20130\/healthz"\}/);
  assert.match(exactGateway, /"\/live-ws": \{"Proxy": "http:\/\/127\.0\.0\.1:20130\/live-ws"\}/);
  assert.match(reconcile, /"http:\/\/127\.0\.0\.1:20130"/);
  assert.match(reconcile, /"http:\/\/127\.0\.0\.1:20130\/healthz"/);
  assert.match(reconcile, /"http:\/\/127\.0\.0\.1:20130\/live-ws"/);
  assert.doesNotMatch(`${exactGateway}\n${reconcile}`, /127\.0\.0\.1:20133/);
});
