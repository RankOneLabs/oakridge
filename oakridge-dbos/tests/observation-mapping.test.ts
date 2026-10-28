import { expect, test } from "bun:test";
import { CORE_PROTOCOL_SCHEMA, type Event } from "../src/core-client/core-types";
import { artifactSchemaVersion } from "../src/adapters/observation-schema-version";
import { DELIBERATELY_UNMAPPED_EVENTS, MAPPED_EVENTS, mapObservationEvent } from "../src/adapters/observation-mapping";
import type { CommittedEventRow, PinnedDefinitionRead } from "../src/storage/read-store";

const definition = (schema: unknown, digest = "bundle-a"): PinnedDefinitionRead => ({
  bundle_id: "bundle-1", digest, archived_at: null, source: {} as PinnedDefinitionRead["source"],
  checked_program: { digest, stages: ["writing"], workflow: { workflow: "test", input: { kind: "text" },
    run: {} as PinnedDefinitionRead["checked_program"]["workflow"]["run"], schemas: {},
    stages: { writing: { input: { kind: "text" }, artifacts: { draft: { schema: schema as { kind: "text" } } },
      workers: {}, outcome: {} } } } },
});
const row = (payload: Event): CommittedEventRow<Event> => ({ id: "event-1", run_id: "run-1", unit_id: "run-1/writing",
  payload, created_at: new Date("2026-10-28T00:00:00Z"), commit_txid: "10", was_visible_at_subscription: false });

test("schema digest changes with the artifact declaration, not the bundle digest", () => {
  const original = artifactSchemaVersion(definition({ kind: "text" }), "writing", "draft");
  expect({ prompt_edit: artifactSchemaVersion(definition({ kind: "text" }, "bundle-prompt-edit"), "writing", "draft"),
    type_edit: artifactSchemaVersion(definition({ kind: "integer" }), "writing", "draft") === original })
    .toEqual({ prompt_edit: original, type_edit: false });
});

test("every current event variant is explicitly mapped or deliberately excluded", () => {
  const coreEventKinds = CORE_PROTOCOL_SCHEMA.request.$defs.Event.oneOf.map((variant) => variant.properties.kind.const);
  expect([...MAPPED_EVENTS, ...DELIBERATELY_UNMAPPED_EVENTS].sort()).toEqual(coreEventKinds.sort());
});

test("new variants and unknown artifact declarations become unmapped outcomes", () => {
  const unknown = mapObservationEvent({ row: row({ kind: "future_event" } as unknown as Event), definition: definition({ kind: "text" }),
    namespace: "test", stage: "writing", revision_sequence: null });
  const artifact = mapObservationEvent({ row: row({ kind: "revision_published", unit: "run-1/writing", artifact: "unknown", body: "a" }),
    definition: definition({ kind: "text" }), namespace: "test", stage: "writing", revision_sequence: 1 });
  expect([unknown.kind, artifact.kind, unknown.event_id, artifact.run_id]).toEqual(["unmapped", "unmapped", "event-1", "run-1"]);
});

test("an operator decision carries human evaluator and intact feedback", () => {
  const feedback = { note: "revise" };
  const outcome = mapObservationEvent({ row: row({ kind: "operator_decided", unit: "run-1/writing", review: "editor",
    decision: "request_changes", target: "rev-1", payload: feedback }), definition: null, namespace: "test", stage: null, revision_sequence: null });
  expect(outcome).toMatchObject({ kind: "human_grade", event_kind: "operator_decided", run_id: "run-1", event_id: "event-1",
    evaluator: { kind: "human" }, unit: "run-1/writing", review: "editor", decision: "request_changes", target: "rev-1", feedback });
});
