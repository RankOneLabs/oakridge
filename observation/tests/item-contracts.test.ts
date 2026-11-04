import { expect, test } from "bun:test";
import { canonicalDigest } from "canonical-json";
import { registerGradingContext } from "../src/storage/grading-store";
import { createApp } from "../src/http/app";
import { withTenant } from "../src/storage/database";
import { scratchGrading, tenant, captureProjectedFixture, question, evidence, evaluator } from "./grading-fixture";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
const credentials = { ingest: [{ ...tenant, token: "ingest" }], read: [{ ...tenant, token: "read" }],
  grade: [{ ...tenant, token: "grade" }] };
const headers = { authorization: "Bearer read" };
integration("revision and path resolve the stored occurrence, with read authority and encoded slash ids", () => scratchGrading(async (db) => {
  const items = await captureProjectedFixture(db, { revision_id: "lookup", artifact_kind: "analysis", body: {
    findings: [{ id: "f", description: "A finding", severity: "info" }], requirements: [], spec_updates: [],
  } });
  const item = items.find((item) => item.item_kind === "finding")!;
  const app = createApp({ db, credentials });
  const path = `/v1/source-revisions/lookup/items?item_path=${encodeURIComponent(item.json_pointer!)}`;
  const looked = await app.request(path, { headers });
  const direct = await app.request(`/v1/items/${encodeURIComponent(item.occurrence_id)}`, { headers });
  expect({ status: looked.status, row: await looked.json() }).toEqual({ status: 200, row: await direct.json() });
  expect((await app.request(path, { headers: { authorization: "Bearer ingest" } })).status).toBe(403);
  expect((await app.request("/v1/source-revisions/lookup/items?item_path=/absent", { headers })).status).toBe(404);
}));

integration("job pages are bounded, validated and retain their offsets when a new job arrives", () => scratchGrading(async (db, occurrence_id) => {
  const app = createApp({ db, credentials });
  const path = `/v1/items/${encodeURIComponent(occurrence_id)}/evaluation-jobs`;
  expect((await registerGradingContext(db, tenant, { question, evidence, evaluator: evaluator("code") })).ok).toBe(true);
  const insert = (index: number) => withTenant(db, tenant, (trx) => trx.insertInto("observation.grading_job").values({
    ...tenant, job_id: `job-${index}`, subject_occurrence_id: occurrence_id, evidence_set_id: evidence.evidence_set_id, question_id: question.question_id, question_version: question.question_version,
    evaluator_definition_id: "code", config_digest: "c", attempt_label: String(index), idempotency_digest: (canonicalDigest(index) as { ok: true; value: string }).value,
    reviewed_commit: null, runner_name: "deterministic", run_id: "run-1", stage_id: "brief", state: "queued",
    lease_owner: null, lease_expires_at: null, retry_limit: 0, terminal_cause: null,
    created_at: new Date(1700000000000 + index),
  }).execute());
  for (let index = 0; index < 52; index++) await insert(index);
  const first = await (await app.request(path, { headers })).json() as { items: unknown[]; total: number };
  expect({ size: first.items.length, total: first.total }).toEqual({ size: 50, total: 52 });
  const before = await (await app.request(`${path}?limit=2&offset=2`, { headers })).json() as { items: unknown[] };
  await insert(52);
  const after = await (await app.request(`${path}?limit=2&offset=2`, { headers })).json() as { items: unknown[]; total: number };
  expect(after.items).toEqual(before.items);
  expect(after.total).toBe(53);
  for (const query of ["limit=0", "limit=201", "offset=-1", "limit=1.5"]) {
    const response = await app.request(`${path}?${query}`, { headers });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 400,
      body: { error: { code: "invalid_pagination", message: "limit must be 1..200 and offset nonnegative" } } });
  }
}));
