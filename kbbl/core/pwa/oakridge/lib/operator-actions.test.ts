import { expect, it } from "vitest";
import type { OperatorActionHistoryEntry } from "../operator-contracts/projections/operator-actions";
import { selectOperatorActionRows } from "./operator-actions";

it("maps assessed and added actions newest first, preserving order within a decision", () => {
  const context = {
    unit_id: "unit", decision_id: "recorded", assessment_revision_id: "assessment", review: "assessment_review",
    decision: "request_build_changes", actor: { kind: "operator", subject: "reviewer" }, created_at: "2026-01-01T00:00:00Z", reason: null,
  } as const;
  const kept = { ...context, kind: "assessed", action_id: "keep", disposition: "accepted", original_text: "Keep this",
    final_text: null, source: { kind: "item_assessment", id: "B1" } } as const satisfies OperatorActionHistoryEntry;
  const edited = { ...kept, action_id: "edit", disposition: "modified", original_text: "Old", final_text: "New" } as const;
  const dropped = { ...kept, action_id: "drop", disposition: "rejected", original_text: "Drop this" } as const;
  const added = { ...context, kind: "added", action_id: "add", decision_id: "recent", actor: { kind: "engine" },
    final_text: "Add this", source: { kind: "additional_finding", id: "F1" }, created_at: "2026-01-02T00:00:00Z" } as const satisfies OperatorActionHistoryEntry;
  const row = { assessment_revision_id: context.assessment_revision_id, review: context.review, decision: context.decision,
    actor_label: "reviewer", source_label: "Item B1", created_at: context.created_at, final_text: null };
  expect(selectOperatorActionRows({ operator_actions: [kept, edited, dropped, added] })).toEqual([
    { ...row, key: "recent:add", disposition_label: "Added", original_text: null, final_text: "Add this",
      source_label: "Finding F1", actor_label: "engine", created_at: added.created_at },
    { ...row, key: "recorded:keep", disposition_label: "Kept", original_text: "Keep this" },
    { ...row, key: "recorded:edit", disposition_label: "Edited", original_text: "Old", final_text: "New" },
    { ...row, key: "recorded:drop", disposition_label: "Dropped", original_text: "Drop this" },
  ]);
});

it("returns no rows for a run without operator action history", () => {
  expect(selectOperatorActionRows({})).toEqual([]);
});
