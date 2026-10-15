import { Chip } from "../../../components/atoms/Chip";
import { selectCheckCriterionText, selectCheckNote, selectCheckStatus, type CriterionCheck } from "../../lib/assessment";
import { selectStatusTone } from "../../lib/status-tone";
import type { CriterionStatus } from "../../types";
import { artifactLabelClass } from "./ArtifactSection";
import { ExpandableText } from "./ExpandableText";

export const CRITERION_STATUS_LABEL: Record<CriterionStatus, string> = { met: "met", partial: "partial", not_met: "not met" };

/** One acceptance criterion with the assessor's status and evidence, numbered as the brief numbers it. */
export function CriterionCheckItem({ check }: { check: CriterionCheck }) {
  const status = selectCheckStatus(check);
  const note = selectCheckNote(check);
  return (
    <li className="flex flex-col gap-1.5 py-2.5" data-testid="or-criterion-check" data-status={status ?? "unassessed"}>
      <div className="flex items-start gap-2">
        <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-xs text-[var(--text-muted)]">{check.kind === "brief" ? `${check.number}.` : "–"}</span>
        <Chip tone={status ? selectStatusTone(status) : "muted"} className="shrink-0">{status ? CRITERION_STATUS_LABEL[status] : "not assessed"}</Chip>
        <p className="text-sm font-medium text-[var(--text-primary)]">{selectCheckCriterionText(check)}</p>
      </div>
      <div className="flex flex-col gap-1 pl-8">
        {check.kind === "assessment_only" && <span className="text-xs text-[var(--text-muted)]">Not one of the brief's criteria.</span>}
        {check.finding?.evidence && (
          <>
            <div className={artifactLabelClass}>Evidence</div>
            <ExpandableText text={check.finding.evidence} className="text-sm text-[var(--text-secondary)]" />
          </>
        )}
        {note && <ExpandableText text={note} className="text-sm text-[var(--text-secondary)]" />}
      </div>
    </li>
  );
}
