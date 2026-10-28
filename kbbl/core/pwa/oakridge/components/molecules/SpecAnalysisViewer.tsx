import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import type { ViewerProps } from "../../artifactRegistry";
import { isSpecAnalysis, selectSpecAnalysisView, selectUpdateFindings, type SpecAnalysis, type SpecBlocker, type SpecAnalysisTally, type SpecUpdate } from "../../lib/spec-analysis";
import { selectStatusTone, type StatusToneSource } from "../../lib/status-tone";
import { ArtifactSection } from "./ArtifactSection";
import { ExpandableText } from "./ExpandableText";
import { RiskCard } from "./RiskCard";

function ItemRow({ status, id, description }: { status: StatusToneSource; id: string; description: string }) {
  return (
    <li className="flex items-start gap-2 py-2">
      <Chip tone={selectStatusTone(status)} className="shrink-0">{status}</Chip>
      <code className="or-code shrink-0">{id}</code>
      <ExpandableText text={description} className="text-sm text-[var(--text-secondary)]" />
    </li>
  );
}

function SourceRefs({ refs }: { refs: string[] }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1.5" data-testid="or-spec-sources">
      <Button variant="secondary" size="xsmall" className="self-start text-xs!" aria-expanded={isOpen} onClick={() => setIsOpen(!isOpen)}>
        {isOpen ? "▾" : "▸"} {refs.length} {refs.length === 1 ? "source" : "sources"}
      </Button>
      {isOpen && (
        <div className="flex flex-wrap gap-1.5">
          {refs.map((ref, index) => <Chip key={`${index}-${ref}`} tone="neutral">{ref}</Chip>)}
        </div>
      )}
    </div>
  );
}

function TallyRow({ tally }: { tally: SpecAnalysisTally }) {
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="or-spec-tally">
      {tally.status_counts.map(({ status, count }) => (
        <Chip key={status} tone={selectStatusTone(status)}>{count} {status}</Chip>
      ))}
      <Chip tone={tally.risk_count > 0 ? "warning" : "muted"}>{tally.risk_count} {tally.risk_count === 1 ? "risk" : "risks"}</Chip>
    </div>
  );
}

function BlockerCallout({ blockers }: { blockers: SpecBlocker[] }) {
  if (blockers.length === 0) {
    return <p className="text-sm text-[var(--success-fg)]" data-testid="or-spec-no-blockers">No blocking findings or blocked requirements.</p>;
  }
  return (
    <section className="rounded-md border border-[var(--danger-card-border)] bg-[var(--danger-card-bg)] px-3 py-2" data-testid="or-spec-blockers" role="alert">
      <h3 className="text-sm font-semibold text-[var(--danger-fg)]">Blockers ({blockers.length})</h3>
      <ul className="divide-y divide-[var(--danger-card-border)]">
        {blockers.map((blocker, index) => blocker.kind === "finding"
          ? <ItemRow key={`${index}-${blocker.finding.id}`} status={blocker.finding.severity} id={blocker.finding.id} description={blocker.finding.description} />
          : <ItemRow key={`${index}-${blocker.requirement.id}`} status={blocker.requirement.status} id={blocker.requirement.id} description={blocker.requirement.description} />)}
      </ul>
    </section>
  );
}

function UpdateFindingLinks({ update, analysis }: { update: SpecUpdate; analysis: SpecAnalysis }) {
  const references = selectUpdateFindings(update, analysis);
  return <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]" data-testid="or-spec-update-findings">
    <span>Findings</span>
    {references.length === 0 && <Chip tone="muted">Unlinked</Chip>}
    {references.map(({ id, finding }, index) => finding
      ? <span key={`${index}-${id}`} className="inline-flex items-center gap-1">
        <code className="or-code">{id}</code><Chip tone={selectStatusTone(finding.severity)}>{finding.severity}</Chip>
        <span className="text-[var(--text-secondary)]">{finding.description}</span>
      </span>
      : <code key={`${index}-${id}`} className="or-code">{id}</code>)}
  </div>;
}

export function SpecAnalysisViewer({ body }: ViewerProps) {
  if (!isSpecAnalysis(body)) {
    return <div className="or-error" role="alert">This spec analysis does not match the registered contract.</div>;
  }
  const view = selectSpecAnalysisView(body);

  return (
    <article className="flex flex-col gap-5" data-testid="or-spec-analysis-viewer">
      <header className="flex flex-col gap-3">
        <p className="text-sm leading-relaxed text-[var(--text-primary)]">{body.summary}</p>
        {body.source_spec_refs.length > 0 && <SourceRefs refs={body.source_spec_refs} />}
        <TallyRow tally={view.tally} />
      </header>

      <BlockerCallout blockers={view.blockers} />

      <ArtifactSection title={`Proposed spec updates (${view.proposed_spec_updates.length})`} testId="or-spec-updates">
        {view.proposed_spec_updates.length > 0
          ? <ol className="divide-y divide-[var(--border-subtle)]">
            {view.proposed_spec_updates.map((update, index) => <li key={`${index}-${update.section}`} className="py-2">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">{update.section}</h3>
              <p className="whitespace-pre-wrap text-sm text-[var(--text-secondary)]">{update.change}</p>
              <p className="text-xs text-[var(--text-muted)]">Why: {update.reason}</p>
              <UpdateFindingLinks update={update} analysis={body} />
            </li>)}
          </ol>
          : <p className="text-sm text-[var(--text-muted)]">No changes to the specification proposed.</p>}
      </ArtifactSection>

      <ArtifactSection title={`Risks (${view.risks.length})`} testId="or-spec-risks">
        {view.risks.length > 0
          ? view.risks.map((risk, index) => <RiskCard key={`${index}-${risk.description}`} description={risk.description} mitigation={risk.mitigation} />)
          : <p className="text-sm text-[var(--text-muted)]">No risks identified.</p>}
      </ArtifactSection>

      {view.findings.length > 0 && (
        <ArtifactSection title={`Findings (${view.findings.length})`} testId="or-spec-findings">
          <ul className="divide-y divide-[var(--border-subtle)]">
            {view.findings.map((finding, index) => <ItemRow key={`${index}-${finding.id}`} status={finding.severity} id={finding.id} description={finding.description} />)}
          </ul>
        </ArtifactSection>
      )}

      {view.requirements.length > 0 && (
        <ArtifactSection title={`Requirements (${view.requirements.length})`} testId="or-spec-requirements">
          <ul className="divide-y divide-[var(--border-subtle)]">
            {view.requirements.map((requirement, index) => <ItemRow key={`${index}-${requirement.id}`} status={requirement.status} id={requirement.id} description={requirement.description} />)}
          </ul>
        </ArtifactSection>
      )}
    </article>
  );
}
