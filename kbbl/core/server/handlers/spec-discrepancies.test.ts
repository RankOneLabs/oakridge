import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../db/test-db";
import { insertProject } from "../../db/projects";
import { insertSpec } from "../../db/specs";
import { insertSpecDiscrepancy } from "../../db/spec-discrepancies";
import { mountSpecDiscrepanciesRoutes } from "./spec-discrepancies";
import type { SpecDiscrepancy } from "../../types/task-tracker";

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";

const MINIMAL_BODY = {
  spec_id: SPEC_ID,
  spec_assumption: "Auth returns 200 on success",
  code_reality: "Auth returns 204 on success",
};

let db: Database;
let app: Hono;

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(path: string) {
  return app.request(path, { method: "DELETE" });
}

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/p" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
  app = new Hono();
  mountSpecDiscrepanciesRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

describe("POST /spec-discrepancies", () => {
  test("201 with discrepancy row on valid body", async () => {
    const res = await post("/spec-discrepancies", MINIMAL_BODY);
    expect(res.status).toBe(201);
    const body = (await res.json()) as SpecDiscrepancy;
    expect(body.spec_id).toBe(SPEC_ID);
    expect(body.spec_assumption).toBe(MINIMAL_BODY.spec_assumption);
    expect(body.code_reality).toBe(MINIMAL_BODY.code_reality);
    expect(body.status).toBe("open");
    expect(body.resolution).toBeNull();
    expect(body.id).toBeDefined();
  });

  test("400 on missing spec_assumption", async () => {
    const { spec_assumption: _omit, ...noAssumption } = MINIMAL_BODY;
    const res = await post("/spec-discrepancies", noAssumption);
    expect(res.status).toBe(400);
  });

  test("400 on invalid json", async () => {
    const res = await app.request("/spec-discrepancies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("404 when spec_id FK fails", async () => {
    const res = await post("/spec-discrepancies", { ...MINIMAL_BODY, spec_id: "no-such-spec" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/spec not found/);
  });
});

describe("GET /spec-discrepancies", () => {
  test("400 when spec_id param missing", async () => {
    const res = await app.request("/spec-discrepancies");
    expect(res.status).toBe(400);
  });

  test("returns empty array when none exist", async () => {
    const res = await app.request(`/spec-discrepancies?spec_id=${SPEC_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("returns discrepancies for spec", async () => {
    await post("/spec-discrepancies", MINIMAL_BODY);
    const res = await app.request(`/spec-discrepancies?spec_id=${SPEC_ID}`);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as SpecDiscrepancy[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spec_id).toBe(SPEC_ID);
  });
});

describe("GET /spec-discrepancies/:id", () => {
  test("404 for unknown id", async () => {
    const res = await app.request("/spec-discrepancies/nope");
    expect(res.status).toBe(404);
  });

  test("200 with row after POST", async () => {
    const postRes = await post("/spec-discrepancies", MINIMAL_BODY);
    const created = (await postRes.json()) as SpecDiscrepancy;

    const getRes = await app.request(`/spec-discrepancies/${created.id}`);
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as SpecDiscrepancy;
    expect(body.id).toBe(created.id);
    expect(body.status).toBe("open");
  });
});

describe("PATCH /spec-discrepancies/:id", () => {
  test("409 when status is already resolved", async () => {
    insertSpecDiscrepancy(db, {
      id: "d-resolved",
      spec_id: SPEC_ID,
      spec_assumption: "A",
      code_reality: "B",
      resolution: "fixed",
      status: "resolved",
    });
    const res = await patch("/spec-discrepancies/d-resolved", {
      resolution: "re-fixed",
      status: "resolved",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not open/);
  });

  test("409 when status is already waived", async () => {
    insertSpecDiscrepancy(db, {
      id: "d-waived",
      spec_id: SPEC_ID,
      spec_assumption: "A",
      code_reality: "B",
      resolution: "waived",
      status: "waived",
    });
    const res = await patch("/spec-discrepancies/d-waived", {
      resolution: "try again",
      status: "resolved",
    });
    expect(res.status).toBe(409);
  });

  test("200 with updated row on valid patch of open discrepancy", async () => {
    const postRes = await post("/spec-discrepancies", MINIMAL_BODY);
    const created = (await postRes.json()) as SpecDiscrepancy;

    const patchRes = await patch(`/spec-discrepancies/${created.id}`, {
      resolution: "Spec was wrong, 204 is correct",
      status: "resolved",
    });
    expect(patchRes.status).toBe(200);
    const body = (await patchRes.json()) as SpecDiscrepancy;
    expect(body.status).toBe("resolved");
    expect(body.resolution).toBe("Spec was wrong, 204 is correct");
  });

  test("400 on missing resolution", async () => {
    const postRes = await post("/spec-discrepancies", MINIMAL_BODY);
    const created = (await postRes.json()) as SpecDiscrepancy;
    const res = await patch(`/spec-discrepancies/${created.id}`, { status: "resolved" });
    expect(res.status).toBe(400);
  });

  test("400 on missing status", async () => {
    const postRes = await post("/spec-discrepancies", MINIMAL_BODY);
    const created = (await postRes.json()) as SpecDiscrepancy;
    const res = await patch(`/spec-discrepancies/${created.id}`, { resolution: "fixed" });
    expect(res.status).toBe(400);
  });

  test("404 for unknown id", async () => {
    const res = await patch("/spec-discrepancies/nope", {
      resolution: "fixed",
      status: "resolved",
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /spec-discrepancies/:id", () => {
  test("204 on successful delete", async () => {
    const postRes = await post("/spec-discrepancies", MINIMAL_BODY);
    const created = (await postRes.json()) as SpecDiscrepancy;

    const delRes = await del(`/spec-discrepancies/${created.id}`);
    expect(delRes.status).toBe(204);

    // Verify gone
    const getRes = await app.request(`/spec-discrepancies/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  test("404 for unknown id", async () => {
    const res = await del("/spec-discrepancies/nope");
    expect(res.status).toBe(404);
  });

  test("delete is unrestricted (can delete resolved discrepancy)", async () => {
    insertSpecDiscrepancy(db, {
      id: "d-resolved",
      spec_id: SPEC_ID,
      spec_assumption: "A",
      code_reality: "B",
      resolution: "fixed",
      status: "resolved",
    });
    const res = await del("/spec-discrepancies/d-resolved");
    expect(res.status).toBe(204);
  });
});
