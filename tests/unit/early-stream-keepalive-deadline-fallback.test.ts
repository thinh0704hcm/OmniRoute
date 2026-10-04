// withDeadlineSignal must never take down a route: if rebuilding the request
// throws (e.g. cross-realm Request/Headers instances in bundled runtimes —
// observed in production as "Cannot read private member #state"), fall back
// to the original request with an inert controller instead of 500ing.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { withDeadlineSignal } from "../../open-sse/utils/earlyStreamKeepalive.ts";

describe("withDeadlineSignal fallback", () => {
  it("returns the original request when reconstruction throws", () => {
    const foreign = {} as unknown as Request;
    const { wrappedReq, deadlineController } = withDeadlineSignal(foreign);
    assert.equal(wrappedReq, foreign);
    assert.ok(deadlineController instanceof AbortController);
  });

  it("still wraps normal requests with a combined signal and token", () => {
    const req = new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m" }),
    });
    const { wrappedReq, deadlineController } = withDeadlineSignal(req);
    assert.notEqual(wrappedReq, req);
    assert.equal(wrappedReq.headers.get("x-deadline-token")?.startsWith("dl-"), true);
    assert.ok(deadlineController instanceof AbortController);
    assert.equal(wrappedReq.method, "POST");
  });
});
