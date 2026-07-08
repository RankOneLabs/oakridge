import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { createDispatcher } from "../../orchestrator/backends/dispatcher";
import { DispatchConflictError } from "../../orchestrator/backends/dispatcher";
import { getEpicBySpec } from "../../db/epics";
import { isFrozen } from "../../db/epic-freeze";
import {
  getActiveAttempt,
  getAttempt,
  listDispatchAttempts,
  type DispatchAttemptStatus,
  type DispatchEntityKind,
} from "../../db/dispatch-attempts";

type Dispatcher = ReturnType<typeof createDispatcher>;

interface DispatchAttemptsRouteDeps {
  db: Database;
  dispatcher: Dispatcher;
}

const STATUSES = new Set<DispatchAttemptStatus>([
  "dispatching",
  "running",
  "dispatch_failed",
  "succeeded",
  "cancelled",
]);

const ENTITY_KINDS = new Set<DispatchEntityKind>([
  "spec",
  "cohort",
  "brief",
  "plan",
]);

function parseStatus(raw: string | undefined): DispatchAttemptStatus | undefined | "invalid" {
  if (raw === undefined) return undefined;
  return STATUSES.has(raw as DispatchAttemptStatus) ? raw as DispatchAttemptStatus : "invalid";
}

function parseEntityKind(raw: string | undefined): DispatchEntityKind | undefined | "invalid" {
  if (raw === undefined) return undefined;
  return ENTITY_KINDS.has(raw as DispatchEntityKind) ? raw as DispatchEntityKind : "invalid";
}

function currentSessionRef(a: {
  actual_session_ref: string | null;
  intended_session_ref: string | null;
}): string | null {
  return a.actual_session_ref ?? a.intended_session_ref;
}

function archivedEpicConflict(db: Database, attemptId: string): boolean {
  const row = db
    .prepare<{ epic_id: string | null; spec_id: string | null }, [string]>(
      `SELECT da.epic_id, COALESCE(e.spec_id, s.id, pl.spec_id, cpl.spec_id, bpl.spec_id) AS spec_id
         FROM dispatch_attempts da
         LEFT JOIN epics e ON e.id = da.epic_id
         LEFT JOIN specs s ON da.entity_kind = 'spec' AND s.id = da.entity_id
         LEFT JOIN plans pl ON da.entity_kind = 'plan' AND pl.id = da.entity_id
         LEFT JOIN cohorts c ON da.entity_kind = 'cohort' AND c.id = da.entity_id
         LEFT JOIN plans cpl ON cpl.id = c.plan_id
         LEFT JOIN briefs b ON da.entity_kind = 'brief' AND b.id = da.entity_id
         LEFT JOIN cohorts bc ON bc.id = b.cohort_id
         LEFT JOIN plans bpl ON bpl.id = bc.plan_id
        WHERE da.id = ?`,
    )
    .get(attemptId);
  if (!row) return false;
  if (row.epic_id) return isFrozen(db, row.epic_id);
  if (!row.spec_id) return false;
  const epic = getEpicBySpec(db, row.spec_id);
  return epic ? isFrozen(db, epic.id) : false;
}

export function mountDispatchAttemptsRoutes(
  app: Hono,
  { db, dispatcher }: DispatchAttemptsRouteDeps,
): void {
  app.get("/dispatch-attempts", (c) => {
    const status = parseStatus(c.req.query("status"));
    if (status === "invalid") return c.json({ error: "invalid status" }, 400);
    const entity_kind = parseEntityKind(c.req.query("entity_kind"));
    if (entity_kind === "invalid") return c.json({ error: "invalid entity_kind" }, 400);

    const attempts = listDispatchAttempts(db, {
      status,
      entity_kind,
      entity_id: c.req.query("entity_id"),
      stage: c.req.query("stage"),
    });
    return c.json({ attempts });
  });

  app.get("/dispatch-attempts/:id", (c) => {
    const attempt = getAttempt(db, c.req.param("id"));
    if (!attempt) return c.json({ error: "not found" }, 404);
    return c.json(attempt);
  });

  app.post("/dispatch-attempts/:id/retry", async (c) => {
    const id = c.req.param("id");
    const attempt = getAttempt(db, id);
    if (!attempt) return c.json({ error: "not found" }, 404);
    if (attempt.status !== "dispatch_failed") {
      return c.json({
        error: "only dispatch_failed attempts can be retried",
        status: attempt.status,
      }, 409);
    }
    if (archivedEpicConflict(db, id)) {
      return c.json({ error: "epic is archived" }, 409);
    }

    try {
      const session_ref = await dispatcher.dispatch(attempt.stage, attempt.entity_id);
      const active = getActiveAttempt(db, attempt.entity_kind, attempt.entity_id, attempt.stage);
      return c.json({ session_ref, attempt: active }, 202);
    } catch (err) {
      if (err instanceof DispatchConflictError) {
        const a = err.activeAttempt;
        return c.json(
          {
            error: "a dispatch is already active for this entity and stage",
            active_attempt_id: a.id,
            current_session_ref: currentSessionRef(a),
            status: a.status,
          },
          409,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("dispatch-attempts:retry failed", err);
      return c.json({ error: `dispatch failed: ${msg}` }, 500);
    }
  });
}
