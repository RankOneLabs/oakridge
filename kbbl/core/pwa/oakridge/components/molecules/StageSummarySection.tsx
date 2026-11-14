import { selectStageSummary, type StageSectionProps } from "../../lib/stage-inspector";
import { definitionUnitHref } from "../../lib/definition-selection";
import { LetExpression } from "./LetExpression";
export function StageSummarySection({ model }: StageSectionProps) {
  const summary = selectStageSummary(model);
  return <section aria-label="Stage summary" className="or-stage-summary rounded border border-[var(--border-muted)] border-t-[3px] border-t-[var(--accent-primary)] p-3">
    <h3>Stage: {summary.name}</h3>
    <p>Invoked by: {summary.invoking_units.map(unit => <a className="mr-2" key={unit.path} href={definitionUnitHref(model.definition.definition_id, unit.path)}>{unit.path}</a>)}</p>
    <p>{summary.worker_count} workers · {summary.artifact_count} artifacts · {summary.review_count} reviews</p>
    <p>done_when: {summary.done_when ? <LetExpression model={model} expression={summary.done_when} /> : "Not declared"}</p>
  </section>;
}
