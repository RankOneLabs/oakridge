import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import type { Database } from "../src/storage/database";
import { evaluatorIdentity } from "../src/grading/evaluator";
import { registerEvaluator } from "../src/storage/grading-store";
import { evaluator, integration, oakridgeProfile, scratchDatabase, tenant } from "./grading-fixture";

const credentials = { ingest: [], read: [{ ...tenant, token: "read" },
  { ...tenant, namespace: "other", token: "other-read" }, { ...tenant, producer: "other", token: "foreign-read" }] };
const path = `/v1/evaluator-definitions/${encodeURIComponent("canonical-json/v1:pinned")}`;

test("historical definitions refuse missing or wrong credentials before storage", async () => {
  const app = createApp({ db: {} as Database, credentials, profile: oakridgeProfile });
  for (const token of ["", "wrong", "grade", "configure"])
    expect((await app.request(path, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
});

integration("historical evaluator read returns the complete pinned row only within its tenant", async () => scratchDatabase(async (db) => {
  const definition = { ...evaluator("model", "canonical-json/v1:pinned"),
    cost_metadata: { estimated_cost_per_call: 0.1 }, seed: 42, attempt_controls: { max_attempts: 3 } };
  expect(await registerEvaluator(db, tenant, definition)).toEqual({ ok: true, value: undefined });
  const app = createApp({ db, credentials, profile: oakridgeProfile });
  const response = await app.request(path, { headers: { authorization: "Bearer read" } });
  const identity = evaluatorIdentity(definition);
  if (!identity.ok) throw new Error(identity.error.detail);
  expect([response.status, await response.json()]).toEqual([200, { ...definition, identity_digest: identity.value }]);
  for (const [url, token] of [[path, "other-read"], [path, "foreign-read"], ["/v1/evaluator-definitions/absent", "read"]])
    expect((await app.request(url!, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
}));
