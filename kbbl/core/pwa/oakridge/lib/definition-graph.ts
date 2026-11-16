export {
  selectDefinitionGraph,
  DEFINITION_NODE_WIDTH,
  DEFINITION_NODE_HEIGHT,
  selectDefinitionNodeLabel,
  selectDefinitionNodeSelected,
} from "./graph-layout";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { OperatorArtifactKind } from "../operator-contracts/core-client/core-types";
import { selectDefinitionOverview } from "./definition-overview";
import {
  selectDefinitionDependencies,
  selectExpressionTokens,
  type DependencyBinding,
} from "./definition-dependencies";
import {
  selectEffectiveWorkers,
  selectEffectiveReviews,
} from "./effective-declarations";

export type GraphScope =
  { kind: "group"; parent: string | null } | { kind: "stage"; stage: string };
export interface ReviewCycle {
  review: string;
  of: string;
  request_changes_decisions: string[];
  revise_workers: string[];
  evaluators: string[];
}
export interface UnitAnnotations {
  for_each: string | null;
  key_expression: string | null;
  pool: { name: string; capacity: number } | null;
  child_count: number;
  per_member_after: string | null;
}
export interface StageAnnotations {
  done_when: string | null;
  worker_conditions: { worker: string; when: string }[];
  review_conditions: { review: string; when: string }[];
  review_cycles: ReviewCycle[];
}
interface GraphElement {
  id: string;
  scope: GraphScope;
}
export type GraphNode = GraphElement &
  (
    | {
        kind: "unit";
        path: string;
        key: string;
        stage: string | null;
        stage_node_id: string | null;
        is_group: boolean;
        annotations: UnitAnnotations;
      }
    | { kind: "stage"; stage: string; annotations: StageAnnotations }
    | {
        kind: "artifact";
        stage: string;
        artifact: string;
        artifact_kind: OperatorArtifactKind;
      }
  );
export type ArtifactConsumer =
  | { kind: "review_of"; review: string }
  | { kind: "evaluates"; worker: string }
  | { kind: "worker_input"; worker: string; input: string }
  | { kind: "review_input"; review: string; input: string };
export type GraphEdge = GraphElement & { from: string; to: string } & (
    | { kind: "dependency"; label: { kind: "after" } }
    | {
        kind: "binding";
        label: { binding: DependencyBinding; outcome_path: string[] };
      }
    | { kind: "produces"; label: { worker: string } }
    | { kind: "consumes"; label: { consumer: ArtifactConsumer } }
    | {
        kind: "revise_loop";
        label: { review: string; decision: string; worker: string };
      }
  );
