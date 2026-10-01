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
  if (effect.kind === "cohort_transition" && effect.next_actor === "operator") {
    kind = "info";
    message = `${effect.unit_label} needs operator action (${effect.to_state})`;
  } else if (effect.kind === "pull_request_merge_confirmed") {
    kind = "success"; message = "Pull request merge confirmed";
  } else if (effect.kind === "start_attempt" && event.launch_reason === "retry") {
    kind = "info"; message = "Retry launched";
  } else return null;
  return { kind, message, href: `#oakridge/run/${encodeURIComponent(event.run_id)}` };
};

export const selectRunFrameNotification = (frame: RunEventFrame): RunNotification | null =>
  frame.replayed ? null : selectRunNotification(frame);
