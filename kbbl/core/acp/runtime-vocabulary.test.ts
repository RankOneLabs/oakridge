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
 * "The" vocabulary is really several: Claude Code's ids move between
 * `session/new` calls as the 1M context entitlement comes and goes (see the
 * fixture). Every picker entry therefore has to resolve against *each*
 * recorded variant, not against one snapshot.
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
 * Models only *some* variants advertise (the legacy 4.x ids that surface when
 * the 1M entitlement is absent) are deliberately not required of the picker:
 * offering a model that disappears for hours is the failure this whole file
 * exists to prevent.
 */
function familiesInEveryVariant(vocabulary: AdvertisedAgentVocabulary): string[] {
  const perVariant = vocabulary.model_value_variants.map(
    (values) =>
      new Set(
        values
          .filter((value) => value !== "default")
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
    test(`every offered model resolves against advertised variant ${index}`, () => {
      const unresolvable = RUNTIME_MODELS[runtimeId]
        .map((option) => option.value)
        .filter(
          (value) => !resolveRequestedOption(variant.options, "model", value).ok,
        );
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

  // The resolver checks above catch a picker entry the agent dropped. This
  // catches the other direction — a bump that *adds* a model and leaves the
  // picker unable to offer it, which no resolver check can see.
  test("the picker offers every model family all variants agree on", () => {
    const offered = RUNTIME_MODELS[runtimeId]
      .map((option) => withoutContextHint(option.value.toLowerCase()))
      .sort();
    expect(offered).toEqual(familiesInEveryVariant(vocabulary));
  });

  test("the offered efforts are exactly the efforts the agent advertises", () => {
    const offered = RUNTIME_EFFORTS[runtimeId].map((option) => option.value);
    expect(offered.sort()).toEqual(
      vocabulary.effort_values.filter((value) => value !== "default").sort(),
    );
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
