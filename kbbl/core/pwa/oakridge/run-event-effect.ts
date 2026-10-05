import type { RunEventEffect } from "./types";
import { nullableString, object, string } from "./wire-values";

export const parseEffect = (value: unknown): RunEventEffect => {
  const effect = object(value, "effect");
  const kind = string(effect.kind, "effect.kind");
  switch (kind) {
    case "none":
    case "deliver_message":
    case "resume_wait":
      return { kind };
    case "start_stage":
      return { kind, stage_instance_id: string(effect.stage_instance_id, "effect.stage_instance_id") };
    case "worker_decision": {
      if (!Array.isArray(effect.changes) || !Array.isArray(effect.actions)) throw new Error("parse run event: invalid worker decision");
      const actions = effect.actions.map((value) => {
        const action = object(value, "effect.actions[]");
        const worker = string(action.worker, "action.worker");
        if (!["provision", "spec", "plan", "brief", "build", "assessment", "final_integration"].includes(worker)) throw new Error("parse run event: invalid worker");
        return { worker: worker as import("./operator-worker-types").WorkerKey,
          action_point: string(action.action_point, "action.action_point") };
      });
      return { kind, cohort_id: string(effect.cohort_id, "effect.cohort_id"), from_state: string(effect.from_state, "effect.from_state"),
        to_state: string(effect.to_state, "effect.to_state"), changes: effect.changes as import("./review-command-types").WorkflowChange[], actions };
    }
    case "cohort_transition":
      if (!nullableString(effect.next_actor)) throw new Error("parse run event: invalid effect.next_actor");
      if (effect.refusal !== null) throw new Error("parse run event: invalid effect.refusal");
      return { kind, cohort_id: string(effect.cohort_id, "effect.cohort_id"),
        unit_label: string(effect.unit_label, "effect.unit_label"),
        event_kind: string(effect.event_kind, "effect.event_kind"),
        from_state: string(effect.from_state, "effect.from_state"),
        to_state: string(effect.to_state, "effect.to_state"),
        next_actor: effect.next_actor, refusal: null };
    case "pull_request_observed":
    case "pull_request_merge_confirmed":
      if (!nullableString(effect.merged_at)) throw new Error("parse run event: invalid effect.merged_at");
      return { kind, repository_key: string(effect.repository_key, "effect.repository_key"),
        pull_request_url: string(effect.pull_request_url, "effect.pull_request_url"),
        state: string(effect.state, "effect.state"), source: string(effect.source, "effect.source"),
        merged_at: effect.merged_at };
    case "unrecognized": return { kind, effect_kind: string(effect.effect_kind, "effect.effect_kind") };
    default:
      return { kind: "unrecognized", effect_kind: kind };
  }
};
