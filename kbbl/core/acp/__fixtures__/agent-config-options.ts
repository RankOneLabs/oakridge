// What the pinned ACP agents actually advertise as selectable models and
// reasoning efforts (§12 config options), captured from the binaries in
// kbbl/node_modules/.bin at the versions kbbl/package.json pins.
//
// This exists because `resolveRequestedOption` matches a requested model or
// effort against these ids exactly, and a miss kills the session during
// provisioning with `requested_model_unsupported` — before its first turn,
// with an exit code of 1 and nothing else to go on. A picker entry no agent
// advertises is a launch button that always fails, and kbbl shipped eight of
// them (every Claude Code model, plus Codex's gpt-5.4 and gpt-5.4-mini).
//
// Two tests hang off this file, and together they chain the picker to the
// installed binary:
//   - runtime-vocabulary.test.ts (default CI) checks RUNTIME_MODELS and
//     RUNTIME_EFFORTS against this fixture.
//   - real-agent.smoke.test.ts (opt-in, needs the real agents and real auth)
//     checks this fixture against what the binary advertises right now.
//
// Bumping an `@agentclientprotocol/*` pin means running the smoke test and
// updating this file and core/runtime.ts together. The ids do drift:
// claude-agent-acp 0.70.0's `claude-fable-5[1m]` became 0.76.0's
// `claude-fable-5-1[1m]`, which would silently break every Fable launch.

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
   * Every value id the agent offers, in advertised order — including the
   * agent's own "default" entry, which kbbl deliberately does not list in
   * its pickers (an unset model/effort expresses the same thing).
   */
  readonly model_values: readonly string[];
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
    model_values: [
      "default",
      "opus[1m]",
      "claude-fable-5-1[1m]",
      "sonnet",
      "haiku",
    ],
    effort_values: ["default", "low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    package: "@agentclientprotocol/codex-acp",
    version: "1.11.0",
    model_option_id: "model",
    effort_option_id: "reasoning_effort",
    model_values: [
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.3-codex-spark",
    ],
    effort_values: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
};
