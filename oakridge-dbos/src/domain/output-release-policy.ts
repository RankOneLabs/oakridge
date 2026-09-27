import type { OutputAttention, OutputContinuation, OutputReleaseContract } from "./compiled-workflow";

export interface OutputReleasePolicy {
  readonly attention: OutputAttention;
  readonly continuation: OutputContinuation;
}

export const selectOutputReleasePolicy = (
  release: OutputReleaseContract,
  attention: OutputAttention | null,
): OutputReleasePolicy => ({
  attention: attention ?? (release.kind === "gate"
    ? "required"
    : release.kind === "handoff" && release.external_wait_kind.length > 0
      ? "optional"
      : "none"),
  continuation: release.kind === "immediate" ? "continuing" : "waiting",
});
