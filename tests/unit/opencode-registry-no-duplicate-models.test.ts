// Duplicate model ids inside one provider registry resolve first-wins, so a
// second entry is dead metadata that can drift out of sync (observed:
// muse-spark-1.3-contributor-free listed twice in the opencode registry with
// different supportedToolChoiceModes). Fail closed on any intra-registry dup.
import { test } from "node:test";
import assert from "node:assert/strict";

import { opencodeProvider } from "../../open-sse/config/providers/registry/opencode/index.ts";
import { opencode_goProvider } from "../../open-sse/config/providers/registry/opencode/go/index.ts";
import { opencode_zenProvider } from "../../open-sse/config/providers/registry/opencode/zen/index.ts";

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes].sort();
}

for (const [name, provider] of [
  ["opencode", opencodeProvider],
  ["opencode-go", opencode_goProvider],
  ["opencode-zen", opencode_zenProvider],
] as const) {
  test(`${name} registry has no duplicate model ids`, () => {
    const ids = (provider.models ?? []).map((m) => m.id);
    assert.deepEqual(duplicates(ids), [], `duplicate model ids in ${name}`);
  });
}
