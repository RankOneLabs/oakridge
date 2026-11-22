import { expect, test } from "bun:test";
import { INITIAL_DELIVERY_CURSOR, selectEventDelivery } from "../src/adapters/revision-delivery";
import type { PinnedDefinitionRead } from "../src/storage/read-store";

const event = { id: "event-1", run_id: "run", unit_id: "run/unit", created_at: new Date(0),
  was_visible_at_subscription: false, commit_txid: "1", namespace: "test", previous: INITIAL_DELIVERY_CURSOR,
  config: { sessions: {}, grading_enabled: false },
  payload: { kind: "revision_published" as const, unit: "run/unit", artifact: "body", body: "sample" },
};
test("a committed publication with no inserted revisions still delivers an empty revision event", () => {
  expect(selectEventDelivery(event, [], [], null).event).toEqual({ kind: "revisions", revisions: [] });
});

test("delivery selects stored revision ids in ordinal order", () => {
  const definition = { definition_id: "definition", checked_program: { workflow: { stages: { stage: {
    artifacts: { body: { schema: { kind: "text" } } },
  } } } } } as unknown as PinnedDefinitionRead;
  const row = { run_id: "run", unit_id: "run/unit", stage: "stage", artifact: "body", body: "sample",
    predecessor_id: null, subject: null, origin_kind: "operator_edit" as const, by_action_id: null, by_seq: null,
    input_bindings: [], created_at: new Date(0) };
  const selected = selectEventDelivery(event, [{ ordinal: 1, revision_id: "r:2" }, { ordinal: 0, revision_id: "r:1" }],
    [{ ...row, id: "r:2" }, { ...row, id: "r:1" }], definition);
  expect(selected.event.kind === "revisions" && selected.event.revisions.map((revision) => revision.revision_id)).toEqual(["r:1", "r:2"]);
});
