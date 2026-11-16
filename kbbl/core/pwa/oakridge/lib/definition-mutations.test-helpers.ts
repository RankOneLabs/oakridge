import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type {
  OperatorType,
  OperatorGroup,
  OperatorWorker,
  OperatorPrompts,
  OperatorParsedArtifact,
} from "../operator-contracts/core-client/core-types";
import { selectDefinitionOverview } from "./definition-overview";

type Mutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer V)[]
    ? Mutable<V>[]
    : T extends object
      ? { -readonly [K in keyof T]: Mutable<T[K]> }
      : T;
type DefinitionDraft = Mutable<OperatorDefinitionDetail>;
function mutate(
  definition: OperatorDefinitionDetail,
  change: (draft: DefinitionDraft) => void,
): OperatorDefinitionDetail {
  // The clone owns these values, so mutation cannot affect the immutable source.
  const draft = structuredClone(definition) as DefinitionDraft;
  change(draft);
  const overview = selectDefinitionOverview(draft);
  draft.bundle.stages = [
    ...draft.bundle.stages.filter((stage) => stage in draft.workflow.stages),
    ...Object.keys(draft.workflow.stages).filter(
      (stage) => !draft.bundle.stages.includes(stage),
    ),
  ];
  draft.bundle.units = [
    draft.bundle.units.find((unit) => unit.key === draft.bundle.root) ?? {
      key: draft.bundle.root,
      stage: null,
      label: draft.workflow.workflow,
      input_schema: schemaText(draft.effective_workflow.input),
      artifacts: [],
    },
    ...overview.units.flatMap((unit) => {
      if (!unit.stage) return [];
      const stage = draft.effective_workflow.stages[unit.stage];
      if (!stage) return [];
      const previous = draft.bundle.units.find(
        (entry) => entry.key === unit.path,
      );
      return [
        {
          key: unit.path,
          stage: unit.stage,
          label: previous?.label ?? unit.key,
          input_schema: schemaText(stage.input),
          artifacts: Object.entries(stage.artifacts).map(([key, artifact]) => ({
            key,
            schema:
              previous?.artifacts.find((entry) => entry.key === key)?.schema ??
              schemaText(artifact.schema),
          })),
        },
      ];
    }),
  ];
  draft.graph.nodes = overview.units.map((unit) => ({
    key: unit.path,
    stage: unit.stage ?? unit.key,
    depends_on: Array.isArray(unit.after)
      ? unit.after.map((key) => (unit.parent ? `${unit.parent}/${key}` : key))
      : [],
  }));
  draft.graph.edges = draft.graph.nodes.flatMap((node) =>
    node.depends_on.map((from) => ({ from, to: node.key })),
  );
  return draft;
}
function mapUnits(
  group: Mutable<OperatorGroup>,
  transform: (unit: Mutable<OperatorGroup>["units"][string]) => boolean,
): void {
  for (const [key, unit] of Object.entries(group.units)) {
    if (!transform(unit)) {
      delete group.units[key];
      continue;
    }
    if (unit.group) mapUnits(unit.group, transform);
  }
}
interface RenameStageInput {
  old: string;
  name: string;
}
export function renameStage(
  definition: OperatorDefinitionDetail,
  { old, name }: RenameStageInput,
): OperatorDefinitionDetail {
  return mutate(definition, (draft) => {
    const authored = draft.workflow.stages[old];
    const effective = draft.effective_workflow.stages[old];
    if (!authored || !effective) return;
    draft.bundle.stages = draft.bundle.stages.map((stage) =>
      stage === old ? name : stage,
    );
    draft.workflow.stages = Object.fromEntries(
      Object.entries(draft.workflow.stages).map(([key, stage]) => [
        key === old ? name : key,
        stage,
      ]),
    );
    draft.effective_workflow.stages = Object.fromEntries(
      Object.entries(draft.effective_workflow.stages).map(([key, stage]) => [
        key === old ? name : key,
        stage,
      ]),
    );
    for (const workflow of [draft.workflow, draft.effective_workflow])
      mapUnits(workflow.run, (unit) => {
        if (unit.stage === old) unit.stage = name;
        return true;
      });
  });
}
export function removeStage(
  definition: OperatorDefinitionDetail,
  stage: string,
): OperatorDefinitionDetail {
  return mutate(definition, (draft) => {
    for (const workflow of [draft.workflow, draft.effective_workflow]) {
      delete workflow.stages[stage];
      mapUnits(workflow.run, (unit) => unit.stage !== stage);
    }
  });
}
export function addStage(
  definition: OperatorDefinitionDetail,
  name: string,
): OperatorDefinitionDetail {
  return mutate(definition, (draft) => {
    const template = Object.keys(draft.workflow.stages)[0];
    if (!template) return;
    draft.workflow.stages[name] = structuredClone(
      draft.workflow.stages[template],
    );
    draft.effective_workflow.stages[name] = structuredClone(
      draft.effective_workflow.stages[template],
    );
    for (const workflow of [draft.workflow, draft.effective_workflow])
      workflow.run.units[name] = { stage: name, input: {} };
  });
}
interface AddWorkerInput {
  stage: string;
  key: string;
  worker: OperatorWorker;
}
export function addWorker(
  definition: OperatorDefinitionDetail,
  { stage, key, worker }: AddWorkerInput,
): OperatorDefinitionDetail {
  return mutate(definition, (draft) => {
    for (const workflow of [draft.workflow, draft.effective_workflow]) {
      const declaration = workflow.stages[stage];
      if (declaration) declaration.workers[key] = structuredClone(worker);
    }
  });
}
interface RemoveWorkerInput {
  stage: string;
  key: string;
}
export function removeWorker(
  definition: OperatorDefinitionDetail,
  { stage, key }: RemoveWorkerInput,
): OperatorDefinitionDetail {
  return mutate(definition, (draft) => {
    for (const workflow of [draft.workflow, draft.effective_workflow]) {
      const declaration = workflow.stages[stage];
      if (declaration) delete declaration.workers[key];
    }
  });
}
interface AddPromptInput {
  stage: string;
  worker: string;
  mode: keyof OperatorPrompts;
  path: string;
}
export function addPrompt(
  definition: OperatorDefinitionDetail,
  { stage, worker, mode, path }: AddPromptInput,
): OperatorDefinitionDetail {
  const declaration =
    definition.effective_workflow.stages[stage]?.workers[worker];
  return declaration?.kind === "agent"
    ? addWorker(definition, {
        stage: stage,
        key: worker,
        worker: {
          ...declaration,
          prompts: { ...declaration.prompts, [mode]: path },
        },
      })
    : definition;
}
interface RemovePromptInput {
  stage: string;
  worker: string;
  mode: keyof OperatorPrompts;
}
export function removePrompt(
  definition: OperatorDefinitionDetail,
  { stage, worker, mode }: RemovePromptInput,
): OperatorDefinitionDetail {
  const declaration =
    definition.effective_workflow.stages[stage]?.workers[worker];
  return declaration?.kind === "agent"
    ? addWorker(definition, {
        stage: stage,
        key: worker,
        worker: {
          ...declaration,
          prompts: { ...declaration.prompts, [mode]: null },
        },
      })
    : definition;
}
interface AddArtifactTypeInput {
  stage: string;
  key: string;
  artifact: OperatorParsedArtifact;
}
export function addArtifactType(
  definition: OperatorDefinitionDetail,
  { stage, key, artifact }: AddArtifactTypeInput,
): OperatorDefinitionDetail {
  return mutate(definition, (draft) => {
    const effective = draft.effective_workflow.stages[stage];
    const authored = draft.workflow.stages[stage];
    if (effective && authored) {
      effective.artifacts[key] = structuredClone(artifact);
      authored.artifacts[key] = { kind: artifact.kind, schema: "text" };
    }
  });
}
interface ChangeDependencyInput {
  path: string;
  after: string[];
}
export function changeDependency(
  definition: OperatorDefinitionDetail,
  { path, after }: ChangeDependencyInput,
): OperatorDefinitionDetail {
  return mutate(definition, (draft) => {
    for (const workflow of [draft.workflow, draft.effective_workflow]) {
      const parts = path.split("/");
      const key = parts.pop();
      let group = workflow.run;
      for (const part of parts) {
        const nested = group.units[part]?.group;
        if (!nested) return;
        group = nested;
      }
      if (key && group.units[key]) group.units[key].after = after;
    }
  });
}

/** Canonical expressions mirror the backend schema-view projection. */
function schemaText(type: OperatorType): string {
  switch (type.kind) {
    case "record":
      return `{${Object.keys(type.fields)
        .sort()
        .map((key) => `${key}: ${schemaText(type.fields[key] as OperatorType)}`)
        .join(", ")}}`;
    case "list":
      return `list(${schemaText(type.item)})`;
    case "optional":
      return `optional(${schemaText(type.value)})`;
    case "enum":
      return `enum(${type.variants.join(", ")})`;
    case "named":
      return type.schema;
    case "uuid":
      return "uuid(generated)";
    case "outcome_of":
      return `outcome_of(${type.stage})`;
    default:
      return type.kind;
  }
}
