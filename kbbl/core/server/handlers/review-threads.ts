import { z } from "zod";
import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { reviewRegistry } from "../../review/registry";
import { reviewEvents } from "../../review/events";
import { isFrozen } from "../../review/freeze";
import {
  insertThread,
  getThread,
  listThreadsByArtifact,
  insertMessage,
  listMessagesByThread,
  updateThreadStatus,
} from "../../review/threads";

const CreateThreadSchema = z.object({
  target_type: z.string().min(1),
  target_id: z.string().min(1),
  anchor: z.string().nullable().optional(),
  author: z.string().nullable().optional(),
});

const CreateMessageSchema = z.object({
  body: z.string().min(1),
  author: z.string().min(1),
});

const PatchThreadSchema = z.object({
  status: z.literal("resolved"),
});

interface ReviewThreadsRouteDeps {
  db: Database;
}

export function mountReviewThreadsRoutes(app: Hono, deps: ReviewThreadsRouteDeps): void {
  const { db } = deps;

  app.post("/threads", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = CreateThreadSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { target_type, target_id, anchor = null, author = null } = result.data;

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
        console.error("review-threads: exists callback failed", err);
        return c.json({ error: "registry exists callback failed" }, 500);
      }
      if (!exists) {
        return c.json({ error: "not found" }, 404);
      }
    }

    if (isFrozen(db, target_type, target_id)) {
      return c.json({ error: "artifact is frozen" }, 409);
    }

    const id = crypto.randomUUID();
    let thread: Awaited<ReturnType<typeof insertThread>>;
    try {
      thread = insertThread(db, { id, target_type, target_id, anchor: anchor ?? null, author: author ?? null });
    } catch (err) {
      console.error("review-threads:create failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    reviewEvents.emit("thread.created", {
      id: thread.id,
      target_type,
      target_id,
      anchor: thread.anchor,
      author: thread.author,
      status: thread.status,
      created_at: thread.created_at,
    });

    return c.json(thread, 201);
  });

  app.get("/threads", (c) => {
    const target_type = c.req.query("target_type");
    const target_id = c.req.query("target_id");
    if (!target_type || !target_id) {
      return c.json({ error: "target_type and target_id query params required" }, 400);
    }
    return c.json(listThreadsByArtifact(db, target_type, target_id));
  });

  app.post("/threads/:id/messages", async (c) => {
    const thread_id = c.req.param("id");
    const thread = getThread(db, thread_id);
    if (!thread) {
      return c.json({ error: "not found" }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = CreateMessageSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    const { body: msgBody, author } = result.data;
    const id = crypto.randomUUID();
    let message: Awaited<ReturnType<typeof insertMessage>>;
    try {
      message = insertMessage(db, { id, thread_id, author, body: msgBody });
    } catch (err) {
      console.error("review-threads:message failed", err);
      return c.json({ error: "internal server error" }, 500);
    }

    reviewEvents.emit("thread.message_added", {
      id: message.id,
      thread_id,
      target_type: thread.target_type,
      target_id: thread.target_id,
      author,
      body: msgBody,
    });

    return c.json(message, 201);
  });

  app.get("/threads/:id/messages", (c) => {
    const thread_id = c.req.param("id");
    const thread = getThread(db, thread_id);
    if (!thread) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json(listMessagesByThread(db, thread_id));
  });

  app.patch("/threads/:id", async (c) => {
    const id = c.req.param("id");
    const thread = getThread(db, id);
    if (!thread) {
      return c.json({ error: "not found" }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const result = PatchThreadSchema.safeParse(body);
    if (!result.success) {
      const msg = result.error.issues[0]?.message ?? "invalid body";
      return c.json({ error: msg }, 400);
    }

    let updated: ReturnType<typeof updateThreadStatus>;
    try {
      updated = updateThreadStatus(db, id, "resolved");
    } catch (err) {
      console.error("review-threads:resolve failed", err);
      return c.json({ error: "internal server error" }, 500);
    }
    if (!updated) {
      return c.json({ error: "thread is already resolved" }, 409);
    }

    reviewEvents.emit("thread.resolved", {
      id: updated.id,
      target_type: updated.target_type,
      target_id: updated.target_id,
    });

    return c.json(updated);
  });

  app.post("/threads/:id/ping", (c) => {
    const id = c.req.param("id");
    const thread = getThread(db, id);
    if (!thread) {
      return c.json({ error: "not found" }, 404);
    }

    const entry = reviewRegistry.get(thread.target_type);
    const responder_id = entry?.responder_id;

    reviewEvents.emit("thread.ping_received", {
      thread_id: id,
      target_type: thread.target_type,
      target_id: thread.target_id,
      anchor: thread.anchor,
      ...(responder_id !== undefined ? { responder_id } : {}),
    });

    return c.body(null, 202);
  });
}
