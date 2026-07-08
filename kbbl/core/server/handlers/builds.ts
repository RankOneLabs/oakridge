import type { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { SessionManager } from "../../session/session-manager";
import type { createDispatcher } from "../../orchestrator/backends/dispatcher";
import { DispatchConflictError } from "../../orchestrator/backends/dispatcher";
import { countUnmetDependencies } from "../../db/cohorts";

type Dispatcher = ReturnType<typeof createDispatcher>;

interface BuildsRouteDeps {
  db: Database;
  dispatcher: Dispatcher;
  manager: SessionManager;
}

export function mountBuildsRoutes(app: Hono, { db, dispatcher }: BuildsRouteDeps): void {
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

    // Refuse to start a build while any predecessor cohort is unbuilt. An
    // approved brief whose deps aren't done sits in 'ready_to_build'; the
    // orchestrator auto-dispatches the build only once the last dep resolves.
    if (countUnmetDependencies(db, brief.cohort_id) > 0) {
      return c.json({ error: "cohort has unmet dependencies" }, 409);
    }

    try {
      const session_ref = await dispatcher.dispatch("build", brief_id);
      return c.json({ session_ref });
    } catch (err) {
      if (err instanceof DispatchConflictError) {
        // The dispatch claim is already held by another attempt (hook-vs-click
        // race or double-POST). Return the active attempt metadata so the
        // operator or client can render the in-flight state.
        const a = err.activeAttempt;
        return c.json(
          {
            error: "a build dispatch is already active for this brief",
            active_attempt_id: a.id,
            current_session_ref: a.actual_session_ref,
            status: a.status,
          },
          409,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error("builds:post failed", err);
      return c.json({ error: `dispatch failed: ${msg}` }, 500);
    }
  });
}
