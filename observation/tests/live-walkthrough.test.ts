import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCapturedRun } from "../scripts/jev-live-walkthrough";
import { readAllPages, selectGradeSubject } from "../scripts/live-grade-subject";
import { createApp } from "../src/http/app";
import type { SourceEventDelivery } from "../src/ingest/cursor";
import type { JsonValue } from "../src/domain/primitives";
import { initializeSourceCursor } from "../src/storage/capture-store";
import { registerQuestion } from "../src/storage/grading-store";
import type { ItemsPage } from "../src/storage/projection-store";
import { oakridgeQuestions } from "../src/grading/catalogue/oakridge-questions";
import { oakridgeDevelopmentCatalogue } from "../src/projection/catalogue/oakridge-development";
import { selectRevision } from "../src/projection/extractor";
import { occurrenceId } from "../src/projection/occurrence-id";
import { captureProjectedFixture, pilotExpectations, scratchGrading, tenant } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
if (!process.env.OAKRIDGE_TEST_DATABASE_URL) console.warn("SKIP: live-walkthrough boundary regressions; missing OAKRIDGE_TEST_DATABASE_URL");

async function withCapture(work: (path: string, deliveries: SourceEventDelivery[]) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "walkthrough-capture-"));
  try {
    const deliveries = await Bun.file(new URL("../verification/a670bcfbaa3045bc8d4415ac29222b73/capture.json", import.meta.url)).json() as SourceEventDelivery[];
    // A later run starts after the namespace's previously acknowledged event.
    deliveries[0] = { ...deliveries[0]!, previous: { commit_txid: "1", id: "earlier-run-event" } };
    const path = join(directory, "capture.json");
    await Bun.write(path, JSON.stringify(deliveries));
    await work(path, deliveries);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("a later run retains its nonzero starting cursor and every captured delivery", () => withCapture(async (path, deliveries) => {
  const captured = await readCapturedRun(path);
  expect(captured.starting_cursor).toEqual(deliveries[0]!.previous);
  expect(captured.deliveries).toEqual(deliveries);
}));

test("a nonzero starting cursor does not permit a gap in the captured event chain", () => withCapture(async (path, deliveries) => {
  deliveries[1] = { ...deliveries[1]!, previous: { commit_txid: "1", id: "wrong-previous-event" } };
  await Bun.write(path, JSON.stringify(deliveries));
  await expect(readCapturedRun(path)).rejects.toThrow("gap in its recorded cursor chain");
}));

integration("a new isolated namespace ingests a later launch without rewriting it or rewinding an existing cursor", () =>
  scratchGrading(async (db) => withCapture(async (path, deliveries) => {
    const captured = await readCapturedRun(path);
    const scope = { producer: "oakridge", namespace: captured.namespace };
    const app = createApp({ db, credentials: { ingest: [{ ...scope, token: "ingest" }], read: [] } });
    expect(await initializeSourceCursor(db, scope, captured.starting_cursor)).toBe(true);
    const response = await app.request("/v1/sources/oakridge/events", { method: "POST",
      headers: { authorization: "Bearer ingest", "content-type": "application/json" }, body: JSON.stringify(deliveries[0]) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cursor: deliveries[0]!.cursor });
    expect(await initializeSourceCursor(db, scope, captured.starting_cursor)).toBe(false);
    const cursor = await app.request("/v1/sources/oakridge/cursor", { headers: { authorization: "Bearer ingest" } });
    expect(await cursor.json()).toEqual({ cursor: deliveries[0]!.cursor });
    expect(await Bun.file(path).json()).toEqual(deliveries);
  })));

test("pagination reaches eligible rows after the first 200 entries", async () => {
  const offsets: number[] = [];
  const rows = await readAllPages(async (offset) => {
    offsets.push(offset);
    return { limit: 200, offset, total: 201,
      items: offset === 0 ? Array.from({ length: 200 }, () => "uncited") : ["eligible"] };
  });
  expect(offsets).toEqual([0, 200]);
  expect(rows.at(-1)).toBe("eligible");
});

test("pagination refuses a truncated listing rather than reporting no eligible subject", async () => {
  await expect(readAllPages(async (offset) => ({ limit: 200, offset, total: 201, items: [] })))
    .rejects.toThrow("listing ended before its reported total");
});

// The fixture mirrors the plan-cohort selection fields in development.yaml.
type FixtureCriterion = { id: string; text: string; task_ids: string[]; decision_ids: string[] };
function selectionPlan(criteria: readonly FixtureCriterion[]): JsonValue {
  return { cohorts: [{ id: "slice", decisions: [{ id: "decision", text: "Preserve the captured evidence." }],
    acceptance_criteria: criteria }] };
}

integration("an eligible latest-revision criterion is found beyond 200 older items and an earlier uncited candidate", () => scratchGrading(async (db) => {
  await captureProjectedFixture(db, { revision_id: "aa-old-plan", artifact_kind: "plan", body: selectionPlan(
    Array.from({ length: 201 }, (_, index) => ({ id: `old-${index}`, text: "Older criterion", task_ids: [], decision_ids: [] }))) });
  const revision_id = "zz-latest-plan";
  const criteria: FixtureCriterion[] = ["a", "b"].map((id) => ({ id, text: "Preserve the captured evidence.", task_ids: [], decision_ids: [] }));
  const pass = selectRevision(selectionPlan(criteria), revision_id, oakridgeDevelopmentCatalogue("plan", "1", { unit_id: "plan" }));
  const ranked = pass.items.filter(({ item }) => item.item_kind === "criterion").map(({ definition, item }) => {
    const id = occurrenceId({ ...tenant, revision_id, extractor_id: definition.extractor_id,
      extractor_version: definition.extractor_version, item_selector: item.item_selector, item_id_or_path: item.item_id_or_path });
    if (!id.ok) throw new Error(id.error.detail);
    return { occurrence_id: String(id.value), local_id: item.producer_local_id };
  }).sort((a, b) => a.occurrence_id.localeCompare(b.occurrence_id));
  const eligible_id = ranked[1]!.local_id;
  criteria.find((criterion) => criterion.id === eligible_id)!.decision_ids = ["decision"];
  await captureProjectedFixture(db, { revision_id, artifact_kind: "plan", body: selectionPlan(criteria) });
  const question = oakridgeQuestions(pilotExpectations)["plan.criterion_traceability"].definition;
  expect((await registerQuestion(db, tenant, question)).ok).toBe(true);
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }] } });
  const read = async (path: string) => {
    const response = await app.request(path, { headers: { authorization: "Bearer read" } });
    if (!response.ok) throw new Error(await response.text());
    return response;
  };
  const first = await (await read("/v1/runs/run-1/items?limit=200")).json() as ItemsPage;
  expect(first.total).toBeGreaterThan(200);
  expect(first.items.some((item) => item.revision_id === revision_id)).toBe(false);
  const all = await readAllPages<ItemsPage["items"][number]>(async (offset) =>
    (await read(`/v1/runs/run-1/items?limit=200&offset=${offset}`)).json() as Promise<ItemsPage>);
  expect(all.filter((item) => item.revision_id === revision_id && item.item_kind === "criterion")[0]!.producer_local_id)
    .not.toBe(eligible_id);
  const selected = await selectGradeSubject(read, { run_id: "run-1", revision_id, artifact_kind: "plan", question });
  expect(selected.producer_local_id).toBe(eligible_id);
}), 120_000);

