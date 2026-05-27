import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../db/test-db";
import { insertProject } from "../../db/projects";
import { insertSpec } from "../../db/specs";
import { insertEpic } from "../../db/epics";
import { insertSpecDiscrepancy } from "../../db/spec-discrepancies";
import { mountSpecStatusRoutes } from "./spec-status";
import { taskTrackerEvents } from "../../db/events";
import type { Spec } from "../../types/task-tracker";

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";
const EPIC_ID = "epic-1";

let db: Database;
let app: Hono;

function patch(path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/p" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
  insertEpic(db, {
    id: EPIC_ID,
    spec_id: SPEC_ID,
    project_id: PROJECT_ID,
    title: "S",
    status: "active",
    current_stage: "spec",
  });
  app = new Hono();
  mountSpecStatusRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

describe("PATCH /specs/:id/internal-status", () => {
  test("404 for unknown spec", async () => {
    const res = await patch("/specs/nope/internal-status", {
      internal_status: "discrepancies",
    });
    expect(res.status).toBe(404);
  });

  test("400 on invalid json", async () => {
    const res = await app.request(`/specs/${SPEC_ID}/internal-status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("400 on invalid internal_status value", async () => {
    const res = await patch(`/specs/${SPEC_ID}/internal-status`, {
      internal_status: "draft",
    });
    expect(res.status).toBe(400);
  });

  describe("analyzing → discrepancies", () => {
    test("200 with updated spec", async () => {
      const res = await patch(`/specs/${SPEC_ID}/internal-status`, {
        internal_status: "discrepancies",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Spec;
      expect(body.internal_status).toBe("discrepancies");
    });
  });

  describe("discrepancies → review", () => {
    beforeEach(async () => {
      await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "discrepancies" });
    });

    test("409 when open discrepancies exist", async () => {
      insertSpecDiscrepancy(db, {
        id: "d1",
        spec_id: SPEC_ID,
        spec_assumption: "A",
        code_reality: "B",
        status: "open",
      });
      const res = await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "review" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/open discrepancies/);
    });

    test("200 when all discrepancies are resolved/waived", async () => {
      insertSpecDiscrepancy(db, {
        id: "d2",
        spec_id: SPEC_ID,
        spec_assumption: "A",
        code_reality: "B",
        resolution: "fixed",
        status: "resolved",
      });
      const res = await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "review" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Spec;
      expect(body.internal_status).toBe("review");
    });

    test("200 with no discrepancies at all", async () => {
      const res = await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "review" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Spec;
      expect(body.internal_status).toBe("review");
    });
  });

  describe("review → approved", () => {
    beforeEach(async () => {
      await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "discrepancies" });
      await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "review" });
    });

    test("200 with approved spec and final_notes snapshot", async () => {
      // Set notes on spec first
      db.prepare("UPDATE specs SET notes = 'spec notes content' WHERE id = ?").run(SPEC_ID);

      const res = await patch(`/specs/${SPEC_ID}/internal-status`, {
        internal_status: "approved",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Spec;
      expect(body.internal_status).toBe("approved");
      expect(body.final_notes).toBe("spec notes content");
    });

    test("final_notes is null when notes is null at approval time", async () => {
      const res = await patch(`/specs/${SPEC_ID}/internal-status`, {
        internal_status: "approved",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Spec;
      expect(body.internal_status).toBe("approved");
      expect(body.final_notes).toBeNull();
    });

    test("emits spec.approved with spec_id and epic_id", async () => {
      let emitted: { spec_id: string; epic_id: string } | null = null;
      const unsub = taskTrackerEvents.subscribe("spec.approved", (payload) => {
        emitted = payload;
      });

      try {
        await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "approved" });
        expect(emitted).not.toBeNull();
        expect(emitted!.spec_id).toBe(SPEC_ID);
        expect(emitted!.epic_id).toBe(EPIC_ID);
      } finally {
        unsub();
      }
    });
  });

  describe("illegal transitions → 409", () => {
    test("analyzing → review is illegal", async () => {
      const res = await patch(`/specs/${SPEC_ID}/internal-status`, {
        internal_status: "review",
      });
      expect(res.status).toBe(409);
    });

    test("analyzing → approved is illegal", async () => {
      const res = await patch(`/specs/${SPEC_ID}/internal-status`, {
        internal_status: "approved",
      });
      expect(res.status).toBe(409);
    });

    test("review → discrepancies is illegal", async () => {
      await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "discrepancies" });
      await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "review" });
      const res = await patch(`/specs/${SPEC_ID}/internal-status`, {
        internal_status: "discrepancies",
      });
      expect(res.status).toBe(409);
    });

    test("approved → review is illegal", async () => {
      await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "discrepancies" });
      await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "review" });
      await patch(`/specs/${SPEC_ID}/internal-status`, { internal_status: "approved" });
      const res = await patch(`/specs/${SPEC_ID}/internal-status`, {
        internal_status: "review",
      });
      expect(res.status).toBe(409);
    });
  });
});
