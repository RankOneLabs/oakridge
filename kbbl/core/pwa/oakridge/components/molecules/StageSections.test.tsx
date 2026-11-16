import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import fixture from "../../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../../operator-contracts/projections/definition-view";
import { StageInspector } from "./StageInspector";
import { selectStageInspector } from "../../lib/stage-inspector";
import { StageCompletionSection } from "./StageCompletionSection";
const detail = fixture.definition as unknown as OperatorDefinitionDetail;
afterEach(cleanup);
function inspect(tab: import("../../lib/definition-selection").StageTab = "overview") { return render(<StageInspector definition={detail} selection={{ kind: "unit", path: "implementation", tab }} />); }
test("summary leads the section stack with effective counts and invoking unit links", () => {
  const { container } = inspect();
  const sections = container.querySelectorAll('section[aria-label]');
  expect(sections[1]?.getAttribute("aria-label")).toBe("Stage summary");
  expect(within(screen.getByLabelText("Stage identity")).getByRole("link", { name: "implementation" }).getAttribute("href")).toContain("/units/implementation");
});
test("workers retain trigger, session, bindings and linked outputs", () => {
  inspect("workers"); const section = screen.getByRole("region", { name: "Workers" });
  expect(within(section).getByText("builder")).toBeTruthy();
  expect(section.textContent).toContain("session:");
  expect(section.querySelector('.or-stage-bindings')).toBeTruthy();
  expect(within(section).getAllByRole("link").some(link => link.getAttribute("href")?.includes("#stage-cohort-artifact-build_result"))).toBe(true);
});
test("artifacts retain schema and relationship links with compact validation markers", () => {
  inspect("artifacts"); const section = screen.getByRole("region", { name: "Artifacts" });
  expect(section.querySelectorAll('a').length).toBeGreaterThan(3);
  expect(section.textContent).toContain("Produced by:");
  expect(section.textContent).toContain("Consumed by:");
});
test("prompt references are text and template declarations start collapsed", () => {
  inspect("prompts"); const section = screen.getByRole("region", { name: "Prompts" });
  expect(section.textContent).toContain("development/build.md");
  expect(section.querySelector("pre")?.textContent).toBeTruthy();
  expect(section.querySelectorAll("details").length).toBeGreaterThan(0);
  expect(section.querySelector("details[open]")).toBeNull();
});
test("completion separates condition, fields and consumers including whole outcomes", () => {
  inspect("completion"); const section = screen.getByRole("region", { name: "Completion" });
  for (const name of ["done_when", "Stage outcome fields", "Downstream consumers", "Whole-outcome readers"]) expect(within(section).getByRole("heading", { name })).toBeTruthy();
  expect(within(section).getAllByRole("link").some(link => link.getAttribute("href")?.includes("/units/integration"))).toBe(true);
});

test("validated artifacts display a compact inline marker", () => {
  render(<StageInspector definition={detail} selection={{ kind: "stage", stage: "brief", tab: "artifacts" }} />);
  const heading = screen.getByRole("heading", { name: "brief · Validated artifact" });
  expect(heading.querySelector("small.or-stage-validated")?.textContent).toBe("validated");
});
test("artifacts without validation rules have no validation marker", () => {
  inspect("artifacts");
  const heading = screen.getByRole("heading", { name: "build_result" });
  expect(heading.querySelector(".or-stage-validated")).toBeNull();
});
test("completion names each outcome field only once", () => {
  inspect("completion");
  const section = screen.getByRole("region", { name: "Completion" });
  expect(within(section).getAllByRole("heading", { name: /^outcome\./ }).map(heading => heading.textContent)).toEqual(
    Object.keys(detail.effective_workflow.stages.cohort?.outcome ?? {}).map(name => `outcome.${name}`),
  );
});
test("completion explains an undeclared done_when condition", () => {
  const model = selectStageInspector(detail, { kind: "stage", stage: "cohort", tab: null });
  if (!model) throw new Error("Expected cohort stage in the development fixture");
  render(<StageCompletionSection model={{ ...model, sections: { ...model.sections, completion: { ...model.sections.completion, done_when: null } } }} />);
  expect(screen.getByText("Not declared")).toBeTruthy();
});
