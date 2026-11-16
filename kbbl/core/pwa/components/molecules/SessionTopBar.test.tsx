import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SessionTopBar } from "./SessionTopBar";
import { selectSessionHeaderSegments } from "../../lib/session";
import type { SessionSnapshot, Status } from "../../types";

afterEach(cleanup);
const snapshot = { status: "idle", name: "Session", projectWorkdir: "/repo", worktreeBranch: "kbbl/cohort-x", workflow: { runId: "run", unitId: "unit", worker: "builder" } } as SessionSnapshot;
it("derives role and branch, with stage only on pane chrome", () => {
  expect(selectSessionHeaderSegments({ snapshot, chrome: { kind: "route", onBack() {} } })).toEqual({ role: "Builder", branch: "cohort-x", stage: null });
  expect(selectSessionHeaderSegments({ snapshot: { ...snapshot, workflow: { runId: "run", unitId: "unit", worker: "spec_editor" } }, chrome: { kind: "pane", stage: "implement" } })).toEqual({ role: "Spec editor", branch: "cohort-x", stage: "implement" });
  expect(selectSessionHeaderSegments({ snapshot: { ...snapshot, workflow: null, worktreeBranch: null }, chrome: { kind: "route", onBack() {} } })).toEqual({ role: null, branch: null, stage: null });
});
it.each([
  ["connecting", "Connecting", "Connecting — opening the live update stream."],
  ["connected", "Connected", "Connected — receiving live updates."],
  ["disconnected", "Disconnected", "Disconnected — not receiving live updates."],
  ["stale", "Stale", "Stale — no update received recently; what you see may be out of date."],
] as const)("renders accessible %s connection chrome on the session route", (status: Status, label, description) => {
  render(<SessionTopBar sid="S" snapshot={snapshot} streamStatus={status} inboxStatus="disconnected" usage={null} chrome={{ kind: "route", onBack() {} }} />);
  const indicator = screen.getByTestId("session-connection-indicator");
  expect(indicator.getAttribute("role")).toBe("status");
  expect(indicator.getAttribute("aria-label")).toBe("Connection: " + label);
  expect(indicator.title).toBe(description);
  expect(indicator.classList.contains("status-" + status)).toBe(true);
  expect(indicator.querySelector(".sr-only")?.textContent).toBe(label);
  expect(screen.getByTestId("session-role").textContent).toBe("Builder");
  expect(screen.queryByTestId("session-stage")).toBeNull();
});
it("separates pane role stage and truncated branch while retaining the full title", () => {
  const branch = "x".repeat(120);
  render(<SessionTopBar sid="S" snapshot={{ ...snapshot, worktreeBranch: branch }} streamStatus="connected" inboxStatus="stale" usage={null} chrome={{ kind: "pane", stage: "implementation" }} />);
  expect(screen.getByTestId("session-role").parentElement?.textContent).toBe("Builder·implementation·" + branch);
  expect(screen.getByTestId("session-branch").classList.contains("truncate")).toBe(true);
  expect(screen.getByTestId("session-branch").title).toBe(branch);
});
