import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import snapshot from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import {
  selectAbbreviatedDefinitionId,
  selectDefinitionOverview,
  selectDefinitionSelection,
  selectDefinitionSchemaParts,
} from "./definition-overview";
const detail = snapshot.definition as unknown as OperatorDefinitionDetail;
test("development overview exposes identity, interfaces and declarations", () => {
  const overview = selectDefinitionOverview(detail);
  expect(overview.name).toBe("development");
  expect(overview.input).toEqual(detail.workflow.input);
  expect(overview.outputs).toEqual(detail.workflow.run.outcome);
  expect(overview.stages).toEqual(["prepare", "analysis", "planning", "brief", "cohort", "integration"]);
  expect(overview.collections.map((unit) => unit.path).sort()).toEqual([
    "briefs",
    "implementation",
    "integration",
    "prepare",
  ]);
  expect(overview.pools).toEqual(
    expect.arrayContaining([
      { name: "writers", scope: null, capacity: 4, units: ["briefs"] },
      { name: "builders", scope: null, capacity: 4, units: ["implementation"] },
    ]),
  );
  expect(overview.units.find((unit) => unit.path === "implementation")?.after).toBe("each.depends_on");
});
test("fan-out groups retain nested pools and child declaration paths", () => {
  const root = resolve(import.meta.dirname, "../../../../../workflow-config/definitions");
  const catalog = JSON.parse(readFileSync(resolve(root, "launchable.json"), "utf8")) as {
    [name: string]: string;
  };
  const workflow = (
    JSON.parse(readFileSync(resolve(root, "workflows", catalog["fan-out"] + ".json"), "utf8")) as {
      source: OperatorDefinitionDetail["workflow"];
    }
  ).source;
  const overview = selectDefinitionOverview({ ...detail, workflow });
  expect(overview.groups).toMatchObject([
    { path: "work", stage: null, children: ["work/item"], is_group: true },
  ]);
  expect(overview.pools).toContainEqual({ name: "slots", scope: "work", capacity: 2, units: ["work/item"] });
});

test("overview preserves prerequisite arrays, expressions, empty arrays and absence", () => {
  const workflow = {
    ...detail.workflow,
    run: {
      outcome: {},
      units: {
        first: { stage: "analysis" },
        second: { stage: "planning", after: ["first"] },
        collection: { stage: "cohort", after: "each.depends_on", for_each: "input.items" },
        empty: { stage: "prepare", after: [] },
      },
    },
  };
  expect(
    selectDefinitionOverview({ ...detail, workflow }).units.map(({ after, after_text }) => ({
      after,
      after_text,
    })),
  ).toEqual([
    { after: null, after_text: null },
    { after: ["first"], after_text: '["first"]' },
    { after: "each.depends_on", after_text: "each.depends_on" },
    { after: [], after_text: "[]" },
  ]);
});

test("selection summary returns all stage callers including nested units", () => {
  const workflow = {
    ...detail.workflow,
    run: {
      outcome: {},
      units: {
        first: { stage: "cohort" },
        work: { group: { outcome: {}, units: { item: { stage: "cohort" } } } },
      },
    },
  };
  const overview = selectDefinitionOverview({ ...detail, workflow });
  const summary = selectDefinitionSelection({ overview, selection: { kind: "stage", stage: "cohort" } });
  expect(summary).toEqual({
    kind: "stage",
    stage: "cohort",
    callers: overview.units.filter((unit) => !unit.is_group),
  });
});

test("selection summary preserves a selected nested group declaration", () => {
  const workflow = {
    ...detail.workflow,
    run: {
      outcome: {},
      units: {
        work: { group: { outcome: {}, units: { nested: { group: { outcome: {}, units: {} } } } } },
      },
    },
  };
  const overview = selectDefinitionOverview({ ...detail, workflow });
  expect(selectDefinitionSelection({ overview, selection: { kind: "unit", path: "work/nested" } })).toEqual({
    kind: "unit",
    unit: overview.units[1],
  });
});

test("selection summary distinguishes no selection from absent stages and units", () => {
  const overview = selectDefinitionOverview(detail);
  expect(selectDefinitionSelection({ overview, selection: null })).toEqual({ kind: "none" });
  expect(selectDefinitionSelection({ overview, selection: { kind: "stage", stage: "unknown" } })).toEqual({
    kind: "missing",
    selection: { kind: "stage", stage: "unknown" },
  });
  expect(selectDefinitionSelection({ overview, selection: { kind: "unit", path: "unknown" } })).toEqual({
    kind: "missing",
    selection: { kind: "unit", path: "unknown" },
  });
});

test("schema type parts link exact schema identifiers within nested expressions", () => {
  expect(
    selectDefinitionSchemaParts("map(repository, list(repository_extra))", [
      { key: "repository", shape: { kind: "record", fields: [] } },
    ]),
  ).toEqual([
    { kind: "text", text: "map" },
    { kind: "text", text: "(" },
    { kind: "schema", text: "repository" },
    { kind: "text", text: ", " },
    { kind: "text", text: "list" },
    { kind: "text", text: "(" },
    { kind: "text", text: "repository_extra" },
    { kind: "text", text: "))" },
  ]);
});

test("schema matching preserves text when no schemas are declared", () => {
  expect(
    selectDefinitionSchemaParts("list(repository)", [])
      .map((part) => part.text)
      .join(""),
  ).toBe("list(repository)");
  expect(selectDefinitionSchemaParts("", [])).toEqual([]);
});
test("abbreviated definition id keeps a twelve-character prefix with an ellipsis", () => {
  expect(selectAbbreviatedDefinitionId("0123456789abcdef")).toBe("0123456789ab…");
});
