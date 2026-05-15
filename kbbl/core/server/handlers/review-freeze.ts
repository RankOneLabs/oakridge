import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { freeze, unfreeze } from "../../review/freeze";

const FreezeBodySchema = z.object({
  target_type: z.string().min(1),
  target_id: z.string().min(1),
});

interface ReviewFreezeRouteDeps {
  db: Database;
}

export function mountReviewFreezeRoutes(app: Hono, deps: ReviewFreezeRouteDeps): void {
  const { db } = deps;

  app.post("/review/freeze", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = FreezeBodySchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { target_type, target_id } = result.data;
    freeze(db, target_type, target_id);
    return c.json({ target_type, target_id, frozen: true });
  });

  app.post("/review/unfreeze", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = FreezeBodySchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { target_type, target_id } = result.data;
    unfreeze(db, target_type, target_id);
    return c.json({ target_type, target_id, frozen: false });
  });
}