export interface DefinitionGraphModel {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export function graphElementId(kind: string, parts: readonly string[]): string {
  return `${kind}:${parts.map(encodeURIComponent).join(":")}`;
}
export function selectReviewCycles(
  definition: OperatorDefinitionDetail,
  stage: string,
): ReviewCycle[] {
  const workers = selectEffectiveWorkers(definition).filter(
    (entry) => entry.stage === stage,
  );
  return selectEffectiveReviews(definition)
    .filter((entry) => entry.stage === stage)
    .map(({ key, review, decisions }) => ({
      review: key,
      of: review.of,
      request_changes_decisions: decisions
        .filter((entry) => entry.decision.effect === "request_changes")
        .map((entry) => entry.key),
      revise_workers: workers
        .filter(
          ({ worker }) =>
            worker.produces.includes(review.of) &&
            worker.kind === "agent" &&
            worker.prompts.revise != null,
        )
        .map((entry) => entry.key),
      evaluators: workers
        .filter(
          ({ worker }) =>
            worker.kind === "agent" && worker.evaluates === review.of,
        )
        .map((entry) => entry.key),
    }));
}
export function selectDefinitionGraphModel(
  definition: OperatorDefinitionDetail,
): DefinitionGraphModel {
  const overview = selectDefinitionOverview(definition);
  const dependencies = selectDefinitionDependencies(definition.workflow);
  const nodes: GraphNode[] = overview.units.map((unit) => ({
    kind: "unit",
    id: graphElementId("unit", [unit.path]),
    scope: { kind: "group", parent: unit.parent },
    path: unit.path,
    key: unit.key,
    stage: unit.stage,
    stage_node_id: unit.stage ? graphElementId("stage", [unit.stage]) : null,
    is_group: unit.is_group,
    annotations: {
      for_each: unit.for_each,
      key_expression: unit.key_expression,
      pool:
        overview.pools
          .filter((pool) => pool.units.includes(unit.path))
          .map(({ name, capacity }) => ({ name, capacity }))[0] ?? null,
      child_count: unit.children.length,
      per_member_after:
        dependencies.per_member_after.find((entry) => entry.unit === unit.path)
          ?.expression ?? null,
    },
  }));
  const edges: GraphEdge[] = dependencies.edges
    .filter((edge) => edge.kind === "explicit")
    .map((edge) => ({
      kind: "dependency",
      id: graphElementId("dependency", [edge.from, edge.to]),
      scope: {
        kind: "group",
        parent:
          overview.units.find((unit) => unit.path === edge.to)?.parent ?? null,
      },
      from: graphElementId("unit", [edge.from]),
      to: graphElementId("unit", [edge.to]),
      label: { kind: "after" },
    }));
  for (const ref of dependencies.references)
    edges.push({
      kind: "binding",
      id: graphElementId("binding", [
        ref.upstream,
        ref.downstream,
        ref.binding.kind,
        ref.binding.kind === "input" ? ref.binding.field : "",
        ref.outcome_path.join("."),
      ]),
      scope: {
        kind: "group",
        parent:
          overview.units.find((unit) => unit.path === ref.downstream)?.parent ??
          null,
      },
      from: graphElementId("unit", [ref.upstream]),
      to: graphElementId("unit", [ref.downstream]),
      label: { binding: ref.binding, outcome_path: [...ref.outcome_path] },
    });
  for (const name of definition.bundle.stages) {
    const stage = definition.effective_workflow.stages[name];
    if (!stage) continue;
    const scope: GraphScope = { kind: "stage", stage: name };
    const stage_id = graphElementId("stage", [name]);
    const workers = selectEffectiveWorkers(definition).filter(
      (entry) => entry.stage === name,
    );
    const reviews = selectEffectiveReviews(definition).filter(
      (entry) => entry.stage === name,
    );
    const cycles = selectReviewCycles(definition, name);
    nodes.push({
      kind: "stage",
      id: stage_id,
      scope,
      stage: name,
      annotations: {
        done_when: stage.done_when ?? null,
        worker_conditions: workers.flatMap(({ key, worker }) =>
          worker.when ? [{ worker: key, when: worker.when }] : [],
        ),
        review_conditions: reviews.flatMap(({ key, review }) =>
          review.when ? [{ review: key, when: review.when }] : [],
        ),
        review_cycles: cycles,
      },
    });
    for (const [artifact, contract] of Object.entries(stage.artifacts)) {
      const id = graphElementId("artifact", [name, artifact]);
      nodes.push({
        kind: "artifact",
        id,
        scope,
        stage: name,
        artifact,
        artifact_kind: contract.kind,
      });
      const consume = (consumer: ArtifactConsumer) => {
        const key = "worker" in consumer ? consumer.worker : consumer.review;
        edges.push({
          kind: "consumes",
          id: graphElementId("consumes", [
            name,
            artifact,
            consumer.kind,
            key,
            "input" in consumer ? consumer.input : "",
          ]),
          scope,
          from: id,
          to: stage_id,
          label: { consumer },
        });
      };
      const references = (expression: string) =>
        selectExpressionTokens(expression).some(
          (token, index, tokens) =>
            token === artifact && tokens[index - 1] !== ".",
        );
      for (const { key, worker } of workers) {
        if (worker.produces.includes(artifact))
          edges.push({
            kind: "produces",
            id: graphElementId("produces", [name, key, artifact]),
            scope,
            from: stage_id,
            to: id,
            label: { worker: key },
          });
        if (worker.kind === "agent" && worker.evaluates === artifact)
          consume({ kind: "evaluates", worker: key });
        for (const [input, expression] of Object.entries(worker.inputs))
          if (references(expression))
            consume({ kind: "worker_input", worker: key, input });
      }
      for (const { key, review } of reviews) {
        if (review.of === artifact) consume({ kind: "review_of", review: key });
        for (const [input, expression] of Object.entries(review.inputs ?? {}))
          if (references(expression))
            consume({ kind: "review_input", review: key, input });
      }
      for (const cycle of cycles.filter((cycle) => cycle.of === artifact))
        for (const decision of cycle.request_changes_decisions)
          for (const worker of cycle.revise_workers)
            edges.push({
              kind: "revise_loop",
              id: graphElementId("revise_loop", [
                name,
                cycle.review,
                decision,
                worker,
              ]),
              scope,
              from: id,
              to: stage_id,
              label: { review: cycle.review, decision, worker },
            });
    }
  }
  return { nodes, edges };
}
