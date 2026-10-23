import { Button } from "../../../components/atoms/Button";
import { selectAttentionContext } from "../../lib/run-attention";
import type { CohortLifecycle, CohortLifecycleSummary } from "../../types";

const LIFECYCLE_LABELS: Record<CohortLifecycle, string> = {
  building: "Building",
  artifact_review: "Waiting for your review",
  revision_requested: "Changes requested",
  merge_confirmation: "Waiting for merge confirmation",
  assessing: "Checking the result",
  github_review: "Waiting for GitHub review or merge",
  pull_request_mismatch: "Pull request needs attention",
  complete: "Complete",
  failed: "Needs recovery",
};

function lifecycleLabel(cohort: CohortLifecycleSummary): string {
  if (cohort.lifecycle === "complete" && cohort.pull_request_reconciliation?.completed_at) {
    return "Merged · complete";
  }
  return LIFECYCLE_LABELS[cohort.lifecycle];
}

export function ProgressRow({ cohort, onSelectRun }: { cohort: CohortLifecycleSummary; onSelectRun: (id: string) => void }) {
  return (
    <Button variant="progress-row" type="button" onClick={() => onSelectRun(cohort.run_id)} data-testid="or-cohort-lifecycle-card">
      <span className={`or-progress-row__dot or-progress-row__dot--${cohort.lifecycle}`} aria-hidden="true" />
      <span className="or-progress-row__identity"><strong>{cohort.unit_id}</strong><small>{selectAttentionContext(cohort)}</small></span>
      <span className="or-progress-row__state">{lifecycleLabel(cohort)}</span>
      <span className="or-progress-row__open">View</span>
    </Button>
  );
}
