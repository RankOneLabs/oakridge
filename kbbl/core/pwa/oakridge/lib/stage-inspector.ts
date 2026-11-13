import type { DefinitionSelection } from "../../lib/hash";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type {
  OperatorParsedArtifact,
  OperatorParsedStage,
} from "../operator-contracts/core-client/core-types";
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
  wholeOutcomeReaders: DependencyReference[];
  sources: StageSourceDeclaration[];
}
export interface OutcomeRelationship {
  name: string;
  expression: string;
  readers: DependencyReference[];
}
export interface ArtifactRelationship {
  name: string;
  artifact: OperatorParsedArtifact;
  producers: string[];
  consumers: string[];
}
export interface StageSectionProps {
  model: StageInspectorModel;
}
export interface StageElementReference {
  kind:
    | "let"
    | "artifact"
    | "worker"
    | "worker-input"
    | "review"
    | "outcome"
    | "template-worker"
    | "template-review"
    | "decision-set";
  name: string;
}
export interface StageElementTarget extends StageElementReference {
  stage: string;
}
export interface StageNavigationEntry {
  name: string;
  units: StageInspectorModel["units"];
}
/** Authored source declarations displayed by provenance links. */
export interface StageSourceDeclaration {
  kind: "template-worker" | "template-review" | "decision-set";
  name: string;
  label: string;
  content: string;
}
interface StageSourceInput {
  definition: OperatorDefinitionDetail;
  workers: StageInspectorModel["workers"];
  reviews: StageInspectorModel["reviews"];
}
export function stageElementId({ stage, kind, name }: StageElementTarget): string {
  return `stage-${encodeURIComponent(stage)}-${kind}-${encodeURIComponent(name)}`;
}
export function stageElementHref(
  model: StageInspectorModel,
  target: StageElementReference,
): string {
  return `${definitionStageHref(model.definition.definition_id, model.name)}#${stageElementId({ stage: model.name, ...target })}`;
}
export function selectStageNavigation(
  definition: OperatorDefinitionDetail,
): StageNavigationEntry[] {
  const overview = selectDefinitionOverview(definition);
  return overview.stages.map((name) => ({
    name,
    units: overview.units.filter((unit) => unit.stage === name),
  }));
}
function selectStageSources({
  definition,
  workers,
  reviews,
}: StageSourceInput): StageSourceDeclaration[] {
  const authored = definition.workflow;
  const workerTemplates = [
    ...new Set(workers.flatMap(({ source }) => (source ? [source.template] : []))),
  ];
  const reviewTemplates = [
    ...new Set(reviews.flatMap(({ source }) => (source ? [source.template] : []))),
  ];
  const decisionSets = [
    ...new Set(
      reviews.flatMap(({ decisions }) =>
        decisions.flatMap(({ source }) => (source ? [source.set] : [])),
      ),
    ),
  ];
  return [
    ...workerTemplates.flatMap((name): StageSourceDeclaration[] => {
      const declaration = "workers" in authored ? authored.workers?.[name] : null;
      return declaration
        ? [
            {
              kind: "template-worker",
              name,
              label: `Worker template ${name}`,
              content: JSON.stringify(declaration, null, 2),
            },
          ]
        : [];
    }),
    ...reviewTemplates.flatMap((name): StageSourceDeclaration[] => {
      const declaration = "reviews" in authored ? authored.reviews?.[name] : null;
      return declaration
        ? [
            {
              kind: "template-review",
              name,
              label: `Review template ${name}`,
              content: JSON.stringify(declaration, null, 2),
            },
          ]
        : [];
    }),
    ...decisionSets.flatMap((name): StageSourceDeclaration[] => {
      const declaration = "decisions" in authored ? authored.decisions?.[name] : null;
      return declaration
        ? [
            {
              kind: "decision-set",
              name,
              label: `Decision set ${name}`,
              content: JSON.stringify(declaration, null, 2),
            },
          ]
        : [];
    }),
  ];
}
export function selectStageInspector(
  definition: OperatorDefinitionDetail,
  selection: DefinitionSelection | null,
): StageInspectorModel | null {
  const overview = selectDefinitionOverview(definition);
  const name =
    selection?.kind === "stage"
      ? selection.stage
      : selection?.kind === "unit"
        ? overview.units.find((unit) => unit.path === selection.path)?.stage
        : overview.stages[0];
  if (!name) return null;
  const stage = definition.effective_workflow.stages[name];
  if (!stage) return null;
  const units = overview.units.filter((unit) => unit.stage === name);
  const workers = selectEffectiveWorkers(definition).filter((worker) => worker.stage === name);
  const reviews = selectEffectiveReviews(definition).filter((review) => review.stage === name);
  const readers = selectDefinitionDependencies(definition.workflow).references.filter((reference) =>
    units.some((unit) => unit.path === reference.upstream),
  );
  return {
    definition,
    name,
    stage,
    units,
    workers,
    reviews,
    readers,
    sources: selectStageSources({ definition, workers, reviews }),
    wholeOutcomeReaders: readers.filter((reader) => reader.outcome_path.length === 0),
    outcomes: Object.entries(stage.outcome).map(([name, expression]) => ({
      name,
      expression,
      readers: readers.filter((reader) => reader.outcome_path[0] === name),
    })),
    artifacts: Object.entries(stage.artifacts).map(([name, artifact]) => ({
      name,
      artifact,
      producers: workers
        .filter((entry) => entry.worker.produces.includes(name))
        .map((entry) => entry.key),
      consumers: reviews.filter((entry) => entry.review.of === name).map((entry) => entry.key),
    })),
  };
}
