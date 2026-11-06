import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { seedGradingRecords } from "./schema-fixture";
import { evidence, question, scratchGrading, tenant } from "./grading-fixture";

test("question and evidence readback requires read authority and hides other tenants", () => scratchGrading(async (db, occurrence_id) => {
  const evidence_set_id = await seedGradingRecords(db, occurrence_id);
  const app = createApp({ db, credentials: { ingest: [{ ...tenant, token: "ingest" }],
    read: [{ ...tenant, token: "read" }, { ...tenant, namespace: "other", token: "other" }] } });
  const paths = ["/v1/questions/relevance/versions/1", `/v1/evidence-sets/${encodeURIComponent(evidence_set_id)}`];
  for (const path of paths) {
    for (const token of [null, "invalid", "ingest"]) {
      expect((await app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} })).status).toBe(403);
    }
    expect((await app.request(path, { headers: { authorization: "Bearer other" } })).status).toBe(404);
    expect((await app.request(`${path}-missing`, { headers: { authorization: "Bearer read" } })).status).toBe(404);
  }
  expect(await (await app.request(paths[0]!, { headers: { authorization: "Bearer read" } })).json())
    .toMatchObject({ question_id: question.question_id, item_kind: question.item_kind });
  expect(await (await app.request(paths[1]!, { headers: { authorization: "Bearer read" } })).json())
    .toMatchObject({ evidence_set_id, subject_occurrence_id: occurrence_id, question_id: question.question_id,
      evidence_refs: evidence.references, is_incomplete: false, incompleteness_reason: null });
}));
