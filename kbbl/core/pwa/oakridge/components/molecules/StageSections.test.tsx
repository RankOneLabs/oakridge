import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import fixture from "../../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../../operator-contracts/projections/definition-view";
import { StageInspector } from "../organisms/StageInspector";
const detail = fixture.definition as unknown as OperatorDefinitionDetail;
afterEach(cleanup);
function inspect() { return render(<StageInspector definition={detail} selection={{ kind: "unit", path: "implementation" }} />); }
test("summary leads the section stack with effective counts and invoking unit links", () => {
  const { container } = inspect();
  const sections = container.querySelectorAll('section[aria-label]');
  expect(sections[1]?.getAttribute("aria-label")).toBe("Stage summary");
  expect(within(screen.getByRole("region", { name: "Stage summary" })).getByRole("link", { name: "implementation" }).getAttribute("href")).toContain("/units/implementation");
});
test("workers retain trigger, session, bindings and linked outputs", () => {
  inspect(); const section = screen.getByRole("region", { name: "Workers" });
  expect(within(section).getByText("builder")).toBeTruthy();
  expect(section.textContent).toContain("session:");
  expect(section.querySelector('.or-stage-bindings')).toBeTruthy();
  expect(within(section).getAllByRole("link").some(link => link.getAttribute("href")?.includes("#stage-cohort-artifact-build_result"))).toBe(true);
});
test("artifacts retain schema and relationship links with compact validation markers", () => {
  inspect(); const section = screen.getByRole("region", { name: "Artifacts" });
  expect(section.querySelectorAll('a').length).toBeGreaterThan(3);
  expect(section.textContent).toContain("Produced by:");
  expect(section.textContent).toContain("Consumed by reviews:");
});
test("prompt references are text and template declarations start collapsed", () => {
  inspect(); const section = screen.getByRole("region", { name: "Prompts" });
  expect(section.querySelector("a")).toBeNull();
  expect(section.querySelectorAll("details").length).toBeGreaterThan(0);
  expect(section.querySelector("details[open]")).toBeNull();
});
test("completion separates condition, fields and consumers including whole outcomes", () => {
  inspect(); const section = screen.getByRole("region", { name: "Completion" });
  for (const name of ["done_when", "Stage outcome fields", "Downstream consumers", "Whole-outcome readers"]) expect(within(section).getByRole("heading", { name })).toBeTruthy();
  expect(within(section).getAllByRole("link").some(link => link.getAttribute("href")?.includes("/units/integration"))).toBe(true);
});
