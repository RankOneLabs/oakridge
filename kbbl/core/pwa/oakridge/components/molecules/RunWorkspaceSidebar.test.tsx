import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RunWorkspaceSidebar } from "./RunWorkspaceSidebar";
import { paneSelectionName } from "../../lib/pane-selection";
import type { ArtifactId, Sid } from "../../../lib/ids";
import type { RunArtifactRef } from "../../lib/run-overview";

afterEach(cleanup);
it("marks primary session and secondary artifact rows by slot", () => {
  const artifact: RunArtifactRef = { artifact_id: "A" as ArtifactId, type_id: "test", stage_name: "build", version: 1, label: null, created_at: null };
  render(<RunWorkspaceSidebar
    isOpen workspace={{ primary: { kind: "session", session_id: "S" as Sid }, secondary: { kind: "artifact", artifact_id: artifact.artifact_id } }}
    sessions={{ rows: [{ session_id: "S" as Sid, is_archived: false, work_order_id: "work", stage_key: "build", display_label: "Builder", unit_id: "unit", attempt_label: "attempt 1", work_order_state: "completed", is_current: true, requires_operator_action: false }], is_action_state_known: true, is_session_list_known: true }}
    artifacts={[artifact]} onOpenPane={() => {}} onCollapse={() => {}}
    hideEnded={{ eligibleCount: 0, isArmed: false, isPending: false, outcome: undefined, onPress() {} }}
    renderRow={(row, slots) => <li key={row.session_id} data-testid="session" data-pane-selection={paneSelectionName(slots)} />}
  />);
  expect(screen.getByTestId("session").getAttribute("data-pane-selection")).toBe("primary");
  expect(screen.getByTestId("or-sidebar-artifact").getAttribute("data-pane-selection")).toBe("secondary");
});
