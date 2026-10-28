import { Chip } from "../../../components/atoms/Chip";
import { selectCheckCriterionText, selectCheckNote, selectCheckStatus, type CriterionCheck } from "../../lib/assessment";
import { selectStatusTone } from "../../lib/status-tone";
import type { CriterionStatus } from "../../types";
import { artifactLabelClass } from "./ArtifactSection";
import { ExpandableText } from "./ExpandableText";

export const CRITERION_STATUS_LABEL: Record<CriterionStatus, string> = { met: "met", partial: "partial", not_met: "not met" };
const MATCH_LABEL = { id: "Matched by criterion ID", normalized_text: "Matched by normalized text", unmatched: "No brief criterion match" } as const;

/** One acceptance criterion with the assessor's status and evidence, numbered as the brief numbers it. */
export function CriterionCheckItem({ check, showBriefComparison = true }: { check: CriterionCheck; showBriefComparison?: boolean }) {
  const status = selectCheckStatus(check);
  const note = selectCheckNote(check);
  return (
    <li className="flex flex-col gap-1.5 py-2.5" data-testid="or-criterion-check" data-status={status ?? "unassessed"} data-match={check.match}>
      <div className="flex items-start gap-2">
        <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-xs text-[var(--text-muted)]">{check.kind === "brief" ? `${check.number}.` : "–"}</span>
        <Chip tone={status ? selectStatusTone(status) : "muted"} className="shrink-0">{status ? CRITERION_STATUS_LABEL[status] : "not assessed"}</Chip>
        <p className="text-sm font-medium text-[var(--text-primary)]">{selectCheckCriterionText(check)}</p>
      </div>
      <div className="flex flex-col gap-1 pl-8">
        {(check.match !== "unmatched" || (showBriefComparison && check.kind === "assessment_only")) && (
          <span className="text-xs text-[var(--text-muted)]">{MATCH_LABEL[check.match]}</span>
        )}
        {showBriefComparison && check.kind === "assessment_only" && <span className="text-xs text-[var(--text-muted)]">Not one of the brief's criteria.</span>}
        {check.kind === "assessment_only" && check.finding.criterion_id && <span className="text-xs text-[var(--text-muted)]">Unresolved criterion ID: <code>{check.finding.criterion_id}</code></span>}
        {check.finding?.evidence.kind === "legacy" && check.finding.evidence.text && (
          <>
            <div className={artifactLabelClass}>Evidence</div>
            <ExpandableText text={check.finding.evidence.text} className="text-sm text-[var(--text-secondary)]" />
          </>
        )}
        {check.finding?.evidence.kind === "current" && (
          <>
            <div className={artifactLabelClass}>Evidence</div>
            {check.finding.evidence.refs.length === 0 ? (
              <span className="text-sm text-[var(--text-muted)]">{status === "met" ? "Met with no evidence cited." : "No evidence cited."}</span>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {check.finding.evidence.refs.map((ref, index) => (
                  <li key={`${index}-${ref.kind}-${ref.ref}`} className="text-sm text-[var(--text-secondary)]">
                    <Chip tone="muted">{ref.kind}</Chip> <code className="or-code">{ref.ref}</code>
                    {ref.detail && <span className="ml-2">{ref.detail}</span>}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {note && <ExpandableText text={note} className="text-sm text-[var(--text-secondary)]" />}
      </div>
    </li>
  );
}
