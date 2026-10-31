import { expect, test } from "bun:test";
import { mapObservationEvent } from "../../../../oakridge-dbos/src/adapters/observation-mapping";
import type { Event } from "../../../../oakridge-dbos/src/core-client/core-types";
import type { CommittedEventRow, PinnedDefinitionRead } from "../../../../oakridge-dbos/src/storage/read-store";
import { readEventRevisionSequence } from "../../../../oakridge-dbos/src/storage/read-store";
import { artifactAddressToObservationRevision, resolveOccurrence } from "./revision-address";

test("artifact publication address agrees with the producer mapper", async () => {
  const event: Event = { kind: "revision_published", unit: "run-1/writing", artifact: "draft", body: "hello" };
  const row: CommittedEventRow<Event> = { id: "event-1", run_id: "run-1", unit_id: "run-1/writing",
    payload: event, created_at: new Date("2026-10-28T00:00:00Z"), commit_txid: "10",
    was_visible_at_subscription: false };
  const definition: PinnedDefinitionRead = { bundle_id: "bundle-1", digest: "bundle-a", archived_at: null,
    source: {} as PinnedDefinitionRead["source"], checked_program: { digest: "bundle-a", stages: ["writing"],
      workflow: { workflow: "test", input: { kind: "text" }, run: {} as PinnedDefinitionRead["checked_program"]["workflow"]["run"],
        schemas: {}, stages: { writing: { input: { kind: "text" }, artifacts: { draft: { schema: { kind: "text" } } },
          workers: {}, outcome: {} } } } } };
  const query = { select: () => query, where: () => query, executeTakeFirstOrThrow: async () => ({ count: 1 }) };
  const reader = { selectFrom: () => query } as unknown as Parameters<typeof readEventRevisionSequence>[0];
  const revision_sequence = await readEventRevisionSequence(reader, row, event.artifact);
  const mapped = mapObservationEvent({ row, definition, namespace: "development", stage: "writing", revision_sequence });
  const address = artifactAddressToObservationRevision({ run_id: "run-1", unit_id: event.unit,
    artifact_key: event.artifact, publication_ordinal: 1, namespace: "development" });
  expect(address.ok && mapped.kind === "artifact_revision" ? address.value : null)
    .toBe(mapped.kind === "artifact_revision" ? mapped.revision.source.revision_id : null);
});

test("an unmatched revision remains explicitly unresolved", () => {
  expect(resolveOccurrence("revision", [])).toEqual({ ok: true, value: { kind: "unresolved", revision_id: "revision" } });
});
