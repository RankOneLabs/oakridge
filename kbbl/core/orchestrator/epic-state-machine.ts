import type { EpicStatus, EpicStage } from "../types/task-tracker";

export type EpicState = { status: EpicStatus; current_stage: EpicStage };

// Stage events — update only current_stage
export type EpicStageEvent =
  | "epic_spec_approved"
  | "epic_plan_approved"
  | "epic_build_done"
  | "epic_assess_done";

// Lifecycle events — update only status
export type EpicLifecycleEvent = "start" | "archive" | "unarchive" | "complete";

export type EpicEvent = EpicStageEvent | EpicLifecycleEvent;

const STAGE_EVENT_NAMES = new Set<string>([
  "epic_spec_approved",
  "epic_plan_approved",
  "epic_build_done",
  "epic_assess_done",
]);

export const EPIC_STAGE_TRANSITIONS: Record<EpicStage, Partial<Record<EpicStageEvent, EpicStage>>> = {
  spec:   { epic_spec_approved: "plan" },
  plan:   { epic_plan_approved: "build" },
  build:  { epic_build_done: "assess" },
  assess: { epic_assess_done: "assess" }, // terminal — stage does not advance
};

export const EPIC_LIFECYCLE_TRANSITIONS: Record<EpicStatus, Partial<Record<EpicLifecycleEvent, EpicStatus>>> = {
  pending:  { start: "active",    archive: "archived" },
  active:   { archive: "archived", complete: "complete" },
  complete: { archive: "archived" },
  archived: { unarchive: "pending" },
};

export class InvalidTransitionError extends Error {
  constructor(state: EpicState, event: EpicEvent) {
    super(`no Epic transition from (status=${state.status}, stage=${state.current_stage}) via '${event}'`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Pure function: compute next EpicState from current state + event.
 * Stage events update only current_stage; lifecycle events update only status.
 * Throws InvalidTransitionError when the (state, event) pair is unmapped.
 */
export function applyEpicTransition(current: EpicState, event: EpicEvent): EpicState {
  if (STAGE_EVENT_NAMES.has(event)) {
    const stageEvent = event as EpicStageEvent;
    const nextStage = EPIC_STAGE_TRANSITIONS[current.current_stage]?.[stageEvent];
    if (nextStage === undefined) {
      throw new InvalidTransitionError(current, event);
    }
    return { status: current.status, current_stage: nextStage };
  }

  const lifecycleEvent = event as EpicLifecycleEvent;
  const nextStatus = EPIC_LIFECYCLE_TRANSITIONS[current.status]?.[lifecycleEvent];
  if (nextStatus === undefined) {
    throw new InvalidTransitionError(current, event);
  }
  return { status: nextStatus, current_stage: current.current_stage };
}
