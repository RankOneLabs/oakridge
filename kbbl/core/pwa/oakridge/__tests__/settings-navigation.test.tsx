import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { App } from "../../App";
import { useGradingNavigationGuard } from "../hooks/useGradingNavigationGuard";
vi.mock("../hooks/useOakridgeConfig", () => ({ useOakridgeConfig: () => ({ data: { available: true }, isPending: false }) }));
vi.mock("../views/StatusView", () => ({ StatusView: () => <p>Oakridge status</p> }));
vi.mock("../../hooks/useInbox", () => ({ useInbox: () => {} }));
vi.mock("../../hooks/useServerConfig", () => ({ useServerConfig: () => null }));
vi.mock("../hooks/useReviewInbox", () => ({ useReviewInbox: () => ({ data: { items: [] } }) }));
vi.mock("../hooks/useOakridgeInvalidationStream", () => ({ useOakridgeInvalidationStream: () => {} }));
vi.mock("../hooks/useOakridgeRunEventStream", () => ({ useOakridgeRunEventStream: () => {} }));
vi.mock("../hooks/useWorkflowDefs", () => ({ useWorkflowDefs: () => ({ data: [], isPending: false, isError: false }) }));
vi.mock("../views/WorkflowDefDetailView", () => ({ WorkflowDefDetailView: () => <p>Workflow detail</p> }));
vi.mock("../views/RunListView", () => ({ RunListView: () => <p>Run list</p> }));
function Editor() {
  const [draft, setDraft] = useState("");
  useGradingNavigationGuard(draft !== "");
  return <input aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />;
}
vi.mock("../views/GradingConfigView", () => ({ GradingConfigView: () => <Editor /> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("keeps Primary destinations and only Status and Workflows under Settings", () => {
  history.replaceState(null, "", "#settings/workflows"); render(<App />);
  expect(within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("button").slice(0, 4).map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Runs", "Sessions", "Attention", "Settings"]);
  expect(screen.queryByRole("navigation", { name: "Oakridge" })).toBeNull();
  expect(within(screen.getByRole("navigation", { name: "Settings" })).getAllByRole("link").map((link) => link.textContent)).toEqual(["Status", "Workflows"]);
  expect(screen.getByRole("link", { name: "Workflows" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "Grading configuration" }).getAttribute("href")).toBe("#settings/workflows/grading-config");
});
it.each([false, true])("guards Primary Runs with confirmation=%s", async (accepted) => {
  history.replaceState(null, "", "#settings/workflows/grading-config"); vi.stubGlobal("confirm", vi.fn(() => accepted)); render(<App />);
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Local edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Runs" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalledWith("Discard unsaved local edits and open another view?"));
  expect(window.location.hash).toBe(accepted ? "#oakridge" : "#settings/workflows/grading-config");
  if (!accepted) expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("Local edit");
});
it.each([
  ["#oakridge/status", "#settings/status"],
  ["#oakridge/defs", "#settings/workflows"],
  ["#oakridge/defs/def%2F1", "#settings/workflows/def%2F1"],
  ["#oakridge/defs/d1/stages/a%2Fb#stage-a%2Fb-artifact-%24draft", "#settings/workflows/d1/stages/a%2Fb#stage-a%2Fb-artifact-%24draft"],
  ["#oakridge/def/d1/units/work/item", "#settings/workflows/d1/units/work/item"],
  ["#oakridge/grading-config", "#settings/workflows/grading-config"],
  ["#/oakridge/grading-config/versions/3", "#settings/workflows/grading-config/versions/3"],
])("replaces legacy %s with %s without growing history", async (legacy, target) => {
  history.replaceState(null, "", legacy); const length = history.length; render(<App />);
  await waitFor(() => expect(window.location.hash).toBe(target));
  expect(history.length).toBe(length);
  expect(screen.getByRole("button", { name: "Settings" }).className).toContain("app-surface-nav__item--active");
});
it("opens the editor from the real workflow list with Workflows active", async () => {
  history.replaceState(null, "", "#settings/workflows"); render(<App />);
  expect(screen.getByTestId("or-def-list")).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Grading configuration" }));
  await screen.findByLabelText("Draft");
  expect(window.location.hash).toBe("#settings/workflows/grading-config");
  expect(screen.getByRole("link", { name: "Workflows" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "Settings" }).className).toContain("app-surface-nav__item--active");
});
it("opens Status from the Primary Settings button", async () => {
  history.replaceState(null, "", "#oakridge"); render(<App />);
  expect(screen.getByRole("button", { name: "Runs" }).className).toContain("app-surface-nav__item--active");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByText("Oakridge status");
  expect(window.location.hash).toBe("#settings");
  expect(screen.getByRole("button", { name: "Settings" }).className).toContain("app-surface-nav__item--active");
});
it("keeps a dirty editor when the Settings Status link is declined", async () => {
  history.replaceState(null, "", "#settings/workflows/grading-config"); vi.stubGlobal("confirm", vi.fn(() => false)); render(<App />);
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Keep me" } });
  fireEvent.click(screen.getByRole("link", { name: "Status" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  expect(window.location.hash).toBe("#settings/workflows/grading-config");
  expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("Keep me");
});
