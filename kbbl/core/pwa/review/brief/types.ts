export interface Brief {
  id: string;
  cohort_id: string;
  status: "pending_approval" | "approved" | "rejected" | "superseded";
  predecessor_brief_id: string | null;
  model: string | null;
  goal: string;
  files_in_scope: string[];
  decisions_made: { decision: string; rationale: string }[];
  approaches_rejected: { approach: string; reason: string }[];
  next_action: string;
  pr_url: string | null;
  debrief: string | null;
  rejection_reason: string | null;
  created_at: string;
}
