import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { SessionManager } from "../../session/session-manager";
import type { createDispatcher } from "../../orchestrator/backends/dispatcher";

type Dispatcher = ReturnType<typeof createDispatcher>;

interface BuildsRouteDeps {
  db: Database;
  dispatcher: Dispatcher;
  manager: SessionManager;
}

export function mountBuildsRoutes(app: Hono, { db, dispatcher, manager }: BuildsRouteDeps): void {
  app.post("/briefs/:id/build", async (c) => {
    const brief_id = c.req.param("id");

    interface BriefStatusRow { status: string; cohort_id: string }
    const brief = db
      .prepare<BriefStatusRow, [string]>("SELECT status, cohort_id FROM briefs WHERE id = ?")
      .get(brief_id);
    if (!brief) return c.json({ error: "not found" }, 404);
    if (brief.status !== "approved") {
      return c.json({ error: "brief must be in approved status to run a build" }, 409);
    }

    // Guard against double-dispatch while a build session is still live.
    // Only treat current_session_ref as an in-flight build when the stage matches.
    interface CohortRefRow {
      current_session_ref: string | null;
      current_session_stage: string | null;
    }
    const cohort = db
      .prepare<CohortRefRow, [string]>(
        "SELECT current_session_ref, current_session_stage FROM cohorts WHERE id = ?",
      )
      .get(brief.cohort_id);
    if (cohort?.current_session_ref && cohort.current_session_stage === "build") {
      const existingSession = manager.get(cohort.current_session_ref);
      if (existingSession && existingSession.status !== "ended") {
        return c.json({ error: "a build session is already running for this cohort" }, 409);
      }
    }

    try {
      const session_ref = await dispatcher.dispatch("build", brief_id);
      return c.json({ session_ref });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("builds:post failed", err);
      return c.json({ error: `dispatch failed: ${msg}` }, 500);
    }
  });
}
