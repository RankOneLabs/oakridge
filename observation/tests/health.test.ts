import { expect, test } from "bun:test";
import { Hono } from "hono";
import { registerHealthRoute, type GraderCapability, type HealthDependencies, type ObservationHealth } from "../src/http/health";
import { createApp } from "../src/http/app";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import type { Database } from "../src/storage/database";
import { integration, scratchDatabase } from "./grading-fixture";

/** A database that never answers: the pool of a server that stopped responding. It counts the probes it was handed. */
function hungDatabase(): { readonly db: Database; readonly started: () => number } {
  let started = 0;
  const db = { transaction: () => ({ execute: () => { started += 1; return new Promise(() => {}); } }) } as unknown as Database;
  return { db, started: () => started };
}

async function health(deps: HealthDependencies): Promise<{ status: number; body: ObservationHealth }> {
  const app = new Hono();
  registerHealthRoute(app, deps);
  const response = await app.request("/health");
  return { status: response.status, body: await response.json() as ObservationHealth };
}

test("an unreachable database reports degraded, separately from grader capability", async () => {
  expect(await health({ db: hungDatabase().db, database_check_ms: 20 })).toEqual({ status: 503, body: { service: "observation", status: "degraded",
    database: "unavailable", graders: { state: "none_configured" } } });
});

test("repeated probes of a hung database share the one query already pending", async () => {
  const hung = hungDatabase();
  const app = new Hono();
  registerHealthRoute(app, { db: hung.db, database_check_ms: 20 });
  for (let probe = 0; probe < 3; probe += 1) await app.request("/health");
  await Promise.all([app.request("/health"), app.request("/health")]);
  expect(hung.started()).toBe(1);
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
