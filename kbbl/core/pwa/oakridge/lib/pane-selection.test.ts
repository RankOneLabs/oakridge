import { expect, it } from "vitest";
import { paneSelectionClass, selectPaneSlots } from "./pane-selection";
import type { Sid, ArtifactId } from "../../lib/ids";
import type { RunWorkspaceState } from "./run-workspace";

it("marks each selected slot with its corresponding thick border", () => {
  expect(paneSelectionClass({ inPrimary: false, inSecondary: false })).toBe("");
  const primary = paneSelectionClass({ inPrimary: true, inSecondary: false });
  expect(primary).toContain("bg-[var(--bg-elevated)]!");
  expect(primary).toContain("border-l-4!");
  expect(primary).not.toContain("border-r-4!");
  const secondary = paneSelectionClass({ inPrimary: false, inSecondary: true });
  expect(secondary).toContain("border-r-4!");
  expect(secondary).not.toContain("border-l-4!");
  expect(paneSelectionClass({ inPrimary: true, inSecondary: true })).toContain("border-l-4! border-r-4!");
});
it("matches session and artifact identities in their slots", () => {
  const state: RunWorkspaceState = { primary: { kind: "session", session_id: "S" as Sid }, secondary: { kind: "artifact", artifact_id: "A" as ArtifactId } };
  expect(selectPaneSlots(state, (pane) => pane.kind === "session" && pane.session_id === "S")).toEqual({ inPrimary: true, inSecondary: false });
  expect(selectPaneSlots(state, (pane) => pane.kind === "artifact" && pane.artifact_id === "A")).toEqual({ inPrimary: false, inSecondary: true });
});
