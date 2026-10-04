/**
 * tests/unit/combo-runtime-config-no-strip.test.ts
 *
 * Guard for combo config knobs that exist in `DEFAULT_COMBO_CONFIG` but are not
 * declared in `comboRuntimeConfigSchema`.
 *
 * `comboRuntimeConfigSchema` is `.passthrough()`, so an undeclared knob is not
 * dropped — it round-trips *unvalidated*. That is a quiet failure mode of its
 * own: a bad value reaches the engine with no range check, and nothing in the
 * suite notices that the operator-facing surface and the engine's defaults have
 * drifted apart.
 *
 * The invariant pinned here: every key `DEFAULT_COMBO_CONFIG` defines must
 * survive a schema parse, so the two lists cannot diverge silently.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { comboRuntimeConfigSchema } from "../../src/shared/validation/schemas/combo.ts";
import { getDefaultComboConfig } from "../../open-sse/services/comboConfig.ts";

test("every DEFAULT_COMBO_CONFIG key survives the runtime config schema", () => {
  const defaults = getDefaultComboConfig();
  const parsed = comboRuntimeConfigSchema.parse({ ...defaults }) as Record<string, unknown>;

  const dropped = Object.keys(defaults).filter((key) => !(key in parsed));
  assert.deepEqual(
    dropped,
    [],
    `comboRuntimeConfigSchema silently strips: ${dropped.join(", ")} — declare them in ` +
      `src/shared/validation/schemas/combo.ts or the engine never sees the stored value`
  );
});

test("the schema passes unknown keys through — declaring is about validation", () => {
  // comboRuntimeConfigSchema is `.passthrough()`, so an undeclared knob is NOT
  // stripped (this suite originally assumed it was, which is why the header
  // above says "the key still has to be declared" rather than "it is dropped").
  // What declaring buys is the range check: without it, a knob round-trips
  // unvalidated.
  const parsed = comboRuntimeConfigSchema.parse({
    firstContentTimeoutMs: 15000,
    __undeclaredProbeKey: "survives",
  }) as Record<string, unknown>;

  assert.equal(parsed.firstContentTimeoutMs, 15_000, "a declared knob must pass through");
  assert.equal(
    parsed.__undeclaredProbeKey,
    "survives",
    "the schema is passthrough — undeclared keys are preserved, not stripped"
  );
});

test("firstContentTimeoutMs accepts the operator-facing range", () => {
  for (const ok of [0, 1_200, 15_000, 300_000]) {
    const parsed = comboRuntimeConfigSchema.parse({ firstContentTimeoutMs: ok }) as {
      firstContentTimeoutMs?: number;
    };
    assert.equal(parsed.firstContentTimeoutMs, ok, `${ok} must be accepted`);
  }

  for (const bad of [-1, 300_001, Number.NaN]) {
    assert.equal(
      comboRuntimeConfigSchema.safeParse({ firstContentTimeoutMs: bad }).success,
      false,
      `${bad} must be rejected`
    );
  }
});

test("a stored string value still resolves (dashboards round-trip numbers as strings)", () => {
  const parsed = comboRuntimeConfigSchema.parse({ firstContentTimeoutMs: "15000" }) as {
    firstContentTimeoutMs?: number;
  };
  assert.equal(parsed.firstContentTimeoutMs, 15_000);
});
