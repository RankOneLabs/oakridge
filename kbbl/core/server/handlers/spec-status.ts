import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { getSpec } from "../../db/specs";
import { getEpicBySpec } from "../../db/epics";
import { countOpenDiscrepancies } from "../../db/spec-discrepancies";
import { taskTrackerEvents } from "../../db/events";
import type { Spec } from "../../types/task-tracker";

const PatchSpecInternalStatusSchema = z.object({
  internal_status: z.enum(["discrepancies", "review", "approved"]),
});

// Valid transitions: from → to
const SPEC_INTERNAL_TRANSITIONS: Record<string, string> = {
  "analyzing→discrepancies": "discrepancies",
  "discrepancies→review": "review",
  "review→approved": "approved",
};

interface SpecStatusRouteDeps {
  db: Database;
}

export function mountSpecStatusRoutes(app: Hono, deps: SpecStatusRouteDeps): void {
  const { db } = deps;

  app.patch("/specs/:id/internal-status", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = PatchSpecInternalStatusSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { internal_status: requestedStatus } = result.data;
    const spec_id = c.req.param("id");

    let updated: Spec | null = null;
    let emitApproved: { spec_id: string; epic_id: string } | null = null;

    const error = db.transaction((): string | null => {
      const spec = getSpec(db, spec_id);
      if (!spec) return "not_found";

      const transitionKey = `${spec.internal_status}→${requestedStatus}`;
      if (!SPEC_INTERNAL_TRANSITIONS[transitionKey]) return "invalid_transition";

      // discrepancies→review requires no open discrepancies
      if (spec.internal_status === "discrepancies" && requestedStatus === "review") {
        const openCount = countOpenDiscrepancies(db, spec_id);
        if (openCount > 0) return "has_open_discrepancies";
      }

      if (requestedStatus === "approved") {
        // Copy notes→final_notes atomically
        db.prepare(
          "UPDATE specs SET internal_status = 'approved', final_notes = notes WHERE id = ?",
        ).run(spec_id);

        const epic = getEpicBySpec(db, spec_id);
        if (epic) {
          emitApproved = { spec_id, epic_id: epic.id };
        }
      } else {
        db.prepare("UPDATE specs SET internal_status = ? WHERE id = ?").run(
          requestedStatus,
          spec_id,
        );
      }

      updated = getSpec(db, spec_id);
      return null;
    })();

    if (error === "not_found") return c.json({ error: "not found" }, 404);
    if (error === "invalid_transition") {
      return c.json({ error: "invalid internal_status transition" }, 409);
    }
    if (error === "has_open_discrepancies") {
      return c.json({ error: "cannot move to review while open discrepancies exist" }, 409);
    }

    if (emitApproved) {
      taskTrackerEvents.emit("spec.approved", emitApproved);
    }

    return c.json(updated);
  });
}
