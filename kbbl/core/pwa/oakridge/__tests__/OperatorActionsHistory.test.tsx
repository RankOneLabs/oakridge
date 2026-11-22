import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { OperatorActionsHistory } from "../components/molecules/OperatorActionsHistory";

test("a projected rejection displays the reason and operator", () => {
  render(<OperatorActionsHistory facts={[{
    decision_id: "decision-1", kind: "follow_up_rejected", item_id: "item", assignment_id: "assignment",
    round_id: null, reason: "The follow-up applies to another revision.", actor: "operator@example.com",
    created_at: "2026-10-01T09:00:00Z",
  }]} />);
  expect(screen.getByText("The follow-up applies to another revision.")).toBeTruthy();
  expect(screen.getByText(/operator@example.com/)).toBeTruthy();
  expect(screen.getByText("Follow-up rejected")).toBeTruthy();
});
