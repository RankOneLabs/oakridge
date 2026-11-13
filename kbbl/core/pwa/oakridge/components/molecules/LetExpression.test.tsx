import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import fixture from "../../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../../operator-contracts/projections/definition-view";
import { selectStageInspector } from "../../lib/stage-inspector";
import { LetExpression } from "./LetExpression";

const detail = fixture.definition as unknown as OperatorDefinitionDetail;
afterEach(cleanup);

test("analysis input.spec stays verbatim without linking to the spec artifact", () => {
  const model = selectStageInspector(detail, { kind: "stage", stage: "analysis" });
  if (!model) throw new Error("Missing analysis stage");
  const view = render(<LetExpression model={model} expression="input.spec" />);
  expect(view.container.textContent).toBe("input.spec");
  expect(screen.queryByRole("link")).toBeNull();
});

test("standalone artifacts link while property accesses and quoted names do not", () => {
  const model = selectStageInspector(detail, { kind: "stage", stage: "analysis" });
  if (!model) throw new Error("Missing analysis stage");
  const expression = 'approved(spec) and input . spec == "spec"';
  const view = render(<LetExpression model={model} expression={expression} />);
  expect(view.container.textContent).toBe(expression);
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["spec"]);
});

test("a field sharing a let binding's name stays verbatim", () => {
  const model = selectStageInspector(detail, { kind: "stage", stage: "cohort" });
  if (!model) throw new Error("Missing cohort stage");
  const view = render(<LetExpression model={model} expression="input.brief_value and brief_value" />);
  expect(view.container.textContent).toBe("input.brief_value and brief_value");
  expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
    expect.stringContaining("#stage-cohort-let-brief_value"),
  ]);
});

test("hyphenated and dollar identifiers link whole, never by their parts", () => {
  const cohort = selectStageInspector(detail, { kind: "stage", stage: "cohort" });
  if (!cohort) throw new Error("Missing cohort stage");
  const artifact = cohort.stage.artifacts.build_result;
  const model = { ...cohort, stage: { ...cohort.stage, artifacts: { ...cohort.stage.artifacts, "build-result": artifact, "$draft": artifact, build: artifact } } };
  const view = render(<LetExpression model={model} expression="latest(build-result) and latest($draft)" />);
  expect(view.container.textContent).toBe("latest(build-result) and latest($draft)");
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["build-result", "$draft"]);
});
