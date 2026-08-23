import fs from "node:fs";
import path from "node:path";

import {
  DOCUMENTED_MODEL_EXCLUSIONS,
  getCanonicalComboManifest,
} from "../../src/lib/combos/canonicalEconomicPools.ts";
import { PROVIDER_CATALOG_SELECTION_EVIDENCE } from "../../src/lib/combos/tierEvidence.ts";

const TIERS = ["haiku", "sonnet", "opus", "fable"];
const PRICING = ["free", "subscription", "credits", "api", "unknown"];
const REPORT_PATH = path.resolve("docs/routing/COMBO_MODEL_REPORT.md");
const escapeCell = (value) =>
  String(value ?? "—")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
const title = (value) => value[0].toUpperCase() + value.slice(1);
const pricingTitle = (value) => (value === "api" ? "Metered API" : title(value));

function renderReport() {
  const evidence = [...PROVIDER_CATALOG_SELECTION_EVIDENCE];
  const manifest = getCanonicalComboManifest();
  const observedAt =
    evidence
      .map((entry) => entry.observedAt)
      .sort()
      .at(-1) ?? "unknown";
  const manifestRoutes = new Set(
    manifest.combos.flatMap((combo) =>
      combo.models.flatMap((step) => (step.kind === "model" ? [step.model] : []))
    )
  );
  const evidenceRoutes = new Set(evidence.map((entry) => entry.routedModel));
  const reviewedRoutes = new Set([...evidenceRoutes, ...manifestRoutes]);
  const managedRoutes = new Set(
    [...reviewedRoutes].filter((route) => !DOCUMENTED_MODEL_EXCLUSIONS.includes(route))
  );
  const uncovered = [...reviewedRoutes].filter(
    (route) => !managedRoutes.has(route) && !DOCUMENTED_MODEL_EXCLUSIONS.includes(route)
  );

  let output = "# Combo-ready provider and model report\n\n";
  output += `Last consolidated: ${observedAt}. This report is generated directly from the typed evidence ledger and canonical combo manifest.\n\n`;
  output += "## Classification policy\n\n";
  output +=
    "Performance uses Haiku, Sonnet, Opus, and Fable only. Pricing is a separate Free, Subscription, Credits, API, or Unknown axis. GPT-5.6 Luna/Terra/Sol names are compatibility and pricing identities, not performance tiers.\n\n";
  output +=
    "Artificial Analysis bands are Haiku ≤30, Sonnet 31–50, Opus 51–60, and Fable ≥61. The anchors are Claude Haiku 4.5, Claude Sonnet 4.6, Claude Opus 4.8, and performance strictly above ordinary Opus 4.8. Arena Code uses leaderboard quartiles. Exact model-and-effort conflicts take the lower tier; marked values reduce confidence; official-only assignments cannot exceed Opus.\n\n";
  output += "## Inventory summary\n\n";
  output += `- Managed model routes: ${managedRoutes.size}\n`;
  output += `- Reviewed evidence rows: ${evidence.length}\n`;
  output += `- Documented exclusions: ${DOCUMENTED_MODEL_EXCLUSIONS.length}\n`;
  output += `- Unreconciled reviewed routes: ${uncovered.length}\n`;
  for (const tier of TIERS) {
    output += `- ${title(tier)} evidence rows: ${evidence.filter((entry) => entry.intendedTier === tier).length}\n`;
  }
  output += "\n";

  for (const tier of TIERS) {
    output += `## ${title(tier)}\n\n`;
    for (const pricing of PRICING) {
      output += `### ${pricingTitle(pricing)}\n\n`;
      const rows = evidence.filter(
        (entry) => entry.intendedTier === tier && entry.access === pricing
      );
      if (rows.length === 0) {
        output += "No reviewed candidates.\n\n";
        continue;
      }
      output += "| Routed model | Provider | Probe | Quota pool | Selection basis |\n";
      output += "|---|---|---|---|---|\n";
      for (const entry of rows) {
        output += `| \`${escapeCell(entry.routedModel)}\` | ${escapeCell(entry.provider)} | ${escapeCell(entry.probeStatus)} | ${escapeCell(entry.quotaPool)} | ${escapeCell(entry.rationale)} |\n`;
      }
      output += "\n";
    }
  }

  output += "## Fable fallback status\n\n";
  const fableLeaves = manifest.combos.filter((combo) => combo.config.fallbackForTier === "fable");
  output +=
    "No operational route currently has reviewed Fable evidence. The following leaves keep the Fable entrypoint available using explicitly labeled Opus-class fallbacks:\n\n";
  for (const combo of fableLeaves) {
    const routes = combo.models.map((step) =>
      step.kind === "model" ? `\`${step.model}\`` : `\`${step.comboName}\``
    );
    output += `- \`${combo.name}\`: ${routes.join(", ")}\n`;
  }

  output += "\n## Documented exclusions\n\n";
  for (const route of DOCUMENTED_MODEL_EXCLUSIONS) output += `- \`${route}\`\n`;
  output += "\n## Reconciliation\n\n";
  output +=
    uncovered.length === 0
      ? "Every route from the evidence ledger or canonical manifest is classified as managed or listed as a documented exclusion.\n"
      : `Routes requiring evidence: ${uncovered.map((route) => `\`${route}\``).join(", ")}\n`;
  return output;
}

const report = renderReport();
if (process.argv.includes("--check")) {
  const current = fs.existsSync(REPORT_PATH) ? fs.readFileSync(REPORT_PATH, "utf8") : "";
  if (current !== report) {
    console.error(`${REPORT_PATH} is stale; regenerate it without --check`);
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(REPORT_PATH, report);
}
