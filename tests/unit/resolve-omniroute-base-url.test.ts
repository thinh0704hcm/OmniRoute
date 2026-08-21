import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_OMNIROUTE_BASE_URL,
  resolveOmniRouteBaseUrl,
} from "../../src/shared/utils/resolveOmniRouteBaseUrl.ts";

test("resolveOmniRouteBaseUrl prefers OMNIROUTE_BASE_URL", () => {
  assert.equal(
    resolveOmniRouteBaseUrl({
      OMNIROUTE_BASE_URL: "https://internal.example.com/",
      BASE_URL: "https://base.example.com",
      NEXT_PUBLIC_BASE_URL: "https://public.example.com",
    }),
    "https://internal.example.com"
  );
});

test("resolveOmniRouteBaseUrl falls back to BASE_URL", () => {
  assert.equal(
    resolveOmniRouteBaseUrl({
      BASE_URL: "https://base.example.com/",
      NEXT_PUBLIC_BASE_URL: "https://public.example.com",
    }),
    "https://base.example.com"
  );
});

test("resolveOmniRouteBaseUrl falls back to NEXT_PUBLIC_BASE_URL", () => {
  assert.equal(
    resolveOmniRouteBaseUrl({
      NEXT_PUBLIC_BASE_URL: "https://public.example.com/",
    }),
    "https://public.example.com"
  );
});

test("resolveOmniRouteBaseUrl prefers OMNIROUTE_PORT when no base URL is set", () => {
  assert.equal(
    resolveOmniRouteBaseUrl({
      OMNIROUTE_PORT: 20130,
      PORT: 20128,
    }),
    "http://localhost:20130"
  );
});

test("resolveOmniRouteBaseUrl falls back to PORT when OMNIROUTE_PORT is not set", () => {
  assert.equal(
    resolveOmniRouteBaseUrl({
      PORT: "30130",
    }),
    "http://localhost:30130"
  );
});

test("resolveOmniRouteBaseUrl prefers explicit base URL over port settings", () => {
  assert.equal(
    resolveOmniRouteBaseUrl({
      OMNIROUTE_BASE_URL: "https://custom.omniroute.local",
      OMNIROUTE_PORT: 20130,
      PORT: 20130,
    }),
    "https://custom.omniroute.local"
  );
});

test("resolveOmniRouteBaseUrl ignores blank values", () => {
  assert.equal(
    resolveOmniRouteBaseUrl({
      OMNIROUTE_BASE_URL: "   ",
      BASE_URL: "",
      NEXT_PUBLIC_BASE_URL: " https://public.example.com/ ",
    }),
    "https://public.example.com"
  );
});

test("resolveOmniRouteBaseUrl handles blank port by falling back to default port", () => {
  assert.equal(
    resolveOmniRouteBaseUrl({
      OMNIROUTE_PORT: "   ",
      PORT: "",
    }),
    DEFAULT_OMNIROUTE_BASE_URL
  );
});

test("resolveOmniRouteBaseUrl uses the default localhost fallback", () => {
  assert.equal(resolveOmniRouteBaseUrl({}), DEFAULT_OMNIROUTE_BASE_URL);
});
