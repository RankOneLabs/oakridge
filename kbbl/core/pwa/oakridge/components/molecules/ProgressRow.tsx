import { Button } from "../../../components/atoms/Button";
import type { CohortLifecycle, CohortLifecycleSummary } from "../../types";

const LIFECYCLE_LABELS: Record<CohortLifecycle, string> = {
  pending: "Queued",
  active: "Active",
  blocked: "Blocked",
  complete: "Complete",
  failed: "Needs recovery",
  cancelled: "Cancelled",
};

function lifecycleLabel(cohort: CohortLifecycleSummary): string {
  if (cohort.lifecycle === "complete" && (cohort.facts?.some((fact) => fact.key === "merged_at")
    || cohort.pull_request_reconciliation?.completed_at)) {
    return "Merged · complete";
  }
  if (cohort.lifecycle === "blocked" && cohort.blocked_reason && cohort.next_actor) {
    return `Blocked: ${cohort.blocked_reason} · next: ${cohort.next_actor}`;
  }
  return LIFECYCLE_LABELS[cohort.lifecycle];
}

export function ProgressRow({ cohort, onSelectRun }: { cohort: CohortLifecycleSummary; onSelectRun: (id: string) => void }) {
  return (
    <Button variant="progress-row" type="button" onClick={() => onSelectRun(cohort.run_id)} data-testid="or-cohort-lifecycle-card">
      <span className={`or-progress-row__dot or-progress-row__dot--${cohort.lifecycle}`} aria-hidden="true" />
      <span className="or-progress-row__identity"><strong>{cohort.title || cohort.unit_id}</strong><small>{cohort.repository_key || cohort.workflow_name}</small></span>
      <span className="or-progress-row__state">{lifecycleLabel(cohort)}</span>
      <span className="or-progress-row__open">View</span>
    </Button>
  );
}
