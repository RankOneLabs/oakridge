import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerHealthRoute, type GraderCapability, type HealthDependencies, type ObservationHealth } from "../src/http/health";
import { createApp } from "../src/http/app";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import type { Database } from "../src/storage/database";
import { integration, scratchDatabase } from "./grading-fixture";

/** A database that never answers: the pool of a server that stopped responding. */
const hungDatabase = { getExecutor: () => { throw new Error("no connection"); } } as unknown as Database;

async function health(deps: HealthDependencies): Promise<{ status: number; body: ObservationHealth }> {
  const app = new Hono();
  registerHealthRoute(app, deps);
  const response = await app.request("/health");
  return { status: response.status, body: await response.json() as ObservationHealth };
}

test("an unreachable database reports degraded, separately from grader capability", async () => {
  expect(await health({ db: hungDatabase, database_check_ms: 20 })).toEqual({ status: 503, body: { service: "observation", status: "degraded",
    database: "unavailable", graders: { state: "none_configured" } } });
});

integration("a running service with nothing registered reports no configured graders", async () => scratchDatabase(async (db) => {
  const app = createApp({ db, credentials: { ingest: [], read: [] }, profile: oakridgeProfile });
  const response = await app.request("/health");
  expect(await response.json()).toEqual({ service: "observation", status: "ok", database: "available", graders: { state: "none_configured" } });
}));

integration("registered capability comes from the service's composition, not its configuration", async () => scratchDatabase(async (db) => {
  const graders: GraderCapability = { state: "configured", graders: [{ runner: "jev_direct", evaluator_definition_id: "evaluator-1" }] };
  expect((await health({ db, grader_capability: () => graders })).body.graders).toEqual(graders);
}));

integration("health carries no credential and needs none", async () => scratchDatabase(async (db) => {
  const app = createApp({ db, credentials: { ingest: [{ producer: "p", namespace: "n", token: "ingest-secret" }], read: [] }, profile: oakridgeProfile });
  const response = await app.request("/health");
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("ingest-secret");
}));
