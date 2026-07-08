import type { Database } from "bun:sqlite";
import type { EventBus } from "../stream/event-bus";
import type { TaskTrackerEventMap } from "../db/events";
import type { createDispatcher } from "./backends/dispatcher";
import { DispatchConflictError } from "./backends/dispatcher";
import { advanceEpicByEvent } from "../db/epics";

type Dispatcher = ReturnType<typeof createDispatcher>;

interface DispatchHookDeps {
  taskTrackerEvents: EventBus<TaskTrackerEventMap>;
  dispatcher: Dispatcher;
  db: Database;
}

export function wireDispatchHooks({ taskTrackerEvents, dispatcher, db }: DispatchHookDeps): () => void {
  function hookDispatch(event: string, stageName: string, inputId: string, extra?: Record<string, string>) {
    void (async () => {
      try {
        await dispatcher.dispatch(stageName, inputId);
      } catch (err) {
        if (err instanceof DispatchConflictError) {
          console.log(
            JSON.stringify({
              kbbl: "dispatch-hooks",
              event,
              info: "dispatch already active — race resolved, no duplicate spawned",
              active_attempt_id: err.activeAttempt.id,
              status: err.activeAttempt.status,
              ...extra,
            }),
          );
          return;
        }
        console.error(
          JSON.stringify({ kbbl: "dispatch-hooks", event, error: String(err), ...extra }),
        );
      }
    })();
  }

  const unsubSpecCreated = taskTrackerEvents.subscribe("spec.created", ({ spec_id }) => {
    hookDispatch("spec.created", "spec_analyzer", spec_id, { spec_id });
  });

  const unsubSpecApproved = taskTrackerEvents.subscribe("spec.approved", ({ spec_id, epic_id }) => {
    // Advance Epic stage: spec → plan (implicitly activates if still pending)
    try {
      advanceEpicByEvent(db, epic_id, "epic_spec_approved");
    } catch (err) {
      console.error(
        JSON.stringify({ kbbl: "dispatch-hooks", event: "spec.approved", error: String(err), spec_id, epic_id }),
      );
    }

    hookDispatch("spec.approved", "plan_writer", spec_id, { spec_id });
  });

  const unsubPlanApproved = taskTrackerEvents.subscribe("plan.approved", ({ plan_id }) => {
    hookDispatch("plan.approved", "brief_writer", plan_id, { plan_id });
  });

  const unsubCohortBuildReady = taskTrackerEvents.subscribe("cohort.build_ready", ({ brief_id, cohort_id }) => {
    hookDispatch("cohort.build_ready", "build", brief_id, { cohort_id, brief_id });
  });

  const unsubPlanCompleted = taskTrackerEvents.subscribe("plan.completed", ({ plan_id }) => {
    hookDispatch("plan.completed", "assessor", plan_id, { plan_id });
  });

  return () => {
    unsubSpecCreated();
    unsubSpecApproved();
    unsubPlanApproved();
    unsubCohortBuildReady();
    unsubPlanCompleted();
  };
}
