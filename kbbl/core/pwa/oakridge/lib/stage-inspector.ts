import { selectArtifactContracts } from "./artifact-contracts";
import type { ArtifactContract } from "../artifact-types";
import type { DefinitionSelection } from "../../lib/hash";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type {
  OperatorParsedStage,
} from "../operator-contracts/core-client/core-types";
import {
  selectStageSources,
  selectEffectiveWorkers,
  selectEffectiveReviews,
} from "./effective-declarations";
import { selectDefinitionOverview } from "./definition-overview";
import {
  selectDefinitionDependencies,
  type DependencyReference,
} from "./definition-dependencies";
import { selectReviewCycles, type ReviewCycle } from "./definition-graph";
import {
  definitionStageHref,
  definitionUnitHref,
} from "./definition-selection";

export interface StageInspectorModel {
  sections: StageInspectorSections;
  definition: OperatorDefinitionDetail;
  selected_unit:
    ReturnType<typeof selectDefinitionOverview>["units"][number] | null;
  name: string;
  stage: OperatorParsedStage;
  units: ReturnType<typeof selectDefinitionOverview>["units"];
  workers: ReturnType<typeof selectEffectiveWorkers>;
  reviews: ReturnType<typeof selectEffectiveReviews>;
  artifacts: ArtifactContract[];
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
export interface StageSectionProps {
  model: StageInspectorModel;
}
export interface StageElementReference {
  kind:
    | "prompt"
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
export function stageElementId({
  stage,
  kind,
  name,
}: StageElementTarget): string {
  return `stage-${encodeURIComponent(stage)}-${kind}-${encodeURIComponent(name)}`;
}
export function stageElementHref(
  model: StageInspectorModel,
  target: StageElementReference,
): string {
  return `${stageSelectionHref(model)}#${stageElementId({ stage: model.name, ...target })}`;
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
function selectStageInspectorEntry(
  definition: OperatorDefinitionDetail,
  selection: DefinitionSelection | null,
): StageInspectorModel | null {
  const overview = selectDefinitionOverview(definition);
  const name =
    selection?.kind === "stage"
      ? selection.stage
      : selection?.kind === "unit"
        ? overview.units.find((unit) => unit.path === selection.path)?.stage
        : null;
  if (!name) return null;
  const stage = definition.effective_workflow.stages[name];
  if (!stage) return null;
  const units = overview.units.filter((unit) => unit.stage === name);
  const workers = selectEffectiveWorkers(definition).filter(
    (worker) => worker.stage === name,
  );
  const reviews = selectEffectiveReviews(definition).filter(
    (review) => review.stage === name,
  );
  const readers = selectDefinitionDependencies(
    definition.workflow,
  ).references.filter((reference) =>
    units.some((unit) => unit.path === reference.upstream),
  );
  const model = {
    definition,
    selected_unit:
      selection?.kind === "unit"
        ? (overview.units.find((unit) => unit.path === selection.path) ?? null)
        : null,
    name,
    stage,
    units,
    workers,
    reviews,
    readers,
    sources: selectStageSources({ definition, workers, reviews }),
    wholeOutcomeReaders: readers.filter(
      (reader) => reader.outcome_path.length === 0,
    ),
    outcomes: Object.entries(stage.outcome).map(([name, expression]) => ({
      name,
      expression,
      readers: readers.filter((reader) => reader.outcome_path[0] === name),
    })),
    artifacts: selectArtifactContracts({ definition, stage, workers, reviews }),
  };
  return { ...model, sections: selectSections(model) };
}

export function stageSelectionHref(model: StageInspectorModel): string {
  return model.selected_unit
    ? definitionUnitHref(
        model.definition.definition_id,
        model.selected_unit.path,
      )
    : definitionStageHref(model.definition.definition_id, model.name);
}

/** Summary of the effective stage and its authored invoking units. */
export interface StageSummary {
  name: string;
  invoking_units: StageInspectorModel["units"];
  worker_count: number;
  artifact_count: number;
  review_count: number;
  done_when: StageInspectorModel["stage"]["done_when"];
}
export function selectStageSummary(model: StageInspectorModel): StageSummary {
  return {
    name: model.name,
    invoking_units: model.units,
    worker_count: model.workers.length,
    artifact_count: model.artifacts.length,
    review_count: model.reviews.length,
    done_when: model.stage.done_when,
  };
}
/** Units whose input bindings the inputs section lists: the selected unit alone, else every invoking unit. */
export function selectStageInputUnits(
  model: StageInspectorModel,
): StageInspectorModel["units"] {
  return model.selected_unit ? [model.selected_unit] : model.sections.inputs.units;
}

export interface PromptReference {
  owner_kind: "worker" | "review";
  owner_key: string;
  mode: string;
  path: string;
}
export interface StageInspectorSections {
  overview: StageSummary;
  inputs: {
    input: OperatorParsedStage["input"];
    units: StageInspectorModel["units"];
  };
  bindings: {
    lets: { name: string; expression: string }[];
    references: DependencyReference[];
  };
  workers: (StageInspectorModel["workers"][number] & {
    when: string | null;
    produces: string[];
    evaluates: string | null;
  })[];
  prompts: PromptReference[];
  artifacts: ArtifactContract[];
  reviews: (StageInspectorModel["reviews"][number] & {
    when: string | null;
    cycle: ReviewCycle | null;
  })[];
  completion: { done_when: string | null; outcome: OutcomeRelationship[] };
}
function selectSections(
  model: Omit<StageInspectorModel, "sections">,
): StageInspectorSections {
  const cycles = selectReviewCycles(model.definition, model.name);
  return {
    overview: {
      name: model.name,
      invoking_units: model.units,
      worker_count: model.workers.length,
      artifact_count: model.artifacts.length,
      review_count: model.reviews.length,
      done_when: model.stage.done_when,
    },
    inputs: { input: model.stage.input, units: model.units },
    bindings: {
      lets: Object.entries(model.stage.let ?? {}).map(([name, expression]) => ({
        name,
        expression,
      })),
      references: selectDefinitionDependencies(
        model.definition.workflow,
      ).references.filter((ref) =>
        model.units.some((unit) => unit.path === ref.downstream),
      ),
    },
    workers: model.workers.map((entry) => ({
      ...entry,
      when: entry.worker.when ?? null,
      produces: entry.worker.produces,
      evaluates:
        entry.worker.kind === "agent" ? (entry.worker.evaluates ?? null) : null,
    })),
    prompts: [
      ...model.workers.flatMap(({ key, worker }): PromptReference[] =>
        worker.kind === "agent"
          ? Object.entries(worker.prompts).flatMap(([mode, path]) =>
              path
                ? [{ owner_kind: "worker", owner_key: key, mode, path }]
                : [],
            )
          : [],
      ),
      ...model.reviews.flatMap(({ key, review }): PromptReference[] =>
        review.prompt
          ? [
              {
                owner_kind: "review",
                owner_key: key,
                mode: "review",
                path: review.prompt,
              },
            ]
          : [],
      ),
    ],
    artifacts: model.artifacts,
    reviews: model.reviews.map((entry) => ({
      ...entry,
      when: entry.review.when ?? null,
      cycle: cycles.find((cycle) => cycle.review === entry.key) ?? null,
    })),
    completion: {
      done_when: model.stage.done_when ?? null,
      outcome: model.outcomes,
    },
  };
}
export function selectStageInspectorModels(
  definition: OperatorDefinitionDetail,
): ReadonlyMap<string, StageInspectorModel> {
  return new Map(
    definition.bundle.stages.flatMap((stage) => {
      const model = selectStageInspectorEntry(definition, {
        kind: "stage",
        stage,
        tab: null,
      });
      return model ? [[stage, model] as const] : [];
    }),
  );
}
export function selectStageInspector(
  definition: OperatorDefinitionDetail,
  selection: DefinitionSelection | null,
): StageInspectorModel | null {
  const unit =
    selection?.kind === "unit"
      ? selectDefinitionOverview(definition).units.find(
          (unit) => unit.path === selection.path,
        )
      : null;
  const name = selection?.kind === "stage" ? selection.stage : unit?.stage;
  if (!name) return null;
  const model = selectStageInspectorModels(definition).get(name);
  return model ? { ...model, selected_unit: unit ?? null } : null;
}
