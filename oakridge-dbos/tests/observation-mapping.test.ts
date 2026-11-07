import { expect, test } from "bun:test";
import { CORE_PROTOCOL_SCHEMA, type Event } from "../src/core-client/core-types";
import { artifactSchemaVersion } from "../src/adapters/observation-schema-version";
import { DELIBERATELY_UNMAPPED_EVENTS, MAPPED_EVENTS, mapObservationEvent } from "../src/adapters/observation-mapping";
import { runOps } from "../src/ops";
import type { CommittedEventRow, CommittedRunConfig, PinnedDefinitionRead } from "../src/storage/read-store";

const definition = (schema: unknown, digest = "bundle-a"): PinnedDefinitionRead => ({
  definition_id: digest as PinnedDefinitionRead["definition_id"], operation_registry_id: "0" as PinnedDefinitionRead["operation_registry_id"], prompts: {}, operations: [], schema_names: [], stage_names: [], source: {} as PinnedDefinitionRead["source"],
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
    namespace: "test", stage: "writing", revision_sequence: null, run_config: null });
  const artifact = mapObservationEvent({ row: row({ kind: "revision_published", unit: "run-1/writing", artifact: "unknown", body: "a" }),
    definition: definition({ kind: "text" }), namespace: "test", stage: "writing", revision_sequence: 1, run_config: null });
  expect([unknown.kind, artifact.kind, unknown.event_id, artifact.run_id]).toEqual(["unmapped", "unmapped", "event-1", "run-1"]);
});

for (const decision of ["accept", "request_changes"]) test(`an operator ${decision} maps to ignored and carries no decision content`, () => {
  const outcome = mapObservationEvent({ row: row({ kind: "operator_decided", unit: "run-1/writing", review: "editor",
    decision, target: "rev-1", payload: { note: "revise" } }), definition: null, namespace: "test", stage: null, revision_sequence: null, run_config: null });
  expect(outcome).toEqual({ format: "observation.source-event/v1", definition_id: null, artifact_schema_version: null,
    kind: "ignored", event_kind: "operator_decided", run_id: "run-1", event_id: "event-1" });
});

test("no adapter or ops command remains for the retired observation surfaces", async () => {
  expect(Object.keys(await import("../src/adapters/observation")).sort()).toEqual(["publishObservationOnce", "startObservationPublisher"]);
  await expect(runOps(["observation-backfill", "10"], "postgres://unused")).rejects.toThrow("usage: ops");
});

const launched = (run_config: CommittedRunConfig) => mapObservationEvent({ row: row({ kind: "launched", input: { topic: "t" } }),
  definition: definition({ kind: "text" }), namespace: "test", stage: null, revision_sequence: null, run_config });

test("a launch carries its exact committed config beside its input", () => {
  const config = { sessions: { writing: { author: { harness: "codex", model: "gpt-5.5", effort: null } } }, grading_enabled: true };
  const on = launched({ state: "committed", config });
  const off = launched({ state: "committed", config: { sessions: {}, grading_enabled: false } });
  expect([on.kind === "run_input" ? [on.input, on.config] : on.kind, off.kind === "run_input" ? off.config : off.kind]).toEqual([
    [{ topic: "t" }, config], { sessions: {}, grading_enabled: false }]);
});

test("a launch that committed no config carries none, and a malformed one is unmapped", () => {
  const none = launched({ state: "none" });
  const malformed = launched({ state: "malformed" });
  expect([none.kind === "run_input" ? none.config : none.kind, malformed.kind === "unmapped" ? malformed.reason : malformed.kind])
    .toEqual([null, "committed run config is malformed"]);
});
