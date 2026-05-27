import { EventBus } from "../stream/event-bus";

export interface TaskTrackerEventMap {
  "spec.created": { spec_id: string };
  "spec.analysis_complete": { spec_id: string };
  "spec.approved": { spec_id: string; epic_id: string };
  "plan.approved": { plan_id: string; spec_id: string };
  "plan.rejected": { plan_id: string; spec_id: string };
  "plan.completed": { plan_id: string };
  "cohort.entered_planned": { cohort_id: string };
  "cohort.briefing_started": { cohort_id: string };
  "cohort.build_ready": { cohort_id: string; brief_id: string };
  "cohort.pr_opened": { cohort_id: string; pr_url: string };
  "cohort.pr_merged": { cohort_id: string };
  "cohort.done": { cohort_id: string };
  "brief.submitted": { brief_id: string; cohort_id: string };
  "brief.approved": { brief_id: string; cohort_id: string };
  "brief.rejected": { brief_id: string; cohort_id: string };
}

export const taskTrackerEvents = new EventBus<TaskTrackerEventMap>();
