import { expect, test } from "bun:test";
import { createImplementationCohortHarness } from "./support/implementation-cohort-harness";
import { capabilityFor } from "../src/runtime/publication-capability";
import { publishWorkOrderArtifact } from "../src/runtime/publish-work-order-artifact";
import type { WorkOrderId, AttemptId, JsonValue } from "../src/domain/primitives";

const publicationFixture = async () => {
  const fixture = await createImplementationCohortHarness();
  await fixture.advance();
  const launch = await fixture.launch(0);
  const capability = capabilityFor(await fixture.records.load_work_order_capability_seed(), launch.attempt_id as unknown as WorkOrderId);
  const publish = (key: string, body: JsonValue) => publishWorkOrderArtifact({ attempt_id: launch.attempt_id as AttemptId,
    capability, output_name: "build_result", collection_key: null, body, idempotency_key: key }, { records: fixture.records, now: fixture.now });
  return { ...fixture, publish };
};

test("a lost publication response replays its durable artifact without adding a revision", async () => {
  const fixture = await publicationFixture();
  try {
    const body = { summary: "built" };
    const first = await fixture.publish("same", body);
    const second = await fixture.publish("same", body);
    expect(first.kind).toBe("published");
    expect(second).toMatchObject({ kind: "already_applied", artifact_id: "artifact_id" in first ? first.artifact_id : null });
    expect((await fixture.sql.query<{ readonly count: string }>("SELECT count(*)::text FROM oakridge.artifact WHERE artifact_type='dev.build_result'", []))[0]?.count).toBe("1");
  } finally { await fixture.close(); }
}, 30_000);

test("conflicting reuse of a publication identity preserves the original worker output", async () => {
  const fixture = await publicationFixture();
  try {
    await fixture.publish("same", { summary: "original" });
    expect(await fixture.publish("same", { summary: "different" })).toMatchObject({ kind: "idempotency_conflict" });
    expect((await fixture.sql.query<{ readonly body: JsonValue }>("SELECT artifact.body FROM oakridge.worker_output output JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id WHERE output.worker='build'", []))[0]?.body)
      .toEqual({ summary: "original" });
  } finally { await fixture.close(); }
}, 30_000);

test("concurrent competing bodies commit one immutable publication for the execution", async () => {
  const fixture = await publicationFixture();
  try {
    const results = await Promise.all([fixture.publish("one", { summary: "one" }), fixture.publish("two", { summary: "two" })]);
    expect(results.filter((result) => result.kind === "published")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "refused" || result.kind === "idempotency_conflict")).toHaveLength(1);
    const revisions = await fixture.sql.query<{ readonly revision: number; readonly lifecycle: string }>("SELECT revision,lifecycle FROM oakridge.artifact WHERE artifact_type='dev.build_result' ORDER BY revision", []);
    expect(revisions).toEqual([{ revision: 1, lifecycle: "current" }]);
  } finally { await fixture.close(); }
}, 30_000);
