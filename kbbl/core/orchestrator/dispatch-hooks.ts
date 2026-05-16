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
      // Emit briefing_started before dispatch so the cohort advances to briefing
      // regardless of dispatch outcome. If dispatch fails the operator sees the
      // cohort in briefing and can manually re-trigger; leaving it in planned
      // with no session and no retry path would leave it permanently stuck.
      // Guarded because a subscriber throw would otherwise surface as an
      // unhandled rejection and skip the dispatch call below.
      try {
        taskTrackerEvents.emit("cohort.briefing_started", { cohort_id });
      } catch (err) {
        console.error(
          JSON.stringify({ kbbl: "dispatch-hooks", event: "cohort.briefing_started", error: String(err), cohort_id }),
        );
      }
      try {
        await dispatcher.dispatch("planner2", cohort_id);
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
