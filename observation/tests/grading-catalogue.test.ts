import { expect, test } from "bun:test";
import type { JsonValue } from "../src/domain/primitives";
import { Hono } from "hono";
import { z } from "zod";
import { gradingCatalogue, registerGradingConfigRoutes } from "../src/http/grading-config";
import { runnerRegistry } from "../src/grading/runner";
import { oakridgeGradingRegistry } from "../src/producers/oakridge/profile";

test("catalogue exposes every registered selector, capability contract and retained runner", () => {
  const catalogue = gradingCatalogue(oakridgeGradingRegistry, runnerRegistry);
  expect(catalogue.selectors).toEqual(oakridgeGradingRegistry.selectors);
  expect(catalogue.evidence_capabilities).toEqual(Object.entries(oakridgeGradingRegistry.capabilities).map(([name, capability]) => ({
    name, subject_requirements: capability.subject, params_schema: z.toJSONSchema(capability.params) as JsonValue,
  })));
  expect(catalogue.runners).toEqual(["jev_direct", "fastino_glide", "llm_judge"]);
});

test("catalogue requires configure and performs no store, publication or runtime IO", async () => {
  const app = new Hono();
  // Any access to these dependencies fails: catalogue must be a pure registry read.
  const unused = new Proxy({}, { get: () => { throw new Error("unexpected IO"); } });
  registerGradingConfigRoutes(app, { registry: oakridgeGradingRegistry, env: {},
    credentials: { ingest: [], read: [], configure: [{ token: "configure" }] },
    store: unused as Parameters<typeof registerGradingConfigRoutes>[1]["store"],
    runtime: unused as Parameters<typeof registerGradingConfigRoutes>[1]["runtime"],
    publication: unused as Parameters<typeof registerGradingConfigRoutes>[1]["publication"] });
  for (const token of ["", "wrong", "read", "grade"])
    expect((await app.request("/v1/grading-config/catalogue", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  const response = await app.request("/v1/grading-config/catalogue", { headers: { authorization: "Bearer configure" } });
  expect([response.status, await response.json()]).toEqual([200, gradingCatalogue(oakridgeGradingRegistry, runnerRegistry)]);
});
