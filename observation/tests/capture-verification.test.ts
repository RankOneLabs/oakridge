import { expect, test } from "bun:test";
import { verifyDbosCapture } from "../scripts/verify-dbos-capture";
import { createApp } from "../src/http/app";
import { scratchGrading } from "./grading-fixture";
import type { SourceEventDelivery } from "../src/ingest/cursor";

test("capture verification fails loudly without the ingest token", async () => {
  await expect(verifyDbosCapture({ run_id: "reviewed", url: "http://observation", ingest_token: "", read_token: "read" }))
    .rejects.toThrow("OAKRIDGE_OBSERVATION_INGEST_TOKEN is required");
});
const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("the real recorded DBOS delivery corpus produces readable revisions, occurrences and relations for its reviewed run", () => scratchGrading(async (db) => {
  const files = await Bun.file(new URL("../verification/latest.json", import.meta.url)).json() as { capture: string };
  const deliveries = await Bun.file(new URL(`../../${files.capture}`, import.meta.url)).json() as SourceEventDelivery[];
  const artifact = deliveries.find((row) => row.outcome.kind === "artifact_revision")?.outcome;
  if (!artifact || artifact.kind !== "artifact_revision") throw new Error("recorded corpus has no artifact capture");
  const capturedTenant = { producer: "oakridge", namespace: artifact.revision.source.namespace };
  const app = createApp({ db, credentials: { ingest: [{ ...capturedTenant, token: "ingest" }], read: [{ ...capturedTenant, token: "read" }] } });
  for (const delivery of deliveries) {
    const response = await app.request("/v1/sources/oakridge/events", { method: "POST", headers: { authorization: "Bearer ingest" }, body: JSON.stringify(delivery) });
    expect(response.status).toBe(200);
  }
  const transport = ((url: string | URL | Request, init?: RequestInit) => app.request(url, init)) as typeof fetch;
  const result = await verifyDbosCapture({ run_id: deliveries[0]!.outcome.run_id, url: "http://observation", ingest_token: "ingest", read_token: "read" }, transport);
  expect(result.occurrence_count).toBeGreaterThan(0);
  expect(result.revisions.length).toBeGreaterThan(0);
  expect(result.relation_count).toBeGreaterThan(0);
  await expect(verifyDbosCapture({ run_id: "uncaptured", url: "http://observation", ingest_token: "ingest", read_token: "read" }, transport))
    .rejects.toThrow("expected stored source revisions, item occurrences and item relations");
}));
