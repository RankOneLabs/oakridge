// What the ACP agents kbbl launches actually advertise as selectable models
// and reasoning efforts (§12 config options), captured by handshaking the
// real binaries.
//
// For codex that binary is the one in kbbl/node_modules/.bin at the version
// kbbl/package.json pins. For claude-code it is not: claude-agent-acp runs
// whatever `CLAUDE_CODE_EXECUTABLE` names, which the claude-code profile
// sets to the operator's installed CLI, so `cli_version` is as much part of
// the capture as `version` (see default-profiles.ts for why).
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
// each point in time while both drifted together across ~40 minutes.
// `opus[1m]` and `opus` were each sometimes the only opus advertised, which
// is why the resolver treats a context hint as droppable rather than
// defining — keep that tolerance even while only one variant is recorded.
//
// Two tests hang off this file, and together they chain the picker to the
// installed binary:
//   - runtime-vocabulary.test.ts (default CI) checks RUNTIME_MODELS and
//     RUNTIME_EFFORTS resolve against every variant here.
//   - real-agent.smoke.test.ts (opt-in, needs the real agents and real auth)
//     checks that what the binary advertises right now is one of them.
//
// Bumping an `@agentclientprotocol/*` pin — or the installed CLI, for
// claude-code — means running the smoke test and updating this file and
// core/runtime.ts together. The ids do drift on their own too:
// claude-agent-acp 0.70.0's `claude-fable-5[1m]` became 0.76.0's
// `claude-fable-5-1[1m]`, which would silently break every Fable launch.
//
// A smoke run reporting a list that matches no variant is new drift: add it
// here rather than replacing what is recorded. Replace only when the old
// variants came from a process kbbl has stopped launching at all — the one
// time that has happened is noted on claude-code's variants below.

import type { RuntimeId } from "../../runtime";

export interface AdvertisedAgentVocabulary {
  /** The npm package whose pinned version this was captured from. */
  readonly package: string;
  readonly version: string;
  /**
   * For claude-code, the `claude` CLI the ACP agent was driving when this was
   * captured. The ACP package version alone does not fix the vocabulary: the
   * agent runs whatever `CLAUDE_CODE_EXECUTABLE` names, and that binary's own
   * catalog decides the model ids (see default-profiles.ts).
   */
  readonly cli_version?: string;
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
    cli_version: "2.1.318",
    model_option_id: "model",
    effort_option_id: "effort",
    // Probed 2026-11-04 against the installed CLI (2.1.318), which is what
    // the claude-code profile now drives via CLAUDE_CODE_EXECUTABLE. The
    // four variants recorded here before that change came from the binary
    // bundled in claude-agent-acp's own pinned SDK (0.3.257) and were
    // *replaced*, not appended: they describe a process kbbl no longer
    // launches, and keeping them would have required every picker entry to
    // satisfy two disjoint vocabularies at once (the bundled binary offers
    // `claude-fable-5-1` and no `fable`; this one the reverse). The
    // add-don't-replace rule above is about entitlement drift within one
    // binary — changing which binary runs is a different thing.
    model_value_variants: [
      [
        "default",
        "opus",
        "fable",
        "sonnet",
        "haiku",
        "claude-haiku-4-5-20251001",
        "claude-sonnet-5",
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
    // Codex ids carry no context hint, so these lists drift by entitlement
    // alone: gpt-6.1-sol appeared at the head of the list on 2026-09-29.
    model_value_variants: [
      [
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gpt-6-sol",
        "gpt-6-luna",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
      ],
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
