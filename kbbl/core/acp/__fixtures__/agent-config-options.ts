// What the pinned ACP agents actually advertise as selectable models and
// reasoning efforts (§12 config options), captured from the binaries in
// kbbl/node_modules/.bin at the versions kbbl/package.json pins.
//
// This exists because `resolveRequestedOption` matches a requested model or
// effort against these ids, and a miss kills the session during provisioning
// with `requested_model_unsupported` — before its first turn, with an exit
// code of 1 and nothing else to go on. A picker entry no agent advertises is
// a launch button that always fails, and kbbl shipped eight of them (every
// Claude Code model, plus Codex's gpt-5.4 and gpt-5.4-mini).
//
// **A vocabulary is a list of variants, not a snapshot.** Claude Code's model
// ids are not a property of the pinned package: the same binary answers
// `session/new` with different ids as the 1M context entitlement comes and
// goes, and 0.76.0 and 0.81.1 probed back-to-back returned identical lists at
// each point in time while both drifted together across ~40 minutes. All four
// variants below came from one afternoon on one machine. `opus[1m]` and
// `opus` are each sometimes the only opus advertised, which is why the
// resolver treats a context hint as droppable rather than defining.
//
// Two tests hang off this file, and together they chain the picker to the
// installed binary:
//   - runtime-vocabulary.test.ts (default CI) checks RUNTIME_MODELS and
//     RUNTIME_EFFORTS resolve against every variant here.
//   - real-agent.smoke.test.ts (opt-in, needs the real agents and real auth)
//     checks that what the binary advertises right now is one of them.
//
// Bumping an `@agentclientprotocol/*` pin means running the smoke test and
// updating this file and core/runtime.ts together. The ids do drift on their
// own too: claude-agent-acp 0.70.0's `claude-fable-5[1m]` became 0.76.0's
// `claude-fable-5-1[1m]`, which would silently break every Fable launch. A
// smoke run that reports a list matching no variant is new drift — add it
// here rather than replacing what is already recorded.

import type { RuntimeId } from "../../runtime";

export interface AdvertisedAgentVocabulary {
  /** The npm package whose pinned version this was captured from. */
  readonly package: string;
  readonly version: string;
  /** Config option id carrying `category: "model"`. */
  readonly model_option_id: string;
  /** Config option id carrying `category: "thought_level"`. */
  readonly effort_option_id: string;
  /**
   * Every model list observed from `session/new`, each in advertised order
   * and including the agent's own "default" entry, which kbbl deliberately
   * does not list in its pickers (an unset model expresses the same thing).
   *
   * More than one entry means the agent's vocabulary moves under kbbl without
   * the pin moving. A picker entry has to resolve against all of them.
   */
  readonly model_value_variants: readonly (readonly string[])[];
  readonly effort_values: readonly string[];
}

export const ADVERTISED_AGENT_VOCABULARY: Readonly<
  Record<RuntimeId, AdvertisedAgentVocabulary>
> = {
  "claude-code": {
    package: "@agentclientprotocol/claude-agent-acp",
    version: "0.76.0",
    model_option_id: "model",
    effort_option_id: "effort",
    model_value_variants: [
      // 1M entitlement present, legacy models withheld.
      ["default", "opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"],
      // As above, plus the hintless opus alias.
      ["default", "opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku", "opus"],
      // 1M entitlement absent: hintless current ids, legacy models exposed,
      // `opus[1m]` demoted to the end of the list.
      [
        "default",
        "opus",
        "claude-fable-5-1",
        "sonnet",
        "haiku",
        "claude-opus-5",
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "opus[1m]",
      ],
      // As above with no `opus[1m]` on offer at all.
      [
        "default",
        "opus",
        "claude-fable-5-1",
        "sonnet",
        "haiku",
        "claude-opus-5",
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-opus-4-6",
        "claude-sonnet-4-6",
      ],
    ],
    effort_values: ["default", "low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    package: "@agentclientprotocol/codex-acp",
    version: "1.13.0",
    model_option_id: "model",
    effort_option_id: "reasoning_effort",
    // Only ever observed as one list. Codex ids carry no context hint, so
    // there is no known axis for them to drift along — but that is an absence
    // of evidence, not a guarantee.
    model_value_variants: [
      [
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
      ],
    ],
    effort_values: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
};
