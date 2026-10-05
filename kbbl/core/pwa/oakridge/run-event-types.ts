/** Mirrors GET /run_events. Business identifiers are values from the event stream. */
import type { WorkflowChange } from "./review-command-types";
export type RunEventEffect =
  | { readonly kind: "none" | "deliver_message" | "resume_wait" }
  | { readonly kind: "start_stage"; readonly stage_instance_id: string }
  | { readonly kind: "worker_decision"; readonly cohort_id: string; readonly from_state: string; readonly to_state: string;
      readonly changes: readonly WorkflowChange[]; readonly actions: readonly { readonly worker: string; readonly action_point: string }[] }
  | { readonly kind: "cohort_transition"; readonly cohort_id: string; readonly unit_label: string; readonly event_kind: string;
      readonly from_state: string; readonly to_state: string; readonly next_actor: string | null; readonly refusal: null }
  | { readonly kind: "pull_request_observed" | "pull_request_merge_confirmed"; readonly repository_key: string;
      readonly pull_request_url: string; readonly state: string; readonly source: string; readonly merged_at: string | null }
  | { readonly kind: "unrecognized"; readonly effect_kind: string };
export interface RunEvent {
  readonly sequence: string; readonly transition_id: string; readonly run_id: string;
  readonly owner: { readonly kind: "run" | "stage_instance" | "cohort"; readonly id: string };
  readonly launch_reason: "initial" | "dependency_satisfied" | "artifact_accepted" | "gate_decided" | "operator" | "retry" | "recovery";
  readonly prior_owner_version: number; readonly resulting_owner_version: number; readonly operation?: string;
  readonly effect: RunEventEffect; readonly effect_workflow_id: string | null; readonly actor: string; readonly occurred_at: string;
}
