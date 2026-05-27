import type { EventBus } from "../stream/event-bus";
import type { TaskTrackerEventMap } from "../db/events";
import type { createDispatcher } from "./backends/dispatcher";

type Dispatcher = ReturnType<typeof createDispatcher>;

interface DispatchHookDeps {
  taskTrackerEvents: EventBus<TaskTrackerEventMap>;
  dispatcher: Dispatcher;
}

export function wireDispatchHooks({ taskTrackerEvents, dispatcher }: DispatchHookDeps): () => void {
  const unsubSpecCreated = taskTrackerEvents.subscribe("spec.created", ({ spec_id }) => {
    void (async () => {
      try {
        await dispatcher.dispatch("planner0", spec_id);
      } catch (err) {
        console.error(
          JSON.stringify({ kbbl: "dispatch-hooks", event: "spec.created", error: String(err), spec_id }),
        );
      }
    })();
  });

  const unsubSpecApproved = taskTrackerEvents.subscribe("spec.approved", ({ spec_id }) => {
    void (async () => {
      try {
        await dispatcher.dispatch("planner1", spec_id);
      } catch (err) {
        console.error(
          JSON.stringify({ kbbl: "dispatch-hooks", event: "spec.approved", error: String(err), spec_id }),
        );
      }
    })();
  });

  const unsubPlanApproved = taskTrackerEvents.subscribe("plan.approved", ({ plan_id }) => {
    void (async () => {
      try {
        await dispatcher.dispatch("planner2_batch", plan_id);
      } catch (err) {
        console.error(
          JSON.stringify({ kbbl: "dispatch-hooks", event: "plan.approved", error: String(err), plan_id }),
        );
      }
    })();
  });

  const unsubCohortBuildReady = taskTrackerEvents.subscribe("cohort.build_ready", ({ brief_id, cohort_id }) => {
    void (async () => {
      try {
        await dispatcher.dispatch("build", brief_id);
      } catch (err) {
        console.error(
          JSON.stringify({ kbbl: "dispatch-hooks", event: "cohort.build_ready", error: String(err), cohort_id, brief_id }),
        );
      }
    })();
  });

  const unsubPlanCompleted = taskTrackerEvents.subscribe("plan.completed", ({ plan_id }) => {
    void (async () => {
      try {
        await dispatcher.dispatch("planner3", plan_id);
      } catch (err) {
        console.error(
          JSON.stringify({ kbbl: "dispatch-hooks", event: "plan.completed", error: String(err), plan_id }),
        );
      }
    })();
  });

  return () => {
    unsubSpecCreated();
    unsubSpecApproved();
    unsubPlanApproved();
    unsubCohortBuildReady();
    unsubPlanCompleted();
  };
}
