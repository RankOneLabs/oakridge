import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import snapshot from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import { selectDefinitionOverview } from "./definition-overview";
const detail = snapshot.definition as unknown as OperatorDefinitionDetail;
test("development overview exposes identity, interfaces and declarations", () => {
  const overview = selectDefinitionOverview(detail);
  expect(overview.name).toBe("development");
  expect(overview.input).toEqual(detail.workflow.input);
  expect(overview.outputs).toEqual(detail.workflow.run.outcome);
  expect(overview.stages).toEqual(["prepare", "analysis", "planning", "brief", "cohort", "integration"]);
  expect(overview.collections.map((unit) => unit.path).sort()).toEqual(["briefs", "implementation", "integration", "prepare"]);
  expect(overview.pools).toEqual(expect.arrayContaining([
    { name: "writers", scope: null, capacity: 4, units: ["briefs"] },
    { name: "builders", scope: null, capacity: 4, units: ["implementation"] },
  ]));
  expect(overview.units.find((unit) => unit.path === "implementation")?.after).toBe("each.depends_on");
});
test("fan-out groups retain nested pools and child declaration paths", () => {
  const root = resolve(import.meta.dirname, "../../../../../workflow-config/definitions");
  const catalog = JSON.parse(readFileSync(resolve(root, "launchable.json"), "utf8")) as { [name: string]: string };
  const workflow = (JSON.parse(readFileSync(resolve(root, "workflows", catalog["fan-out"] + ".json"), "utf8")) as { source: OperatorDefinitionDetail["workflow"] }).source;
  const overview = selectDefinitionOverview({ ...detail, workflow });
  expect(overview.groups).toMatchObject([{ path: "work", stage: null, children: ["work/item"], is_group: true }]);
  expect(overview.pools).toContainEqual({ name: "slots", scope: "work", capacity: 2, units: ["work/item"] });
});
