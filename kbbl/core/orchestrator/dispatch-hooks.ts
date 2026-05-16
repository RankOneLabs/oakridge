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
        await dispatcher.dispatch("planner1", spec_id);
      } catch (err) {
        console.error(
          JSON.stringify({ kbbl: "dispatch-hooks", event: "spec.created", error: String(err), spec_id }),
        );
      }
    })();
  });

  const unsubCohortPlanned = taskTrackerEvents.subscribe("cohort.entered_planned", ({ cohort_id }) => {
    void (async () => {
      try {
        await dispatcher.dispatch("planner2", cohort_id);
        // Emit briefing_started AFTER dispatch returns so cohort transitions
        // planned → briefing (handled by bootstrap) only once the session is spawned.
        taskTrackerEvents.emit("cohort.briefing_started", { cohort_id });
      } catch (err) {
        console.error(
          JSON.stringify({ kbbl: "dispatch-hooks", event: "cohort.entered_planned", error: String(err), cohort_id }),
        );
      }
    })();
  });

  const unsubBriefApproved = taskTrackerEvents.subscribe("brief.approved", ({ brief_id }) => {
    void (async () => {
      try {
        await dispatcher.dispatch("build", brief_id);
      } catch (err) {
        console.error(
          JSON.stringify({ kbbl: "dispatch-hooks", event: "brief.approved", error: String(err), brief_id }),
        );
      }
    })();
  });

  return () => {
    unsubSpecCreated();
    unsubCohortPlanned();
    unsubBriefApproved();
  };
}
