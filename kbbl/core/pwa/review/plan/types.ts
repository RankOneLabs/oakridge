// Display states retained by the shared DAG viewer and historical plan artifacts.
type CohortStatus = "waiting" | "planned" | "briefing" | "brief_review" | "building" | "ready_to_build" | "awaiting_merge" | "done" | "blocked";

export interface Cohort {
  id: string;
  plan_id: string;
  title: string;
  notes: string | null;
  position: number;
  status: CohortStatus;
  created_at: string;
}

export interface CohortDependency {
  id: string;
  from_cohort_id: string;
  to_cohort_id: string;
}
