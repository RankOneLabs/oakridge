import type { Database } from "bun:sqlite";
import type { ReviewRegistry } from "../review/registry";
import type { EventBus } from "../stream/event-bus";
import type { ReviewEventMap } from "../review/events";
import type { TaskTrackerEventMap } from "../db/events";
import { getPlan } from "../db/plans";
import { getBrief } from "../db/briefs";

interface BootstrapDeps {
  db: Database;
  registry: ReviewRegistry;
  reviewEvents: EventBus<ReviewEventMap>;
  taskTrackerEvents: EventBus<TaskTrackerEventMap>;
}

const PLAN_ANCHOR_RE = /^(cohorts\[\d+\]\.(title|notes)|edge:[^->]+->[^->]+)$/;
const BRIEF_ANCHOR_RE =
  /^(goal|next_action|decisions_made\[\d+\]\.rationale|approaches_rejected\[\d+\]\.reason|files_in_scope\[\d+\])$/;

export function bootstrap({ db, registry, reviewEvents, taskTrackerEvents }: BootstrapDeps): () => void {
  registry.register("plan", {
    validateAnchor: (anchor) =>
      anchor === null || PLAN_ANCHOR_RE.test(anchor) || `invalid plan anchor: ${anchor}`,
    exists: (plan_id) => getPlan(db, plan_id) !== null,
  });

  registry.register("build_brief", {
    validateAnchor: (anchor) =>
      anchor === null || BRIEF_ANCHOR_RE.test(anchor) || `invalid build_brief anchor: ${anchor}`,
    exists: (brief_id) => getBrief(db, brief_id) !== null,
  });

  const unsubReopened = reviewEvents.subscribe("artifact.reopened", ({ target_type, target_id }) => {
    if (target_type === "plan") {
      const plan = getPlan(db, target_id);
      if (!plan) return;
      const newerPending = db
        .prepare<{ id: string }, [string]>(
          "SELECT id FROM plans WHERE spec_id = ? AND status = 'pending_approval' ORDER BY created_at DESC LIMIT 1",
        )
        .get(plan.spec_id);
      if (!newerPending) {
        console.warn(
          JSON.stringify({ kbbl: "orchestrator", event: "artifact.reopened", warn: "no pending plan to re-review", plan_id: target_id }),
        );
        return;
      }
      db.prepare("UPDATE specs SET status = 'plan_review' WHERE id = ? AND status = 'planning_done'").run(plan.spec_id);
    } else if (target_type === "build_brief") {
      const brief = getBrief(db, target_id);
      if (!brief) return;
      db.prepare(
        "UPDATE cohorts SET status = 'briefing' WHERE id = ? AND status = 'brief_review'",
      ).run(brief.cohort_id);
    }
  });

  const unsubBriefSubmitted = taskTrackerEvents.subscribe("brief.submitted", ({ cohort_id }) => {
    db.prepare(
      "UPDATE cohorts SET status = 'brief_review' WHERE id = ? AND status = 'briefing'",
    ).run(cohort_id);
  });

  return () => {
    unsubReopened();
    unsubBriefSubmitted();
  };
}
