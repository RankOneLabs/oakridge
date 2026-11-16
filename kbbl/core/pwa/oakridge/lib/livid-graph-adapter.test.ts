import { expect, test } from "vitest";
import { layout } from "@rankonelabs/livid-core";
import development from "../__fixtures__/v2-definition-detail.json";
import fanOut from "../__fixtures__/definition-fan-out.json";
import reviewLoop from "../__fixtures__/definition-review-loop.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import {
  selectDefinitionGraphModel,
  type GraphScope,
} from "./definition-graph";
import {
  selectLividDiagramSpec,
  validateLividDefinitionDiagram,
  isGraphScope,
} from "./livid-graph-adapter";
import { changeDependency } from "./definition-mutations.test-helpers";
import { selectDefinitionOverview } from "./definition-overview";

for (const snapshot of [development, fanOut, reviewLoop]) {
  const definition = snapshot.definition as unknown as OperatorDefinitionDetail;
  test(`${definition.workflow.workflow}: every scope preserves ids through validation and layout`, async () => {
    const model = selectDefinitionGraphModel(definition);
    const scopes: GraphScope[] = [
      { kind: "group", parent: null },
      ...model.nodes.flatMap((node) =>
        node.kind === "unit" && node.is_group
          ? [{ kind: "group" as const, parent: node.path }]
          : [],
      ),
      ...definition.bundle.stages.map((stage) => ({
        kind: "stage" as const,
        stage,
      })),
    ];
    for (const scope of scopes) {
      const spec = selectLividDiagramSpec(model, scope);
      expect(spec.profile).toBe("dependency");
      expect(spec.nodes.map((node) => node.id)).toEqual(
        model.nodes
          .filter((node) => isGraphScope(node.scope, scope))
          .map((node) => node.id),
      );
      expect(spec.edges.map((edge) => edge.id)).toEqual(
        model.edges
          .filter((edge) => isGraphScope(edge.scope, scope))
          .map((edge) => edge.id),
      );
      const valid = validateLividDefinitionDiagram(model, scope);
      expect(valid.ok, JSON.stringify(valid)).toBe(true);
      if (!valid.ok) return;
      const result = await layout(valid.value);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.value.edges.map((edge) => edge.edge.id).sort()).toEqual(
        spec.edges.map((edge) => edge.id).sort(),
      );
      for (const node of spec.nodes)
        expect(node.detail).toEqual(
          model.nodes.find((entry) => entry.id === node.id),
        );
    }
  });
}
test("parallel dependency and binding relationships survive validation and layout", async () => {
  const definition =
    development.definition as unknown as OperatorDefinitionDetail;
  const reference = selectDefinitionGraphModel(definition).edges.find(
    (edge) => edge.kind === "binding",
  );
  expect(reference).toBeDefined();
  if (!reference) return;
  const model = selectDefinitionGraphModel(definition);
  const from = model.nodes.find((node) => node.id === reference.from);
  const to = model.nodes.find((node) => node.id === reference.to);
  if (from?.kind !== "unit" || to?.kind !== "unit")
    throw Error("missing units");
  const altered = changeDependency(definition, {
    path: to.path,
    after: [from.key],
  });
  const projected = selectDefinitionGraphModel(altered);
  const scope: GraphScope = {
    kind: "group",
    parent:
      selectDefinitionOverview(altered).units.find(
        (unit) => unit.path === to.path,
      )?.parent ?? null,
  };
  const edges = projected.edges.filter(
    (edge) => edge.from === reference.from && edge.to === reference.to,
  );
  expect(new Set(edges.map((edge) => edge.kind))).toEqual(
    new Set(["dependency", "binding"]),
  );
  const valid = validateLividDefinitionDiagram(projected, scope);
  expect(valid.ok).toBe(true);
  if (!valid.ok) return;
  const result = await layout(valid.value);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  for (const edge of edges)
    expect(result.value.edges.map((edge) => edge.edge.id)).toContain(edge.id);
});

import { vi, afterEach } from "vitest";
import { createElement } from "react";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import type { LividDiagramProps } from "@rankonelabs/livid-react";
import { definitionRegistry } from "./livid-graph-adapter";
import {
  definitionUnitHref,
  definitionStageHref,
} from "./definition-selection";
import { readFileSync } from "node:fs";
vi.mock("@rankonelabs/livid-react", () => ({
  LividDiagram: (props: LividDiagramProps<typeof definitionRegistry>) =>
    createElement(
      "div",
      { "aria-label": props.ariaLabel },
      props.diagram.nodes
        .filter(({ node }) => node.childState.kind === "deferred")
        .map(({ node }) =>
          createElement(
            "button",
            {
              key: `descend:${node.id}`,
              onClick: () => {
                if (node.childState.kind === "deferred")
                  props.onDescendRequest?.({
                    nodeId: node.id,
                    childState: node.childState,
                  });
              },
            },
            `Descend ${node.label}`,
          ),
        ),
      props.diagram.nodes.map(({ node }) =>
        createElement(
          "button",
          {
            key: node.id,
            "aria-pressed":
              props.selection?.kind === "node" &&
              props.selection.id === node.id,
            onClick: () =>
              props.onSelectionChange?.({
                kind: "node",
                id: node.id,
                detail: node.detail,
              }),
          },
          node.label,
        ),
      ),
    ),
}));
import { LividDefinitionGraphController } from "../components/organisms/LividDefinitionGraphController";
afterEach(cleanup);
for (const fixture of [development, fanOut, reviewLoop]) {
  test(`${fixture.definition.workflow.workflow}: component renders the asynchronous layout and navigates selected units`, async () => {
    const definition =
      fixture.definition as unknown as OperatorDefinitionDetail;
    const model = selectDefinitionGraphModel(definition);
    const unit = model.nodes.find(
      (node) =>
        node.kind === "unit" &&
        node.scope.kind === "group" &&
        node.scope.parent === null,
    );
    if (unit?.kind !== "unit") throw Error("missing root unit");
    render(
      createElement(LividDefinitionGraphController, {
        model,
        selection: null,
        definition_id: definition.definition_id,
      }),
    );
    const button = await screen.findByRole(
      "button",
      { name: unit.key },
      { timeout: 20000 },
    );
    fireEvent.click(button);
    await waitFor(() =>
      expect(window.location.hash).toBe(
        definitionUnitHref(definition.definition_id, unit.path),
      ),
    );
  }, 25000);
}
test("Livid consumer imports both required library stylesheets", () => {
  const source = readFileSync(
    "oakridge/components/molecules/LividDefinitionGraph.tsx",
    "utf8",
  );
  expect(source).toContain('import "@xyflow/react/dist/style.css"');
  expect(source).toContain('import "@rankonelabs/livid-react/styles.css"');
});

