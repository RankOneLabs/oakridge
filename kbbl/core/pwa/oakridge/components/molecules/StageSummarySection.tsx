import { type StageSectionProps } from "../../lib/stage-inspector";
import { LetExpression } from "./LetExpression";
export function StageSummarySection({ model }: StageSectionProps) {
  const summary = model.sections.overview;
  return <section aria-label="Stage summary" className="or-stage-summary rounded border border-[var(--border-muted)] border-t-[3px] border-t-[var(--accent-primary)] p-3">
    <p>{summary.worker_count} workers · {summary.artifact_count} artifacts · {summary.review_count} reviews</p>
    <p>done_when: {summary.done_when ? <LetExpression model={model} expression={summary.done_when} /> : "Not declared"}</p>
  </section>;
}
