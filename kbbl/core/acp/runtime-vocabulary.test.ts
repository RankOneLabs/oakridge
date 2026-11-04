/**
 * The launch pickers must speak the pinned agent's vocabulary.
 *
 * `resolveRequestedOption` matches a requested model or effort against the
 * agent's advertised config options, and a miss fails provisioning with
 * `requested_model_unsupported` — the session ends before its first turn. So
 * a RUNTIME_MODELS entry no advertised vocabulary can satisfy is not a
 * cosmetic mismatch, it is a button that always fails, and nothing outside
 * these tests notices until an operator clicks it.
 *
 * "The" vocabulary is really several: an agent's ids can move between
 * `session/new` calls as entitlements change (see the fixture). Every picker
 * entry must resolve against every recorded variant.
 *
 * `gpt-6.1-sol` used to be carved out of that rule as entitlement-dependent.
 * It was not: codex-acp fetches its model list remotely, so the id was always
 * advertised, while the stale bundled codex binary could not actually select
 * it. Driving the installed CLI removed the discrepancy and the carve-out
 * with it — a picker entry that cannot resolve is now always a failure.
 */

import { describe, expect, test } from "bun:test";
import type * as schema from "@agentclientprotocol/sdk";

import {
  defaultModelForRuntime,
  isRuntimeId,
  RUNTIME_EFFORTS,
  RUNTIME_MODELS,
  withoutContextHint,
  type RuntimeId,
} from "../runtime";
import { resolveRequestedOption } from "./controller";
import {
  ADVERTISED_AGENT_VOCABULARY,
  type AdvertisedAgentVocabulary,
} from "./__fixtures__/agent-config-options";

/** Rebuilds the agent's `session/new` config options from one variant. */
function advertisedOptions(
  vocabulary: AdvertisedAgentVocabulary,
  modelValues: readonly string[],
): schema.SessionConfigOption[] {
  return [
    {
      type: "select",
      id: vocabulary.model_option_id,
      name: "Model",
      category: "model",
      currentValue: modelValues[0]!,
      options: modelValues.map((value) => ({ value, name: value })),
    },
    {
      type: "select",
      id: vocabulary.effort_option_id,
      name: "Reasoning effort",
      category: "thought_level",
      currentValue: vocabulary.effort_values[0]!,
      options: vocabulary.effort_values.map((value) => ({ value, name: value })),
    },
  ];
}

const RUNTIME_IDS: readonly RuntimeId[] = Object.keys(
  ADVERTISED_AGENT_VOCABULARY,
).filter(isRuntimeId);

/**
 * The model families every recorded variant agrees on, minus `default` —
 * which is the agent restating its own current selection rather than a model
 * an operator would pick. Families rather than ids because `opus` and
 * `opus[1m]` are the same pick; variants disagree on the spelling, never on
 * whether opus is available.
 *
 * Models only *some* variants advertise are deliberately not required of the
 * picker: offering a model that disappears for hours is the failure this
 * whole file exists to prevent.
 *
 * Codex has no alias/explicit split — every id it advertises is a model an
 * operator would pick — so for that runtime this is the whole advertised
 * list.
 *
 * Generation-pinned ids are excluded too, and that exclusion does the real
 * work now that claude-code records a single variant. The Claude CLI
 * advertises a family alias (`opus`, `sonnet`) beside explicit ids naming one
 * generation of that family (`claude-opus-5`, `claude-sonnet-4-6`), and the
 * picker deliberately carries only the aliases — see RUNTIME_MODELS. Without
 * this filter the assertion would read the single variant as "every id is
 * universally available" and demand the picker list Opus 4.6 and Sonnet 4.6
 * alongside the current four.
 */
function isGenerationPinnedId(value: string): boolean {
  return value.startsWith("claude-");
}

function familiesInEveryVariant(vocabulary: AdvertisedAgentVocabulary): string[] {
  const perVariant = vocabulary.model_value_variants.map(
    (values) =>
      new Set(
        values
          .filter((value) => value !== "default")
          .filter((value) => !isGenerationPinnedId(value))
          .map((value) => withoutContextHint(value.toLowerCase())),
      ),
  );
  const [first, ...rest] = perVariant;
  if (!first) return [];
  return [...first]
    .filter((family) => rest.every((variant) => variant.has(family)))
    .sort();
}

for (const runtimeId of RUNTIME_IDS) describe(`${runtimeId} launch picker`, () => {
  const vocabulary = ADVERTISED_AGENT_VOCABULARY[runtimeId];
  const variants = vocabulary.model_value_variants.map((modelValues) => ({
    modelValues,
    options: advertisedOptions(vocabulary, modelValues),
  }));

  for (const [index, variant] of variants.entries()) {
    test(`every generally offered model resolves against advertised variant ${index}`, () => {
      const unresolvable = RUNTIME_MODELS[runtimeId]
        .map((option) => option.value)
        .filter((value) => !resolveRequestedOption(variant.options, "model", value).ok);
      expect(unresolvable).toEqual([]);
    });

    test(`the default model resolves against advertised variant ${index}`, () => {
      const resolved = resolveRequestedOption(
        variant.options,
        "model",
        defaultModelForRuntime(runtimeId),
      );
      expect(resolved.ok).toBe(true);
    });
  }

  test("every offered effort is one the agent accepts", () => {
    const unresolvable = RUNTIME_EFFORTS[runtimeId]
      .map((option) => option.value)
      .filter(
        (value) =>
          !resolveRequestedOption(variants[0]!.options, "thought_level", value)
            .ok,
      );
    expect(unresolvable).toEqual([]);
  });

  // Every universally available family alias belongs in the picker. Claude's
  // generation-pinned `claude-*` ids are offered by the agent but
  // deliberately absent from it.
  test("the picker offers every model family all variants agree on", () => {
    const offered = RUNTIME_MODELS[runtimeId]
      .map((option) => withoutContextHint(option.value.toLowerCase()));
    const missing = familiesInEveryVariant(vocabulary).filter(
      (family) => !offered.includes(family),
    );
    expect(missing).toEqual([]);
  });

  test("the offered efforts are exactly the efforts the agent advertises", () => {
    const offered = RUNTIME_EFFORTS[runtimeId].map((option) => option.value);
    expect(offered.sort()).toEqual(
      vocabulary.effort_values.filter((value) => value !== "default").sort(),
    );
  });
});

