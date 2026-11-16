import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { PrimaryNav } from "../../components/molecules/PrimaryNav";
import { useHashRoute } from "../../hooks/useHashRoute";
import { replaceHashRoute } from "../../lib/hash";
import { OakridgeShell } from "../OakridgeShell";
import { useGradingNavigationGuard } from "../hooks/useGradingNavigationGuard";
vi.mock("../hooks/useOakridgeConfig", () => ({ useOakridgeConfig: () => ({ data: { available: true }, isPending: false }) }));
vi.mock("../views/StatusView", () => ({ StatusView: () => <p>Oakridge status</p> }));
vi.mock("../views/WorkflowDefListView", () => ({ WorkflowDefListView: () => <a href="#settings/workflows/grading-config">Grading configuration</a> }));
vi.mock("../views/WorkflowDefDetailView", () => ({ WorkflowDefDetailView: () => <p>Workflow detail</p> }));
vi.mock("../views/RunListView", () => ({ RunListView: () => <p>Run list</p> }));
function Editor() {
  const [draft, setDraft] = useState("");
  useGradingNavigationGuard(draft !== "");
  return <input aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />;
}
vi.mock("../views/GradingConfigView", () => ({ GradingConfigView: () => <Editor /> }));
function Router() {
  const route = useHashRoute();
  useEffect(() => { if (route?.view === "redirect") replaceHashRoute(route.hash); }, [route]);
  return <><PrimaryNav activeSurface={route?.view === "settings" ? "settings" : "runs"} attentionCount={0} theme="dark" onToggleTheme={() => {}} onNavigate={(surface) => { window.location.hash = surface === "runs" ? "oakridge" : surface; }} />{(route?.view === "settings" || route?.view === "oakridge") && <OakridgeShell route={route.route} />}</>;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("keeps Primary destinations and only Status and Workflows under Settings", () => {
  history.replaceState(null, "", "#settings/workflows"); render(<Router />);
  expect(within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("button").slice(0, 4).map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Runs", "Sessions", "Attention", "Settings"]);
  expect(screen.queryByRole("navigation", { name: "Oakridge" })).toBeNull();
  expect(within(screen.getByRole("navigation", { name: "Settings" })).getAllByRole("link").map((link) => link.textContent)).toEqual(["Status", "Workflows"]);
  expect(screen.getByRole("link", { name: "Workflows" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "Grading configuration" }).getAttribute("href")).toBe("#settings/workflows/grading-config");
});
it.each([false, true])("guards Primary Runs with confirmation=%s", async (accepted) => {
  history.replaceState(null, "", "#settings/workflows/grading-config"); vi.stubGlobal("confirm", vi.fn(() => accepted)); render(<Router />);
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Local edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Runs" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalledWith("Discard unsaved local edits and open another view?"));
  expect(window.location.hash).toBe(accepted ? "#oakridge" : "#settings/workflows/grading-config");
  if (!accepted) expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("Local edit");
});
it.each(["status", "defs", "defs/d1", "def/d1/units/work/item", "grading-config", "grading-config/versions/3"])("replaces legacy %s without growing history", async (suffix) => {
  history.replaceState(null, "", `#oakridge/${suffix}`); const length = history.length; render(<Router />);
  await waitFor(() => expect(window.location.hash.startsWith("#settings/")).toBe(true));
  expect(history.length).toBe(length);
});
it("opens Status from the Primary Settings button", async () => {
  history.replaceState(null, "", "#oakridge"); render(<Router />);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  await screen.findByText("Oakridge status");
  expect(window.location.hash).toBe("#settings");
  expect(screen.getByRole("button", { name: "Settings" }).className).toContain("app-surface-nav__item--active");
});
it("keeps a dirty editor when the Settings Status link is declined", async () => {
  history.replaceState(null, "", "#settings/workflows/grading-config"); vi.stubGlobal("confirm", vi.fn(() => false)); render(<Router />);
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "Keep me" } });
  fireEvent.click(screen.getByRole("link", { name: "Status" }));
  await waitFor(() => expect(window.confirm).toHaveBeenCalled());
  expect(window.location.hash).toBe("#settings/workflows/grading-config");
  expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe("Keep me");
});
