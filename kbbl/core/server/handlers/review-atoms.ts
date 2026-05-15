import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { reviewRegistry } from "../../review/registry";
import { reviewEvents } from "../../review/events";
import { isFrozen } from "../../review/freeze";
import { getLiveValue, appendEdit, listEdits } from "../../review/atoms";

const CreateEditSchema = z.object({
  target_type: z.string().min(1),
  target_id: z.string().min(1),
  anchor: z.string().nullable().optional(),
  prev_value: z.string().nullable(),
  new_value: z.string(),
  author: z.string().min(1),
});

interface ReviewAtomsRouteDeps {
  db: Database;
}

export function mountReviewAtomsRoutes(app: Hono, deps: ReviewAtomsRouteDeps): void {
  const { db } = deps;

  app.post("/atoms/edits", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = CreateEditSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { target_type, target_id, anchor = null, prev_value, new_value, author } = result.data;

    if (!reviewRegistry.isRegistered(target_type)) {
      return c.json({ error: "unregistered target_type" }, 409);
    }

    const entry = reviewRegistry.get(target_type)!;

    const anchorValidation = entry.validateAnchor(anchor ?? null);
    if (typeof anchorValidation === "string") {
      return c.json({ error: anchorValidation }, 400);
    }

    if (entry.exists !== undefined) {
      let exists: boolean;
      try {
        exists = await entry.exists(target_id);
      } catch (err) {
        console.error("review-atoms: exists callback failed", err);
        return c.json({ error: "registry exists callback failed" }, 500);
      }
      if (!exists) {
        return c.json({ error: "not found" }, 404);
      }
    }

    if (isFrozen(db, target_type, target_id)) {
      return c.json({ error: "artifact is frozen" }, 409);
    }

    const current_value = getLiveValue(db, target_type, target_id, anchor ?? null);
    if (prev_value !== current_value) {
      return c.json({ error: "stale prev_value", current_value }, 409);
    }

    const id = crypto.randomUUID();
    let edit: Awaited<ReturnType<typeof appendEdit>>;
    try {
      edit = appendEdit(db, {
        id,
        target_type,
        target_id,
        anchor: anchor ?? null,
        prior_value: prev_value,
        new_value,
        author,
      });
    } catch (err) {
      console.error("review-atoms:create failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    reviewEvents.emit("atom_edit.applied", {
      id: edit.id,
      target_type,
      target_id,
      anchor: anchor ?? null,
      new_value,
      author,
    });

    return c.json(edit, 201);
  });

  app.get("/atoms/edits", (c) => {
    const target_type = c.req.query("target_type");
    const target_id = c.req.query("target_id");
    if (!target_type || !target_id) {
      return c.json({ error: "target_type and target_id query params required" }, 400);
    }
    return c.json(listEdits(db, target_type, target_id));
  });
}
