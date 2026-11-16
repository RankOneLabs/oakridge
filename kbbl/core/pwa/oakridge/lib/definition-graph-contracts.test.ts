import { expect, test } from "vitest";
import snapshot from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { selectDefinitionOverview } from "./definition-overview";
// All expectations below derive their domain identifiers from the same input projection.
import fanOutSnapshot from "../__fixtures__/definition-fan-out.json";
import reviewLoopSnapshot from "../__fixtures__/definition-review-loop.json";

import { readFileSync } from "node:fs";
import { selectDefinitionGraphModel, graphElementId } from "./definition-graph";
import { selectStageInspectorModels } from "./stage-inspector";
import * as mutations from "./definition-mutations.test-helpers";

type LaunchableEntry = string | { definition_id: string };
const catalog = JSON.parse(
  readFileSync("../../../workflow-config/definitions/launchable.json", "utf8"),
) as { "fan-out": LaunchableEntry; "review-loop": LaunchableEntry };
for (const [fixture, launchable, workflow] of [
  [fanOutSnapshot, catalog["fan-out"], "fan_out"],
  [reviewLoopSnapshot, catalog["review-loop"], "review_loop"],
] as const) {
  test(`${workflow} fixture comes from the launchable projection`, () => {
    expect(fixture.definition.definition_id).toBe(
      typeof launchable === "string" ? launchable : launchable.definition_id,
    );
    expect(fixture.definition.effective_workflow.workflow).toBe(workflow);
  });
}
for (const fixture of [snapshot, fanOutSnapshot, reviewLoopSnapshot]) {
  const source = fixture.definition as unknown as OperatorDefinitionDetail;
  const stage = source.bundle.stages.find((name) =>
    Object.values(source.effective_workflow.stages[name]?.workers ?? {}).some(
      (worker) => worker.kind === "agent",
    ),
  );
  if (!stage) throw Error("fixture has no stage");
  const worker = Object.entries(
    source.effective_workflow.stages[stage]?.workers ?? {},
  ).find(([, worker]) => worker.kind === "agent");
  if (!worker) throw Error("fixture has no agent");
  const unit = selectDefinitionOverview(source).units.find(
    (unit) => unit.stage === stage,
  );
  if (!unit) throw Error("fixture has no invoking unit");
  const variants = [
    source,
    mutations.renameStage(source, stage, "renamed_stage"),
    mutations.addStage(source, "extra_stage"),
    mutations.removeStage(source, stage),
    mutations.addWorker(source, stage, "extra_worker", worker[1]),
    mutations.removeWorker(source, stage, worker[0]),
    mutations.addPrompt(source, stage, worker[0], "handoff", "extra/prompt.md"),
    mutations.removePrompt(source, stage, worker[0], "initial"),
    mutations.addArtifactType(source, stage, "extra_artifact", {
      kind: "document",
      schema: { kind: "text" },
    }),
    mutations.changeDependency(source, unit.path, []),
  ];
  test(`${source.workflow.workflow}: original and all nine mutations share graph and inspector contracts`, () => {
    for (const definition of variants) {
      const graph = selectDefinitionGraphModel(definition);
      const overview = selectDefinitionOverview(definition);
      const inspectors = selectStageInspectorModels(definition);
      expect([...inspectors.keys()]).toEqual(definition.bundle.stages);
      expect(
        graph.nodes
          .filter((node) => node.kind === "stage")
          .map((node) => node.stage),
      ).toEqual(definition.bundle.stages);
      expect(
        graph.nodes
          .filter((node) => node.kind === "unit")
          .map((node) => node.path),
      ).toEqual(overview.units.map((unit) => unit.path));
      expect(
        new Set([...graph.nodes, ...graph.edges].map((element) => element.id))
          .size,
      ).toBe(graph.nodes.length + graph.edges.length);
      for (const edge of graph.edges)
        for (const endpoint of [edge.from, edge.to])
          expect(
            graph.nodes.some(
              (node) =>
                node.id === endpoint &&
                JSON.stringify(node.scope) === JSON.stringify(edge.scope),
            ),
          ).toBe(true);
    }
  });
  test(`${source.workflow.workflow}: renaming a stage preserves every unrelated graph id`, () => {
    const before = selectDefinitionGraphModel(source);
    const after = selectDefinitionGraphModel(
      variants[1] as OperatorDefinitionDetail,
    );
    const unaffected = (graph: ReturnType<typeof selectDefinitionGraphModel>) =>
      [...graph.nodes, ...graph.edges]
        .filter(
          (element) =>
            element.scope.kind !== "stage" ||
            ![stage, "renamed_stage"].includes(element.scope.stage),
        )
        .map((element) => element.id);
    expect(unaffected(after)).toEqual(unaffected(before));
    expect(variants[1]?.bundle.stages).not.toContain(stage);
    expect(
      selectDefinitionOverview(
        variants[1] as OperatorDefinitionDetail,
      ).units.some((unit) => unit.stage === stage),
    ).toBe(false);
    expect(
      selectDefinitionOverview(
        variants[3] as OperatorDefinitionDetail,
      ).units.some((unit) => unit.stage === stage),
    ).toBe(false);
  });
  test(`${source.workflow.workflow}: worker, prompt and artifact mutations update their sections`, () => {
    const section = (definition: OperatorDefinitionDetail) =>
      selectStageInspectorModels(definition).get(stage)?.sections;
    expect(
      section(variants[4] as OperatorDefinitionDetail)?.workers.map(
        (entry) => entry.key,
      ),
    ).toContain("extra_worker");
    const originalPrompts = section(source)?.prompts ?? [];
    expect(section(variants[4] as OperatorDefinitionDetail)?.prompts.map((entry) => JSON.stringify(entry)).sort()).toEqual([
      ...originalPrompts,
      ...originalPrompts.filter((entry) => entry.owner_kind === "worker" && entry.owner_key === worker[0])
        .map((entry) => ({ ...entry, owner_key: "extra_worker" })),
    ].map((entry) => JSON.stringify(entry)).sort());
    expect(
      section(variants[5] as OperatorDefinitionDetail)?.workers.map(
        (entry) => entry.key,
      ),
    ).not.toContain(worker[0]);
    expect(
      section(variants[5] as OperatorDefinitionDetail)?.prompts.some(
        (entry) =>
          entry.owner_kind === "worker" && entry.owner_key === worker[0],
      ),
    ).toBe(false);
    expect(
      section(variants[6] as OperatorDefinitionDetail)?.prompts,
    ).toContainEqual({
      owner_kind: "worker",
      owner_key: worker[0],
      mode: "handoff",
      path: "extra/prompt.md",
    });
    expect(
      section(variants[7] as OperatorDefinitionDetail)?.prompts.some(
        (entry) => entry.owner_key === worker[0] && entry.mode === "initial",
      ),
    ).toBe(false);
    expect(
      section(variants[8] as OperatorDefinitionDetail)?.artifacts.map(
        (entry) => entry.name,
      ),
    ).toContain("extra_artifact");
  });
}
test("parallel annotations mirror the source declaration and inherited pool", () => {
  const definition =
    fanOutSnapshot.definition as unknown as OperatorDefinitionDetail;
  const overview = selectDefinitionOverview(definition);
  const graph = selectDefinitionGraphModel(definition);
  for (const unit of overview.units) {
    const node = graph.nodes.find(
      (node) => node.id === graphElementId("unit", [unit.path]),
    );
    expect(node?.kind).toBe("unit");
    if (node?.kind !== "unit") continue;
    const pool = overview.pools.find((pool) => pool.units.includes(unit.path));
    expect(node.annotations).toEqual({
      for_each: unit.for_each,
      key_expression: unit.key_expression,
      pool: pool ? { name: pool.name, capacity: pool.capacity } : null,
      child_count: unit.children.length,
      per_member_after: typeof unit.after === "string" ? unit.after : null,
    });
  }
});
test("review loop graph and inspector derive cycles, conditions and prompt references", () => {
  const definition =
    reviewLoopSnapshot.definition as unknown as OperatorDefinitionDetail;
  const graph = selectDefinitionGraphModel(definition);
  for (const [name, stage] of Object.entries(
    definition.effective_workflow.stages,
  )) {
    const node = graph.nodes.find(
      (node) => node.kind === "stage" && node.stage === name,
    );
    if (node?.kind !== "stage") throw Error("missing stage");
    expect(node.annotations.done_when).toBe(stage.done_when);
    const model = selectStageInspectorModels(definition).get(name);
    for (const [key, review] of Object.entries(stage.reviews ?? {})) {
      const decisions = Object.entries(review.decisions)
        .filter(([, decision]) => decision.effect === "request_changes")
        .map(([key]) => key);
      const workers = Object.entries(stage.workers)
        .filter(
          ([, worker]) =>
            worker.produces.includes(review.of) &&
            worker.kind === "agent" &&
            worker.prompts.revise,
        )
        .map(([key]) => key);
      const cycle = {
        review: key,
        of: review.of,
        request_changes_decisions: decisions,
        revise_workers: workers,
        evaluators: Object.entries(stage.workers)
          .filter(
            ([, worker]) =>
              worker.kind === "agent" && worker.evaluates === review.of,
          )
          .map(([key]) => key),
      };
      expect(node.annotations.review_cycles).toContainEqual(cycle);
      expect(model?.sections.reviews.find((entry) => entry.key === key)?.cycle).toEqual(cycle);
      for (const decision of decisions)
        for (const worker of workers)
          expect(
            graph.edges.some(
              (edge) =>
                edge.id ===
                graphElementId("revise_loop", [name, key, decision, worker]) &&
                edge.from === graphElementId("artifact", [name, review.of]) &&
                edge.to === graphElementId("stage", [name]),
            ),
          ).toBe(true);
      expect(
        graph.edges.some(
          (edge) =>
            edge.kind === "consumes" &&
            edge.from === graphElementId("artifact", [name, review.of]) &&
            edge.label.consumer.kind === "review_of" &&
            edge.label.consumer.review === key,
        ),
      ).toBe(true);
      if (review.prompt)
        expect(model?.sections.prompts).toContainEqual({
          owner_kind: "review",
          owner_key: key,
          mode: "review",
          path: review.prompt,
        });
    }
    expect(model?.sections.bindings.lets).toEqual(
      Object.entries(stage.let ?? {}).map(([name, expression]) => ({
        name,
        expression,
      })),
    );
    for (const [key, worker] of Object.entries(stage.workers))
      if (worker.kind === "agent") {
        expect(model?.sections.workers.find((entry) => entry.key === key)?.evaluates).toBe(worker.evaluates ?? null);
        for (const [input, expression] of Object.entries(worker.inputs))
          for (const artifact of Object.keys(stage.artifacts))
            if (expression === `latest(${artifact})`)
              expect(graph.edges).toContainEqual(expect.objectContaining({
                kind: "consumes",
                from: graphElementId("artifact", [name, artifact]),
                to: graphElementId("stage", [name]),
                label: { consumer: { kind: "worker_input", worker: key, input } },
              }));
        for (const [mode, path] of Object.entries(worker.prompts))
          if (path)
            expect(model?.sections.prompts).toContainEqual({
              owner_kind: "worker",
              owner_key: key,
              mode,
              path,
            });
      }
  }
});
test("projection sources contain no workflow identity literals or renderer types", () => {
  for (const file of [
    "definition-overview",
    "definition-dependencies",
    "definition-graph",
    "stage-inspector",
    "effective-declarations",
    "livid-graph-adapter",
  ]) {
    const source = readFileSync(`oakridge/lib/${file}.ts`, "utf8");
    for (const literal of [
      "development",
      "fan_out",
      "review_loop",
      "analysis",
      "cohort",
      "brief",
      "planning",
      "integration",
    ])
      expect(source).not.toContain(JSON.stringify(literal));
    if (file === "definition-graph") {
      expect(source).not.toMatch(/from ["']dagre/);
      expect(source).not.toContain("@rankonelabs/");
    }
  }
});

test.each([snapshot, fanOutSnapshot, reviewLoopSnapshot])("stage additions and removals preserve unrelated element ids: $definition.workflow.workflow", (fixture) => {
  const definition = fixture.definition as unknown as OperatorDefinitionDetail;
  const original = selectDefinitionGraphModel(definition);
  const ids = (model: typeof original) => [...model.nodes, ...model.edges].map((element) => element.id).sort();
  const addedStage = "extra_stage";
  const added = selectDefinitionGraphModel(mutations.addStage(definition, addedStage));
  const addedUnit = graphElementId("unit", [addedStage]);
  expect(ids({
    nodes: added.nodes.filter((node) => node.id !== addedUnit && !(node.scope.kind === "stage" && node.scope.stage === addedStage)),
    edges: added.edges.filter((edge) => !(edge.scope.kind === "stage" && edge.scope.stage === addedStage)),
  })).toEqual(ids(original));
  const stage = definition.bundle.stages[0];
  if (!stage) throw Error("missing stage");
  const removedUnits = original.nodes.filter((node) => node.kind === "unit" && node.stage === stage).map((node) => node.id);
  const unaffected = {
    nodes: original.nodes.filter((node) => !removedUnits.includes(node.id) && !(node.scope.kind === "stage" && node.scope.stage === stage)),
    edges: original.edges.filter((edge) => !removedUnits.includes(edge.from) && !removedUnits.includes(edge.to) && !(edge.scope.kind === "stage" && edge.scope.stage === stage)),
  };
  expect(ids(selectDefinitionGraphModel(mutations.removeStage(definition, stage)))).toEqual(ids(unaffected));
});

test("changing a fan-out dependency changes only that dependency edge id", () => {
  const definition = fanOutSnapshot.definition as unknown as OperatorDefinitionDetail;
  const original = selectDefinitionGraphModel(definition);
  const edge = original.edges.find((edge) => edge.kind === "binding");
  if (!edge) throw Error("missing binding");
  const units = selectDefinitionOverview(definition).units;
  const from = units.find((unit) => graphElementId("unit", [unit.path]) === edge.from);
  const to = units.find((unit) => graphElementId("unit", [unit.path]) === edge.to);
  if (!from || !to) throw Error("missing binding units");
  const changed = selectDefinitionGraphModel(mutations.changeDependency(definition, to.path, [from.key]));
  expect(changed.nodes.map((node) => node.id)).toEqual(original.nodes.map((node) => node.id));
  const addedId = graphElementId("dependency", [from.path, to.path]);
  expect(changed.edges.filter((entry) => entry.id === addedId)).toHaveLength(1);
  expect(changed.edges.filter((entry) => entry.id !== addedId).map((entry) => entry.id)).toEqual(original.edges.map((entry) => entry.id));
});