/**
 * The rule that keeps this file's other assertions from going stale: kbbl
 * never persists a generation-pinned Claude id.
 *
 * The CLI advertises `opus` beside `claude-opus-5`, and both resolve. Picking
 * the alias means a new generation reaches operators with no kbbl release;
 * picking the explicit id pins kbbl to one generation until someone notices,
 * which is exactly how `sonnet 5` and `haiku 4.5` sat in the picker while the
 * account was entitled to 5.5. It also bounds the retired-id map: an id kbbl
 * never writes cannot become a stale row when the vendor withdraws it.
 *
 * Codex is deliberately exempt — it advertises no alias/generation split, so
 * every id it offers is one an operator would pick, and the per-variant
 * assertions above are the whole guard there.
 */
test("the Claude picker carries no generation-pinned id", () => {
  const pinned = RUNTIME_MODELS["claude-code"]
    .map((option) => option.value)
    .filter(isGenerationPinnedId);

  expect(pinned).toEqual([]);
});

/**
 * The regression greptile caught: a durable row outlives the picker.
 *
 * `epics.planner_model` and `acp_sessions.requested_model` hold free text
 * written whenever the operator chose, and `applyRequestedConfig` forwards it
 * verbatim on every respawn. A row holding an id the agent has since stopped
 * advertising must land on the alias that replaced it, not kill the session.
 */
describe("a retired model id stored before the picker moved on", () => {
  const claudeOptions = advertisedOptions(
    ADVERTISED_AGENT_VOCABULARY["claude-code"],
    ADVERTISED_AGENT_VOCABULARY["claude-code"].model_value_variants[0]!,
  );

  test("resolves to the family alias that replaced it", () => {
    const resolved = resolveRequestedOption(claudeOptions, "model", "claude-fable-5-1");

    expect(resolved.ok && resolved.value?.valueId).toBe("fable");
  });

  test("resolves when it also carries a context hint", () => {
    const resolved = resolveRequestedOption(
      claudeOptions,
      "model",
      "claude-fable-5-1[1m]",
    );

    expect(resolved.ok && resolved.value?.valueId).toBe("fable");
  });

  test("an advertised id still matches exactly, not through the alias map", () => {
    const resolved = resolveRequestedOption(claudeOptions, "model", "claude-fable-5");

    expect(resolved.ok && resolved.value?.valueId).toBe("claude-fable-5");
  });
});

test("a model the agent does not advertise is rejected, not silently ignored", () => {
  // The regression itself: kbbl offered gpt-6-astra while the pinned
  // codex-acp (1.7.0) knew nothing about it.
  const options = advertisedOptions(ADVERTISED_AGENT_VOCABULARY.codex, [
    "gpt-5.6-sol",
  ]);
  const resolved = resolveRequestedOption(options, "model", "gpt-6-astra");
  expect(resolved.ok).toBe(false);
  if (!resolved.ok) expect(resolved.error.code).toBe("requested_model_unsupported");
});

test("a context hint is dropped to reach the same model, and says so", () => {
  // Variant with no `opus[1m]` on offer: a stored `opus[1m]` selection still
  // has to land, on the 200K opus, loudly enough for the caller to log it.
  const options = advertisedOptions(ADVERTISED_AGENT_VOCABULARY["claude-code"], [
    "default",
    "opus",
    "sonnet",
  ]);
  const resolved = resolveRequestedOption(options, "model", "opus[1m]");
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.value?.valueId).toBe("opus");
  expect(resolved.value?.match).toEqual({
    kind: "context_hint_ignored",
    requestedHint: "1m",
    matchedHint: null,
  });
});

test("a hintless request reaches the only advertised spelling, which has a hint", () => {
  const options = advertisedOptions(ADVERTISED_AGENT_VOCABULARY["claude-code"], [
    "default",
    "opus[1m]",
    "sonnet",
  ]);
  const resolved = resolveRequestedOption(options, "model", "opus");
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.value?.valueId).toBe("opus[1m]");
});

test("an exactly advertised id never counts as a hint-dropped match", () => {
  const options = advertisedOptions(ADVERTISED_AGENT_VOCABULARY["claude-code"], [
    "default",
    "opus",
    "opus[1m]",
  ]);
  const resolved = resolveRequestedOption(options, "model", "opus[1m]");
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(resolved.value?.valueId).toBe("opus[1m]");
  expect(resolved.value?.match).toEqual({ kind: "exact" });
});
