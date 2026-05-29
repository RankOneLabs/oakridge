import { Database } from "bun:sqlite";
import type { Epic, EpicStatus, EpicStage } from "../types/task-tracker";
import { applyEpicTransition, type EpicEvent } from "../orchestrator/epic-state-machine";

export type { Epic };

export function insertEpic(
  db: Database,
  {
    id,
    spec_id,
    project_id,
    title,
    status,
    current_stage,
    planner_runtime = null,
    planner_model = null,
    build_runtime = null,
    build_model = null,
  }: {
    id: string;
    spec_id: string;
    project_id: string;
    title: string;
    status: EpicStatus;
    current_stage: EpicStage;
    planner_runtime?: string | null;
    planner_model?: string | null;
    build_runtime?: string | null;
    build_model?: string | null;
  },
): Epic {
  return db
    .prepare<Epic, [string, string, string, string, EpicStatus, EpicStage, string | null, string | null, string | null, string | null]>(
      `INSERT INTO epics (id, spec_id, project_id, title, status, current_stage, planner_runtime, planner_model, build_runtime, build_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(id, spec_id, project_id, title, status, current_stage, planner_runtime, planner_model, build_runtime, build_model)!;
}

export function getEpic(db: Database, id: string): Epic | null {
  return db.prepare<Epic, [string]>("SELECT * FROM epics WHERE id = ?").get(id) ?? null;
}

export function getEpicBySpec(db: Database, spec_id: string): Epic | null {
  return (
    db.prepare<Epic, [string]>("SELECT * FROM epics WHERE spec_id = ?").get(spec_id) ?? null
  );
}

export function listEpicsByProject(
  db: Database,
  project_id: string,
  status?: EpicStatus,
): Epic[] {
  if (status !== undefined) {
    return db
      .prepare<Epic, [string, EpicStatus]>(
        "SELECT * FROM epics WHERE project_id = ? AND status = ? ORDER BY created_at, id",
      )
      .all(project_id, status);
  }
  return db
    .prepare<Epic, [string]>(
      "SELECT * FROM epics WHERE project_id = ? ORDER BY created_at, id",
    )
    .all(project_id);
}

const STAGE_EVENTS = new Set<string>([
  "epic_spec_approved",
  "epic_plan_approved",
  "epic_build_done",
  "epic_assess_done",
]);

/**
 * Reads the current Epic row, applies the transition, and writes it back.
 * Implicit rules applied on top of applyEpicTransition:
 *  - pending → active when any stage event fires (first gate crossing)
 *  - epic_assess_done also completes the lifecycle (active → complete)
 * Returns null when no Epic with that id exists.
 */
export function advanceEpicByEvent(
  db: Database,
  epic_id: string,
  event: EpicEvent,
): Epic | null {
  return db.transaction((): Epic | null => {
    const epic = getEpic(db, epic_id);
    if (!epic) return null;

    const next = applyEpicTransition(
      { status: epic.status, current_stage: epic.current_stage },
      event,
    );

    let finalStatus = next.status;
    // pending → active on first stage event
    if (epic.status === "pending" && STAGE_EVENTS.has(event)) {
      finalStatus = "active";
    }
    // epic_assess_done also completes the lifecycle
    if (event === "epic_assess_done" && finalStatus === "active") {
      finalStatus = "complete";
    }

    const fields: { status?: EpicStatus; current_stage?: EpicStage } = {};
    if (finalStatus !== epic.status) fields.status = finalStatus;
    if (next.current_stage !== epic.current_stage) fields.current_stage = next.current_stage;

    return updateEpicFields(db, epic_id, fields);
  })();
}

export function updateEpicFields(
  db: Database,
  id: string,
  fields: { status?: EpicStatus; current_stage?: EpicStage },
): Epic | null {
  const sets: string[] = [];
  const params: (string)[] = [];

  if (fields.status !== undefined) {
    sets.push("status = ?");
    params.push(fields.status);
  }
  if (fields.current_stage !== undefined) {
    sets.push("current_stage = ?");
    params.push(fields.current_stage);
  }
  if (sets.length === 0) return getEpic(db, id);

  params.push(id);
  const sql = `UPDATE epics SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return (db.prepare<Epic, string[]>(sql).get(...params) as Epic | undefined) ?? null;
}

type RoutingField = "planner_runtime" | "planner_model" | "build_runtime" | "build_model";

export function updateEpicRouting(
  db: Database,
  id: string,
  fields: Partial<Record<RoutingField, string | null>>,
): Epic | null {
  const sets: string[] = [];
  const params: (string | null)[] = [];

  for (const key of ["planner_runtime", "planner_model", "build_runtime", "build_model"] as RoutingField[]) {
    if (key in fields) {
      sets.push(`${key} = ?`);
      params.push(fields[key] ?? null);
    }
  }

  if (sets.length === 0) return getEpic(db, id);

  params.push(id);
  const sql = `UPDATE epics SET ${sets.join(", ")} WHERE id = ? RETURNING *`;
  return (db.prepare<Epic, (string | null)[]>(sql).get(...params) as Epic | undefined) ?? null;
}
