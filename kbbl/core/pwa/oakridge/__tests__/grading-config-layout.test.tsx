import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { GradingConfigBrowser } from "../components/organisms/GradingConfigBrowser";
import { configRead } from "./grading-config-fixture";
import { selectWorkflowArtifactTargets } from "../lib/grading-applicability";
import fixture from "../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionSummary } from "../operator-contracts/projections/definition-view";
afterEach(cleanup);
const longId = "x".repeat(200);
function browser(id: string | null = longId) {
  const initial: import("../client-grading-config").GradingConfigurationRead = { ...configRead(), draft: { digest: "draft", document: { status: "draft", definitions: [{ id: "first" }, { id: longId, scope: "per_item", targets: [{ artifact: "brief", selector: "/build_items/*" }] }] } } };
  return render(<GradingConfigBrowser initial={initial} definitionId={id} workflowTargets={{ status: "ready", artifacts: selectWorkflowArtifactTargets(fixture.definition as unknown as OperatorDefinitionSummary) }} version={null} onNavigate={vi.fn()} onReload={vi.fn()} />);
}
it("keeps a compact selector and one selected summary in constrained responsive columns", () => {
  const { container } = browser();
  const aside = container.querySelector("aside");
  if (!aside?.parentElement) throw new Error("Missing definition selector grid");
  const grid = aside.parentElement;
  expect(grid.classList.contains("lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]")).toBe(true);
  expect(Array.from(grid.classList).some(name => name.startsWith("grid-cols-"))).toBe(false);
  expect(Array.from(grid.children).every(column => column.classList.contains("min-w-0"))).toBe(true);
  expect(within(aside).queryByTestId("grading-definition-summary")).toBeNull();
  const right = grid.children[1] as HTMLElement;
  expect(within(right).getAllByTestId("grading-definition-summary")).toHaveLength(1);
  expect(screen.getByRole("button", { name: `Edit ${longId}` }).getAttribute("aria-current")).toBe("true");
  expect((screen.getByLabelText("Definition id") as HTMLInputElement).value).toBe(longId);
  expect(within(right).getByTestId("grading-definition-summary").classList.contains("[overflow-wrap:anywhere]")).toBe(true);
  expect(screen.getByRole("button", { name: `Edit ${longId}` }).classList.contains("[overflow-wrap:anywhere]")).toBe(true);
});
it("shows reverse links to the producing stage and artifact contract", () => {
  browser();
  const region = screen.getByRole("region", { name: "Applies to workflow artifacts" });
  expect(region.textContent).toContain("development › brief › brief");
  expect(within(region).getAllByRole("link", { name: "brief" }).map(link => link.getAttribute("href")).some(href => href?.includes("artifact-brief"))).toBe(true);
});
it("falls back to the first definition for an unknown target", () => {
  browser("missing");
  expect(screen.getByText("Definition missing is not in the shared draft.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Edit first" }).getAttribute("aria-current")).toBe("true");
  expect(screen.getByText("No workflow artifact matches this definition's targets.")).toBeTruthy();
});
it("contains diff JSON with wrapping", () => {
  const { container } = browser();
  fireEvent.click(screen.getByRole("button", { name: "Compare with latest" }));
  expect(Array.from(container.querySelectorAll("pre")).every(pre => pre.classList.contains("whitespace-pre-wrap") && pre.classList.contains("break-all"))).toBe(true);
});
it("preserves the unsaved draft guard when following reverse links", async () => {
  const { acceptHashNavigation } = await import("../../lib/hash");
  browser();
  fireEvent.change(screen.getByLabelText("Definition id"), { target: { value: "changed" } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const link = within(screen.getByRole("region", { name: "Applies to workflow artifacts" })).getAllByRole("link")[0];
  const href = link?.getAttribute("href");
  if (!href) throw new Error("Missing reverse-link destination");
  window.history.replaceState(null, "", href);
  expect(acceptHashNavigation()).toBe(false);
  expect(confirm).toHaveBeenCalled();
  confirm.mockRestore();
});
it("wraps version JSON while showing the selected published definition's reverse links", () => {
  const initial = configRead();
  render(<GradingConfigBrowser initial={{ ...initial, selected: initial.latest }} version={3} onNavigate={vi.fn()} onReload={vi.fn()} />);
  expect(screen.getByText("Published version 3 · read-only")).toBeTruthy();
  const json = screen.getByText("Definition sections (read-only JSON)").parentElement?.querySelector("pre");
  expect(json?.classList.contains("whitespace-pre-wrap")).toBe(true);
  expect(json?.classList.contains("break-all")).toBe(true);
});
it("parses the encoded shared editor definition target", async () => {
  const { readHashRoute } = await import("../../lib/hash");
  expect(readHashRoute("#settings/workflows/grading-config/definitions/brief.build_item%20correctness", "")).toEqual({ view: "settings", route: { sub: "grading-config", version: null, definitionId: "brief.build_item correctness" } });
});