test("fan-out groups defer descent to their child group scope", () => {
  const definition = fanOut.definition as unknown as OperatorDefinitionDetail;
  const model = selectDefinitionGraphModel(definition);
  const group = model.nodes.find(
    (node) => node.kind === "unit" && node.is_group,
  );
  if (group?.kind !== "unit") throw Error("missing group");
  const spec = selectLividDiagramSpec(model, group.scope);
  expect(spec.nodes.find((node) => node.id === group.id)?.childState).toEqual({
    kind: "deferred",
    key: group.id,
  });
  const children = selectLividDiagramSpec(model, {
    kind: "group",
    parent: group.path,
  });
  expect(children.nodes.map((node) => node.id)).toEqual(
    model.nodes
      .filter(
        (node) =>
          node.scope.kind === "group" && node.scope.parent === group.path,
      )
      .map((node) => node.id),
  );
  expect(children.nodes.length).toBeGreaterThan(0);
});

import { DefinitionGraph } from "../components/molecules/DefinitionGraph";
test("route changes restore group and stage scopes and selection across rerenders", async () => {
  const definition = fanOut.definition as unknown as OperatorDefinitionDetail;
  const overview = selectDefinitionOverview(definition);
  const group = overview.units.find((unit) => unit.is_group);
  if (!group) throw Error("missing group");
  const child = overview.units.find((unit) => unit.parent === group.path);
  if (!child?.stage) throw Error("missing child stage");
  const props = { definition, overview, renderer: "livid" as const };
  const view = render(
    createElement(DefinitionGraph, { ...props, selection: null }),
  );
  fireEvent.click(
    await screen.findByRole(
      "button",
      { name: `Descend ${group.key}` },
      { timeout: 20000 },
    ),
  );
  expect(window.location.hash).toBe(
    definitionUnitHref(definition.definition_id, group.path),
  );
  // The router supplies the new selection after the hash changes.
  view.rerender(
    createElement(DefinitionGraph, {
      ...props,
      selection: { kind: "unit", path: group.path },
    }),
  );
  await screen.findByRole("button", { name: child.key }, { timeout: 20000 });
  view.rerender(
    createElement(DefinitionGraph, {
      ...props,
      selection: { kind: "unit", path: group.path },
    }),
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("button", { name: child.key })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: `Descend ${child.key}` }));
  expect(window.location.hash).toBe(
    definitionStageHref(definition.definition_id, child.stage),
  );
  view.rerender(
    createElement(DefinitionGraph, {
      ...props,
      selection: { kind: "stage", stage: child.stage },
    }),
  );
  const stageNode = await screen.findByRole(
    "button",
    { name: child.stage, pressed: true },
    { timeout: 20000 },
  );
  expect(stageNode).toBeDefined();
  // Back/forward route restoration shows the same scopes without local descent state.
  view.rerender(
    createElement(DefinitionGraph, {
      ...props,
      selection: { kind: "unit", path: group.path },
    }),
  );
  await screen.findByRole("button", { name: child.key }, { timeout: 20000 });
  view.rerender(
    createElement(DefinitionGraph, {
      ...props,
      selection: { kind: "unit", path: child.path },
    }),
  );
  expect(
    await screen.findByRole(
      "button",
      { name: child.key, pressed: true },
      { timeout: 20000 },
    ),
  ).toBeDefined();
});

test("dagre renders without requesting the deferred Livid component", () => {
  const definition =
    development.definition as unknown as OperatorDefinitionDetail;
  render(
    createElement(DefinitionGraph, {
      definition,
      overview: selectDefinitionOverview(definition),
      selection: null,
      renderer: "dagre",
    }),
  );
  expect(
    screen.getByRole("img", { name: "Unit dependency graph" }),
  ).toBeDefined();
  expect(screen.queryByLabelText("Definition graph")).toBeNull();
  const source = readFileSync(
    "oakridge/components/molecules/DefinitionGraph.tsx",
    "utf8",
  );
  expect(source).toContain(
    'import("../organisms/LividDefinitionGraphController")',
  );
  expect(source).not.toMatch(/import \{.*Livid.*\} from/);
});
