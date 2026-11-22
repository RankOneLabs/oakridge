import { expect, test } from "bun:test";
import { INITIAL_DELIVERY_CURSOR, selectEventDelivery } from "../src/adapters/revision-delivery";
import type { PinnedDefinitionRead } from "../src/storage/read-store";

const event = { id: "event-1", run_id: "run", unit_id: "run/unit", created_at: new Date(0),
  was_visible_at_subscription: false, commit_txid: "1", namespace: "test", previous: INITIAL_DELIVERY_CURSOR,
  config: { sessions: {}, grading_enabled: false },
  payload: { kind: "revision_published" as const, unit: "run/unit", artifact: "body", body: "sample" },
};
const selection = { row: event, deliveries: [], revisions: [], definition: null };

test("a committed publication with no inserted revisions still delivers an empty revision event", () => {
  expect(selectEventDelivery(selection)).toMatchObject({ ok: true, value: { event: { kind: "revisions", revisions: [] } } });
});

test("delivery selects stored revision ids in ordinal order", () => {
  const definition = { definition_id: "definition", checked_program: { workflow: { stages: { stage: {
    artifacts: { body: { schema: { kind: "text" } } },
  } } } } } as unknown as PinnedDefinitionRead;
  const row = { run_id: "run", unit_id: "run/unit", stage: "stage", artifact: "body", body: "sample",
    predecessor_id: null, subject: null, origin_kind: "operator_edit" as const, by_action_id: null, by_seq: null,
    input_bindings: [], created_at: new Date(0) };
  const selected = selectEventDelivery({ row: event, deliveries: [{ ordinal: 1, revision_id: "r:2" }, { ordinal: 0, revision_id: "r:1" }],
    revisions: [{ ...row, id: "r:2" }, { ...row, id: "r:1" }], definition });
  expect(selected).toMatchObject({ ok: true, value: { event: { kind: "revisions",
    revisions: [{ revision_id: "r:1" }, { revision_id: "r:2" }],
  } } });
});

test("a delivery with no run returns a traced error", () => {
  expect(selectEventDelivery({ ...selection, row: { ...event, run_id: null } })).toEqual({
    ok: false, error: { operation: "select_event_delivery", entity_id: event.id, detail: "event has no run" },
  });
});

test("a delivery referencing a missing revision returns a traced error", () => {
  expect(selectEventDelivery({ ...selection, deliveries: [{ ordinal: 0, revision_id: "missing" }] })).toEqual({
    ok: false, error: { operation: "select_event_delivery", entity_id: "missing", detail: "missing stored revision" },
  });
});
