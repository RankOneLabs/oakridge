import { expect, test } from "bun:test";
import type { CaptureEnvelope } from "../src/ingest/capture";
import type { SourceEventDelivery } from "../src/ingest/cursor";
import { createApp } from "../src/http/app";
import { withTenant } from "../src/storage/database";
import { listRunItems, readLineage } from "../src/storage/projection-store";
import { scratchGrading } from "./grading-fixture";

interface RunSlice { readonly run_id: string; readonly definition_id: string;
  readonly captures: readonly CaptureEnvelope[]; readonly deliveries: readonly SourceEventDelivery[] }
const fixture = await Bun.file(new URL("../fixtures/oakridge/run-slice/events.json", import.meta.url)).json() as RunSlice;
const tenant = { producer: "oakridge", namespace: "hand-authored" };
const credentials = { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }] };

test("the hand-authored slice captures and projects launch, analysis, tasks, plan, brief and assessment", () => scratchGrading(async (db) => {
  const app = createApp({ db, credentials });
  for (const delivery of fixture.deliveries) {
    const response = await app.request("/v1/sources/oakridge/events", { method: "POST",
      headers: { authorization: "Bearer ingest", "content-type": "application/json" }, body: JSON.stringify(delivery) });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { cursor: delivery.cursor } });
  }
  const page = await listRunItems(db, tenant, fixture.run_id, { limit: 200, offset: 0 });
  expect(page.issues.map((issue) => ({ extractor: issue.extractor_id, kind: issue.kind }))
    .sort((a, b) => a.extractor.localeCompare(b.extractor))).toEqual([
    "analysis.proposed_updates", "analysis.risks", "brief.rejected_approaches", "plan.acceptance_criteria", "plan.risks",
  ].map((extractor) => ({ extractor, kind: "no_matching_items" })));
  expect(page.items.filter((item) => item.item_kind === "finding")).toHaveLength(1);
  expect(page.items.filter((item) => item.item_kind === "criterion")).toHaveLength(4);
  const brief = page.items.find((item) => item.artifact_kind === "brief" && item.item_kind === "criterion")!;
  const lineage = await readLineage(db, tenant, brief.occurrence_id, { limit: 100, offset: 0 });
  expect(lineage?.edges.some((edge) => edge.type === "derived_from" && edge.target_occurrence_id !== null)).toBe(true);
  const row = await app.request(`/v1/source-revisions/${encodeURIComponent(fixture.captures[0]!.source.revision_id)}`,
    { headers: { authorization: "Bearer read" } });
  expect(await row.json()).toMatchObject({ body: fixture.captures[0]!.body, definition_id: fixture.definition_id });
  const outcomes = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_event_outcome")
    .select("event_id").where("namespace", "=", tenant.namespace).execute());
  expect(outcomes).toHaveLength(fixture.deliveries.length);
}));

test("the slice has only synthetic provenance and capture outcomes", async () => {
  const text = JSON.stringify(fixture);
  expect(fixture.definition_id).toMatch(/^[0-9a-f]{64}$/);
  expect(/gated_review|d8a33d15|7f0c84d3|7396dc12|human_grade/.test(text)).toBe(false);
  expect(fixture.deliveries.map((delivery) => delivery.outcome.kind)).toEqual([
    "run_input", "artifact_revision", "artifact_revision", "artifact_revision", "artifact_revision", "artifact_revision"]);
  expect(await Bun.file(new URL("../fixtures/oakridge/run-slice/PROVENANCE.md", import.meta.url)).text())
    .toContain("hand-authored with no tie to a recorded live grade");
});
