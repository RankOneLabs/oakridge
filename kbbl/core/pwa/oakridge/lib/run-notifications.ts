import type { RunEvent, RunEventFrame } from "../types";

export interface RunNotification {
  readonly kind: "success" | "error" | "info";
  readonly message: string;
  readonly href: string;
}

export const selectRunNotification = (event: RunEvent): RunNotification | null => {
  const effect = event.effect;
  let kind: RunNotification["kind"];
  let message: string;
  if (effect.kind === "dev_flow_build_cohort_transition" && effect.disposition === "transitioned") {
    switch (effect.event.kind) {
      case "builder_attempt_lost": kind = "error"; message = "Builder session lost"; break;
      case "operator_retry_requested": kind = "info"; message = "Retry launched"; break;
      case "assessor_attempt_lost": kind = "error"; message = "Assessor session lost"; break;
      case "pull_request_mismatch": kind = "error"; message = "Pull request mismatch"; break;
      case "replacement_pull_request_required": kind = "error"; message = "Replacement pull request required"; break;
      case "pull_request_merged": kind = "success"; message = "Pull request merged"; break;
      default: return null;
    }
  } else if (effect.kind === "pull_request_merge_confirmed") {
    kind = "success"; message = "Pull request merge confirmed";
  } else if (effect.kind === "start_attempt" && event.launch_reason === "retry") {
    kind = "info"; message = "Retry launched";
  } else return null;
  return { kind, message, href: `#oakridge/run/${encodeURIComponent(event.run_id)}` };
};

export const selectRunFrameNotification = (frame: RunEventFrame): RunNotification | null =>
  frame.replayed ? null : selectRunNotification(frame);
