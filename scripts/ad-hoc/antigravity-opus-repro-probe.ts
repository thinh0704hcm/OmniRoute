/**
 * scripts/ad-hoc/antigravity-opus-repro-probe.ts
 *
 * One-shot probe for the production failure:
 *   antigravity/<any-model> → 502 "Cannot read properties of undefined
 *   (reading 'aborted')" in 12–47ms, provider-wide, no network round-trip.
 *
 * Stage 1 (execute() with an explicit projectId + stubbed fetch) resolved
 * cleanly, and the translator is clean too. Production connections DO have a
 * projectId stored, but the executor still runs its project/identity
 * resolution — which the earlier probe skipped by passing projectId directly.
 * This probe exercises that path with several bootstrapping failure shapes.
 */

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { seedAntigravityIdeVersionCache } from "../../open-sse/services/antigravityVersion.ts";
import { clearAntigravityProjectCache } from "../../open-sse/services/antigravityProjectBootstrap.ts";

const originalFetch = globalThis.fetch;

function stubFetch(behavior: "ok" | "reject" | "500") {
  let calls = 0;
  globalThis.fetch = (async (url: unknown) => {
    calls += 1;
    if (behavior === "reject") throw new Error("stub network failure");
    if (behavior === "500") return new Response("boom", { status: 500 });
    return new Response(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n',
      {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }
    );
  }) as typeof globalThis.fetch;
  return () => calls;
}

const executor = new AntigravityExecutor();
const log = { debug() {}, warn() {}, info() {}, error() {} };

const cases: Array<{
  name: string;
  credentials: Record<string, unknown>;
  fetch: "ok" | "reject" | "500";
}> = [
  {
    name: "no projectId (forces bootstrap), fetch ok",
    credentials: { accessToken: "token" },
    fetch: "ok",
  },
  { name: "no projectId, fetch rejects", credentials: { accessToken: "token" }, fetch: "reject" },
  { name: "no projectId, fetch 500", credentials: { accessToken: "token" }, fetch: "500" },
  { name: "no accessToken, no projectId", credentials: {}, fetch: "ok" },
];

for (const c of cases) {
  clearAntigravityProjectCache();
  seedAntigravityIdeVersionCache("2.1.1");
  const calls = stubFetch(c.fetch);
  process.stdout.write(`  • ${c.name}\n`);
  try {
    const result = await executor.execute({
      model: "antigravity/claude-opus-4-6-thinking",
      body: { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
      stream: true,
      credentials: c.credentials,
      log,
    } as never);
    const status = (result as { response?: Response })?.response?.status ?? "n/a";
    console.log(`      → resolved status=${status}, fetchCalls=${calls()}\n`);
  } catch (err) {
    const e = err as Error;
    console.log(`      → THREW ${e?.name}: ${e?.message} (fetchCalls=${calls()})`);
    console.log(`      ${String(e?.stack).split("\n").slice(1, 5).join("\n      ")}\n`);
  }
}

globalThis.fetch = originalFetch;
