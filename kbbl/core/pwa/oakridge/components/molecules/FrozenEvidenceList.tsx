import { Chip } from "../../../components/atoms/Chip";
import type { ObservationPageRequest } from "../../grading-contracts/grading/composite";
import type { ObservationEvidenceRead } from "../../grading-contracts/grading/item-reads";
import { referenceDisplay } from "../../lib/grading";
import { artifactLabelClass } from "./ArtifactSection";
import { ExpandableText } from "./ExpandableText";
import { ListPager } from "./ListPager";

const contentText = (content: unknown): string => typeof content === "string" ? content : JSON.stringify(content, null, 2);

/** The exact frozen references every answer to this question shares. */
export function FrozenEvidenceList({ evidence, onWindow }: { evidence: ObservationEvidenceRead; onWindow: (window: ObservationPageRequest) => void }) {
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
          const display = referenceDisplay(reference);
          return (
            <li key={reference.ref} className="flex flex-col gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1.5" data-testid="or-item-evidence-reference" data-source={reference.source}>
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={display.is_agent_reported ? "warning" : "muted"}>{display.source_label}</Chip>
                <code className="or-code">{reference.ref}</code>
                <span className="break-all font-mono text-xs text-[var(--text-muted)]">{display.location}</span>
                {display.is_absent && <Chip tone="neutral">Absent at this commit</Chip>}
              </div>
              {!display.is_absent && reference.content !== null && <ExpandableText text={contentText(reference.content)} className="whitespace-pre-wrap text-xs text-[var(--text-secondary)]" />}
            </li>
          );
        })}
      </ul>
      <ListPager name="references" page={evidence.references} onWindow={onWindow} />
    </section>
  );
}
