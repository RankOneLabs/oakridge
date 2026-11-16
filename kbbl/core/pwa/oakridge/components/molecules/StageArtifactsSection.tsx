import type { PublishedGradingContext } from "../../lib/grading-applicability";
import { stageElementId, type StageSectionProps } from "../../lib/stage-inspector";
import { ArtifactContractView } from "./ArtifactContractView";
export function StageArtifactsSection({ model, grading }: StageSectionProps & { grading?: PublishedGradingContext }) {
  return <section aria-label="Artifacts" className="rounded border border-[var(--border-muted)] p-3">
    <h3>Artifacts</h3>
    <p>Contracts declared by this workflow definition — not artifacts produced by a run.</p>
    {model.sections.artifacts.map(contract => <article key={contract.name} className="or-stage-artifact border-t border-[var(--border-muted)] py-2" id={stageElementId({stage: model.name, kind: "artifact", name: contract.name})} tabIndex={-1}>
      <h4 aria-label={contract.validate?.length ? `${contract.name} · Validated artifact` : contract.name}>{contract.name}{Boolean(contract.validate?.length) && <small className="or-stage-validated ml-2 text-xs font-normal">validated</small>}</h4>
      <ArtifactContractView model={model} contract={contract} grading={grading} />
    </article>)}
  </section>;
}
