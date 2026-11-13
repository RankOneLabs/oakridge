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
