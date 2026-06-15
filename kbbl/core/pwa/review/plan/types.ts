export interface Cohort {
  id: string;
  plan_id: string;
  title: string;
  notes: string | null;
  position: number;
  status: string;
  created_at: string;
}

export interface CohortDependency {
  id: string;
  from_cohort_id: string;
  to_cohort_id: string;
}

export interface Plan {
  id: string;
  spec_id: string;
  status: "draft" | "pending_approval" | "approved" | "rejected" | "superseded";
  predecessor_plan_id: string | null;
  model: string | null;
  rejection_reason: string | null;
  created_at: string;
}
