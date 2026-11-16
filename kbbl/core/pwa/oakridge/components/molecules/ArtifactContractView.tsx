import type { PublishedGradingContext } from "../../lib/grading-applicability";
import type { ArtifactContract } from "../../artifact-types";
import { resolveContractRenderer } from "../../artifactRegistry";
import { selectConsumerTarget } from "../../lib/artifact-contracts";
import { stageElementHref, type StageSectionProps } from "../../lib/stage-inspector";
import { ArtifactGrading } from "./ArtifactGrading";
interface ArtifactContractViewProps extends StageSectionProps { contract: ArtifactContract; grading?: PublishedGradingContext }
export function ArtifactContractView({ model, contract, grading }: ArtifactContractViewProps) {
  const Renderer = resolveContractRenderer(contract.kind);
  return <>
    <p>Definition contract</p>
    <dl><dt>Kind</dt><dd>{contract.kind}</dd><dt>Schema</dt><dd><Renderer schema={contract.schema} schemas={model.definition.effective_workflow.schemas} definition_id={model.definition.definition_id} /></dd>
    <dt>Required fields</dt><dd>{contract.required_fields?.join(", ")}</dd></dl>
    <ul>{contract.validate?.map((rule, index) => <li key={index}><code>{rule.check}</code> — {rule.message}</li>)}</ul>
    <p>Produced by: {contract.producers.map(name => <a key={name} className="mr-2" href={stageElementHref(model, {kind: "worker", name})}>{name}</a>)}</p>
    <p>Consumed by: {contract.consumers.map((consumer, index) => <a key={index} className="mr-2" href={stageElementHref(model, selectConsumerTarget(consumer))}>{consumer.kind}: {"review" in consumer ? consumer.review : "worker" in consumer ? consumer.worker : consumer.name}{"input" in consumer ? "." + consumer.input : ""}</a>)}</p>
    <p>Producer prompts {contract.producer_prompts.map(row => <a key={row.id} className="mr-2" href={stageElementHref(model, {kind: "prompt", name: row.id})}>{row.id}</a>)}</p>
    <ArtifactGrading model={model} contract={contract} grading={grading} />
  </>;
}
