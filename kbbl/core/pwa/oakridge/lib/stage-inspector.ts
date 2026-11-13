import type { DefinitionSelection } from "../../lib/hash";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { OperatorParsedStage } from "../operator-contracts/core-client/core-types";
import { selectEffectiveWorkers, selectEffectiveReviews } from "./effective-declarations";
import { selectDefinitionOverview } from "./definition-overview";
import { selectDefinitionDependencies, type DependencyReference } from "./definition-dependencies";
import { definitionStageHref } from "./definition-selection";

export interface StageInspectorModel {
  definition: OperatorDefinitionDetail;
  name: string;
  stage: OperatorParsedStage;
  units: ReturnType<typeof selectDefinitionOverview>["units"];
  workers: ReturnType<typeof selectEffectiveWorkers>;
  reviews: ReturnType<typeof selectEffectiveReviews>;
  artifacts: ArtifactRelationship[];
  readers: DependencyReference[];
  outcomes: OutcomeRelationship[];
}
export interface OutcomeRelationship { name: string; expression: string; readers: DependencyReference[] }
export interface ArtifactRelationship { name: string; producers: string[]; consumers: string[] }
export interface StageSectionProps { model: StageInspectorModel }
export function stageElementId(stage: string, kind: string, name: string): string {
  return `stage-${encodeURIComponent(stage)}-${kind}-${encodeURIComponent(name)}`;
}
export function stageElementHref(model: StageInspectorModel, kind: string, name: string): string {
  return `${definitionStageHref(model.definition.definition_id, model.name)}#${stageElementId(model.name, kind, name)}`;
}
export function selectStageInspector(definition: OperatorDefinitionDetail, selection: DefinitionSelection | null): StageInspectorModel | null {
  const overview = selectDefinitionOverview(definition);
  const name = selection?.kind === "stage" ? selection.stage : selection?.kind === "unit"
    ? overview.units.find(unit => unit.path === selection.path)?.stage : overview.stages[0];
  if (!name) return null;
  const stage = definition.effective_workflow.stages[name];
  if (!stage) return null;
  const units = overview.units.filter(unit => unit.stage === name);
  const workers = selectEffectiveWorkers(definition).filter(worker => worker.stage === name);
  const reviews = selectEffectiveReviews(definition).filter(review => review.stage === name);
  const readers = selectDefinitionDependencies(definition.workflow).references.filter(reference => units.some(unit => unit.path === reference.upstream));
  return { definition, name, stage, units, workers, reviews, readers,
    outcomes: Object.entries(stage.outcome).map(([name, expression]) => ({ name, expression, readers: readers.filter(reader => reader.outcome_path.length === 0 || reader.outcome_path[0] === name) })),
    artifacts: Object.keys(stage.artifacts).map(name => ({ name,
      producers: workers.filter(entry => entry.worker.produces.includes(name)).map(entry => entry.key),
      consumers: reviews.filter(entry => entry.review.of === name).map(entry => entry.key) })) };
}
