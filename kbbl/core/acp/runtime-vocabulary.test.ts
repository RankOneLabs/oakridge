/**
 * The launch pickers must speak the pinned agent's vocabulary.
 *
 * `resolveRequestedOption` matches a requested model or effort against the
 * agent's advertised config options by exact value id or exact display name,
 * and a miss fails provisioning with `requested_model_unsupported` — the
 * session ends before its first turn. So a RUNTIME_MODELS entry the agent
 * does not advertise is not a cosmetic mismatch, it is a button that always
 * fails, and nothing outside these tests notices until an operator clicks it.
 */

import { describe, expect, test } from "bun:test";
import type * as schema from "@agentclientprotocol/sdk";

import {
  defaultModelForRuntime,
  isRuntimeId,
  RUNTIME_EFFORTS,
  RUNTIME_MODELS,
  type RuntimeId,
} from "../runtime";
import { resolveRequestedOption } from "./controller";
import {
  ADVERTISED_AGENT_VOCABULARY,
  type AdvertisedAgentVocabulary,
} from "./__fixtures__/agent-config-options";

/** Rebuilds the agent's `session/new` config options from the fixture. */
function advertisedOptions(
  vocabulary: AdvertisedAgentVocabulary,
): schema.SessionConfigOption[] {
  return [
    {
      type: "select",
      id: vocabulary.model_option_id,
      name: "Model",
      category: "model",
      currentValue: vocabulary.model_values[0]!,
      options: vocabulary.model_values.map((value) => ({ value, name: value })),
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
 * The picker offers everything the agent advertises except `default`, which
 * is the agent restating its own current selection rather than a model an
 * operator would pick.
 */
function offerable(values: readonly string[]): string[] {
  return values.filter((value) => value !== "default").sort();
}

for (const runtimeId of RUNTIME_IDS) describe(`${runtimeId} launch picker`, () => {
  const vocabulary = ADVERTISED_AGENT_VOCABULARY[runtimeId];
  const options = advertisedOptions(vocabulary);

  test("every offered model is one the agent accepts", () => {
    const unresolvable = RUNTIME_MODELS[runtimeId]
      .map((option) => option.value)
      .filter(
        (value) => !resolveRequestedOption(options, "model", value).ok,
      );
    expect(unresolvable).toEqual([]);
  });

  test("every offered effort is one the agent accepts", () => {
    const unresolvable = RUNTIME_EFFORTS[runtimeId]
      .map((option) => option.value)
      .filter(
        (value) => !resolveRequestedOption(options, "thought_level", value).ok,
      );
    expect(unresolvable).toEqual([]);
  });

  test("the default model is one the agent accepts", () => {
    const resolved = resolveRequestedOption(
      options,
      "model",
      defaultModelForRuntime(runtimeId),
    );
    expect(resolved.ok).toBe(true);
  });

  // The resolver checks above catch a picker entry the agent dropped. These
  // catch the other direction — a bump that *adds* a model or effort and
  // leaves the picker unable to offer it, which no resolver check can see.
  // Together they pin the picker to exactly the agent's vocabulary, minus the
  // `default` entry the agent uses to restate its own current selection.

  test("the offered models are exactly the models the agent advertises", () => {
    const offered = RUNTIME_MODELS[runtimeId].map((option) => option.value);
    expect(offered.sort()).toEqual(offerable(vocabulary.model_values));
  });

  test("the offered efforts are exactly the efforts the agent advertises", () => {
    const offered = RUNTIME_EFFORTS[runtimeId].map((option) => option.value);
    expect(offered.sort()).toEqual(offerable(vocabulary.effort_values));
  });
});

test("a model the agent does not advertise is rejected, not silently ignored", () => {
  // The regression itself: kbbl offered gpt-6-astra while the pinned
  // codex-acp (1.7.0) knew nothing about it.
  const options = advertisedOptions({
    ...ADVERTISED_AGENT_VOCABULARY.codex,
    model_values: ["gpt-5.6-sol"],
  });
  const resolved = resolveRequestedOption(options, "model", "gpt-6-astra");
  expect(resolved.ok).toBe(false);
  if (!resolved.ok) expect(resolved.error.code).toBe("requested_model_unsupported");
});
