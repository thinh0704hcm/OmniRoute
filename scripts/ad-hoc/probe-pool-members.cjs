/**
 * Probe every distinct pool member and classify whether the live catalog will
 * serve it.
 *
 * Prune signal is narrow on purpose: ONLY a 400 whose body says
 * "not available in the active live catalog". A 429/5xx/timeout is a transient
 * upstream state and must never cost a member its slot.
 */
const fs = require("node:fs");

const s = JSON.parse(fs.readFileSync(process.env.HOME + "/.claude/settings.json", "utf8"));
const key = s.env.ANTHROPIC_API_KEY;
const base = s.env.ANTHROPIC_BASE_URL;
const members = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const outPath = process.argv[3];

const results = [];
(async () => {
  for (const m of members) {
    const t0 = Date.now();
    let status = 0;
    let body = "";
    try {
      const r = await fetch(base + "/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: m.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ok" }],
        }),
        signal: AbortSignal.timeout(30000),
      });
      status = r.status;
      body = (await r.text()).replace(/\s+/g, " ");
    } catch (e) {
      status = -1;
      body = `transport: ${e.name}`;
    }
    const catalogRejected =
      status === 400 && /not available in the active live catalog/i.test(body);
    results.push({
      model: m.model,
      providerId: m.providerId,
      pools: m.pools,
      status,
      catalogRejected,
      ms: Date.now() - t0,
      note: body.slice(0, 120),
    });
    console.log(
      `${catalogRejected ? "PRUNE " : "keep  "} ${String(status).padStart(4)} ${String(Date.now() - t0).padStart(6)}ms  ${m.model}`
    );
    fs.writeFileSync(outPath, JSON.stringify(results, null, 1));
  }
  const n = results.filter((r) => r.catalogRejected).length;
  console.log(`\nDONE — probed ${results.length}, catalog-rejected ${n}`);
})();
