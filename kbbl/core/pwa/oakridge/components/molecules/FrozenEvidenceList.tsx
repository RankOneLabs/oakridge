import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import type { ObservationPageRequest } from "../../grading-contracts/grading/composite";
import { type EvidenceContent, selectEvidenceSummary } from "../../lib/evidence-content";
import type { ObservationEvidenceRead } from "../../grading-contracts/grading/item-reads";
import { selectGradingEvidence } from "../../lib/grading-detail";
import { artifactLabelClass } from "./ArtifactSection";
import { EvidenceContentView } from "./EvidenceContentView";
import { ListPager } from "./ListPager";

interface FrozenReferenceContentProps { content: EvidenceContent }
interface FrozenEvidenceListProps {
  evidence: ObservationEvidenceRead;
  onWindow: (window: ObservationPageRequest) => void;
}

function FrozenReferenceContent({ content }: FrozenReferenceContentProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const summary = selectEvidenceSummary(content);
  if (summary === null) return <EvidenceContentView content={content} />;
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 line-clamp-1 text-xs text-[var(--text-secondary)]">{summary}</p>
      <Button variant="link" size="xsmall" className="self-start text-xs!" aria-expanded={isExpanded} onClick={() => setIsExpanded(!isExpanded)}>
        {isExpanded ? "Hide fields" : "Show fields"}
      </Button>
      {isExpanded && <EvidenceContentView content={content} />}
    </div>
  );
}

/** The exact frozen references every answer to this question shares. */
export function FrozenEvidenceList({ evidence, onWindow }: FrozenEvidenceListProps) {
  if (evidence.readiness.state === "not_ready") {
    return <p className="text-sm text-[var(--text-muted)]" data-testid="or-item-evidence-not-ready">Evidence is not ready: {evidence.readiness.reason.detail} ({evidence.readiness.reason.code})</p>;
  }
  return (
    <section className="flex flex-col gap-2" data-testid="or-item-evidence">
      <div className={artifactLabelClass}>Frozen evidence ({evidence.references.total})</div>
      {evidence.is_incomplete && <p className="text-xs text-[var(--text-muted)]">Incomplete: {evidence.incompleteness_reason}</p>}
      {evidence.references.total === 0 && <p className="text-sm text-[var(--text-muted)]">No evidence was cited.</p>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {evidence.references.items.map((reference) => {
          const detail = selectGradingEvidence(reference);
          const display = detail.display;
          return (
            <li key={reference.ref} className="flex flex-col gap-1 rounded-md border border-[var(--border-decorative)] px-2 py-1.5" data-testid="or-item-evidence-reference" data-source={reference.source} data-provenance={detail.provenance}>
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={display.is_agent_reported ? "warning" : "muted"}>{display.source_label}</Chip>
                <Chip tone={display.is_agent_reported ? "warning" : "muted"}>{detail.provenance_label}</Chip>
                <code className="or-code">{reference.ref}</code>
                <span className="break-all font-mono text-xs text-[var(--text-muted)]">{display.location}</span>
                {display.is_absent && <Chip tone="neutral">Absent at this commit</Chip>}
              </div>
              {!display.is_absent && reference.content !== null && <div aria-label={`Evidence content: ${reference.ref}`}><FrozenReferenceContent key={`${reference.ref}:${display.location}`} content={detail.inspection.content} /></div>}
              {reference.content === null && <p className="m-0 text-xs">Evidence content was not captured.</p>}
            </li>
          );
        })}
      </ul>
      <ListPager name="references" page={evidence.references} onWindow={onWindow} />
    </section>
  );
}