integration("brief selection skips an unlinked criterion and uses its eligible plan link", () => scratchGrading(async (db) => {
  await captureProjectedFixture(db, { revision_id: "plan", artifact_kind: "plan", body: selectionPlan([
    { id: "linked", text: "Preserve the captured evidence.", task_ids: [], decision_ids: ["decision"] }]) });
  await captureProjectedFixture(db, { revision_id: "brief", artifact_kind: "brief", body: { cohort_id: "slice",
    decisions_made: [], approaches_rejected: [], acceptance_criteria: [
      { id: "unlinked", text: "No source criterion" }, { id: "linked", text: "Preserve the captured evidence." }] } });
  const question = oakridgeQuestions(pilotExpectations)["brief.source_fidelity"].definition;
  expect((await registerQuestion(db, tenant, question)).ok).toBe(true);
  const app = createApp({ db, credentials: { ingest: [], read: [{ ...tenant, token: "read" }] } });
  const selected = await selectGradeSubject(async (path) => {
    const response = await app.request(path, { headers: { authorization: "Bearer read" } });
    if (!response.ok) throw new Error(await response.text());
    return response;
  }, { run_id: "run-1", revision_id: "brief", artifact_kind: "brief", question });
  expect(selected.producer_local_id).toBe("linked");
}));
