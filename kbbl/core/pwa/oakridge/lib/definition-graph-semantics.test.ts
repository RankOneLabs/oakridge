import { expect, test } from "vitest";
import development from "../__fixtures__/v2-definition-detail.json";
import reviewLoop from "../__fixtures__/definition-review-loop.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import {
  graphElementId,
  selectDefinitionGraphModel,
  selectReviewCycles,
} from "./definition-graph";
import { selectExpressionReadsArtifact } from "./definition-dependencies";
import { selectStageInspectorModels } from "./stage-inspector";

for (const fixture of [development, reviewLoop]) {
  const definition = fixture.definition as unknown as OperatorDefinitionDetail;
  test(`${definition.workflow.workflow}: revision edges use each decision's target and only its producers`, () => {
    const graph = selectDefinitionGraphModel(definition);
    const expected = definition.bundle.stages.flatMap((name) => {
      const stage = definition.effective_workflow.stages[name];
      if (!stage) throw Error("missing stage");
      return Object.entries(stage.reviews ?? {}).flatMap(
        ([reviewKey, review]) => {
          const decisions = Object.entries(review.decisions).filter(
            ([, decision]) => decision.effect === "request_changes",
          );
          const revisions = decisions.map(([key, decision]) => ({
            key,
            artifact: decision.on ?? review.of,
            workers: Object.entries(stage.workers)
              .filter(
                ([, worker]) =>
                  worker.kind === "agent" &&
                  worker.prompts.revise != null &&
                  worker.produces.includes(decision.on ?? review.of),
              )
              .map(([key]) => key),
          }));
          const cycle = selectReviewCycles(definition, name).find(
            (cycle) => cycle.review === reviewKey,
          );
          expect(cycle?.revise_workers).toEqual([
            ...new Set(revisions.flatMap((revision) => revision.workers)),
          ]);
          expect(
            selectStageInspectorModels(definition)
              .get(name)
              ?.sections.reviews.find((entry) => entry.key === reviewKey)
              ?.cycle,
          ).toEqual(cycle);
          return revisions.flatMap((revision) =>
            revision.workers.map((worker) => ({
              kind: "revise_loop",
              id: graphElementId("revise_loop", [
                name,
                reviewKey,
                revision.key,
                worker,
              ]),
              scope: { kind: "stage", stage: name },
              from: graphElementId("artifact", [name, revision.artifact]),
              to: graphElementId("stage", [name]),
              label: { review: reviewKey, decision: revision.key, worker },
            })),
          );
        },
      );
    });
    expect(expected.length).toBeGreaterThan(0);
    expect(
      graph.edges
        .filter((edge) => edge.kind === "revise_loop")
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual(expected.sort((a, b) => a.id.localeCompare(b.id)));
  });
}

test("worker and review consumes edges follow chained stage bindings", () => {
  const source = reviewLoop.definition as unknown as OperatorDefinitionDetail;
  const name = source.bundle.stages[0];
  if (!name) throw Error("missing stage");
  const stage = source.effective_workflow.stages[name];
  if (!stage) throw Error("missing stage");
  const worker = Object.keys(stage.workers)[0];
  const review = Object.keys(stage.reviews ?? {})[0];
  const artifact = Object.keys(stage.artifacts)[0];
  if (
    !worker ||
    !review ||
    !artifact ||
    !stage.workers[worker] ||
    !stage.reviews?.[review]
  )
    throw Error("missing declarations");
  const definition: OperatorDefinitionDetail = {
    ...source,
    effective_workflow: {
      ...source.effective_workflow,
      stages: {
        ...source.effective_workflow.stages,
        [name]: {
          ...stage,
          let: {
            ...stage.let,
            first_alias: `latest(${artifact})`,
            chained_alias: "first_alias",
          },
          workers: {
            ...stage.workers,
            [worker]: {
              ...stage.workers[worker],
              inputs: { alias_input: "chained_alias" },
            },
          },
          reviews: {
            ...stage.reviews,
            [review]: {
              ...stage.reviews[review],
              inputs: { alias_input: "chained_alias" },
            },
          },
        },
      },
    },
  };
  const edges = selectDefinitionGraphModel(definition).edges;
  for (const consumer of [
    { kind: "worker_input", worker, input: "alias_input" },
    { kind: "review_input", review, input: "alias_input" },
  ])
    expect(edges).toContainEqual(
      expect.objectContaining({
        kind: "consumes",
        from: graphElementId("artifact", [name, artifact]),
        to: graphElementId("stage", [name]),
        label: { consumer },
      }),
    );
});

test("artifact aliases ignore field accesses and strings and terminate cyclic bindings", () => {
  const artifact = Object.keys(
    reviewLoop.definition.effective_workflow.stages,
  )[0];
  if (!artifact) throw Error("missing identifier");
  const bindings = {
    alias: `latest(${artifact})`,
    chain: "alias",
    loop_a: "loop_b",
    loop_b: "loop_a",
  };
  for (const expression of ["chain", "loop_a + chain"])
    expect(
      selectExpressionReadsArtifact({ expression, artifact, bindings }),
    ).toBe(true);
  for (const expression of [
    "loop_a",
    "input.alias",
    '"alias"',
    `input.${artifact}`,
  ])
    expect(
      selectExpressionReadsArtifact({ expression, artifact, bindings }),
    ).toBe(false);
});
