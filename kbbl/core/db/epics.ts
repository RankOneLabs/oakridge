import { Database } from "bun:sqlite";
import type {
  Epic,
  EpicStatus,
  EpicStage,
  EpicModelSelection,
} from "../types/task-tracker";
import { applyEpicTransition, type EpicEvent } from "../orchestrator/epic-state-machine";
import type { RuntimeId, RuntimeModelSelection } from "../runtime";

export type { Epic };

type EpicRow = {
  id: string;
  spec_id: string;
  project_id: string;
  title: string;
  status: EpicStatus;
  current_stage: EpicStage;
  planner_runtime: RuntimeId;
  planner_model: string;
  planner_effort: string | null;
  worker_runtime: RuntimeId;
  worker_model: string;
  worker_effort: string | null;
  created_at: string;
};

function toModelSelection(
  runtime: RuntimeId,
  model: string,
  effort: string | null,
): EpicModelSelection {
  return { runtime, model, effort };
}

function toEpic(row: EpicRow): Epic {
  return {
    id: row.id,
    spec_id: row.spec_id,
    project_id: row.project_id,
    title: row.title,
    status: row.status,
    current_stage: row.current_stage,
    planner_model_selection: toModelSelection(
      row.planner_runtime,
      row.planner_model,
      row.planner_effort,
    ),
    worker_model_selection: toModelSelection(
      row.worker_runtime,
      row.worker_model,
      row.worker_effort,
    ),
    created_at: row.created_at,
  };
}

export function insertEpic(
  db: Database,
  {
    id,
    spec_id,
    project_id,
    title,
    status,
    current_stage,
    planner_model_selection,
    worker_model_selection,
  }: {
    id: string;
    spec_id: string;
    project_id: string;
    title: string;
    status: EpicStatus;
    current_stage: EpicStage;
    planner_model_selection: RuntimeModelSelection;
    worker_model_selection: RuntimeModelSelection;
  },
): Epic {
  const row = db
    .prepare<
      EpicRow,
      [string, string, string, string, EpicStatus, EpicStage, RuntimeId, string, string | null, RuntimeId, string, string | null]
    >(
      `INSERT INTO epics (
         id,
         spec_id,
         project_id,
         title,
         status,
         current_stage,
         planner_runtime,
         planner_model,
         planner_effort,
         worker_runtime,
         worker_model,
         worker_effort
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      spec_id,
      project_id,
      title,
      status,
      current_stage,
      planner_model_selection.runtime,
      planner_model_selection.model,
      planner_model_selection.effort ?? null,
      worker_model_selection.runtime,
      worker_model_selection.model,
      worker_model_selection.effort ?? null,
    )!;
  return toEpic(row);
}

export function getEpic(db: Database, id: string): Epic | null {
  const row = db.prepare<EpicRow, [string]>("SELECT * FROM epics WHERE id = ?").get(id);
  return row ? toEpic(row) : null;
}

export function getEpicBySpec(db: Database, spec_id: string): Epic | null {
  const row = db.prepare<EpicRow, [string]>("SELECT * FROM epics WHERE spec_id = ?").get(spec_id);
  return row ? toEpic(row) : null;
}

export function listEpicsByProject(
  db: Database,
  project_id: string,
  status?: EpicStatus,
): Epic[] {
  if (status !== undefined) {
    return db
      .prepare<EpicRow, [string, EpicStatus]>(
        "SELECT * FROM epics WHERE project_id = ? AND status = ? ORDER BY created_at, id",
      )
      .all(project_id, status)
      .map(toEpic);
  }
  return db
    .prepare<EpicRow, [string]>(
      "SELECT * FROM epics WHERE project_id = ? ORDER BY created_at, id",
    )
    .all(project_id)
    .map(toEpic);
}

/** Every epic, across projects — maintenance surface, not a request path. */
export function listAllEpics(db: Database): Epic[] {
  return db
    .prepare<EpicRow, []>("SELECT * FROM epics ORDER BY created_at, id")
    .all()
    .map(toEpic);
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

/**
 * Delete an epic and everything reachable from its spec: plans, their
 * cohorts and briefs, assessments, discrepancies, and finally the spec
 * itself. Deepest FK dependency first, and the epic before its spec, since
 * `epics.spec_id` references `specs(id)`.
 *
 * One transaction, and the only place this cascade is written — the delete
 * route and the legacy-epic purge both call it rather than restating the
 * order, which is exactly the kind of thing that rots out of sync.
 *
 * Returns false when the epic does not exist.
 */
export function deleteEpicCascade(db: Database, id: string): boolean {
  return db.transaction((): boolean => {
    const epic = getEpic(db, id);
    if (!epic) return false;

    const spec_id = epic.spec_id;

    const planIds = db
      .prepare<{ id: string }, [string]>("SELECT id FROM plans WHERE spec_id = ?")
      .all(spec_id)
      .map((row) => row.id);

    const cohortIds =
      planIds.length > 0
        ? db
            .prepare<{ id: string }, string[]>(
              `SELECT id FROM cohorts WHERE plan_id IN (${planIds.map(() => "?").join(",")})`,
            )
            .all(...planIds)
            .map((row) => row.id)
        : [];

    if (cohortIds.length > 0) {
      const ph = cohortIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM briefs WHERE cohort_id IN (${ph})`).run(...cohortIds);
      db.prepare(
        `DELETE FROM cohort_dependencies WHERE from_cohort_id IN (${ph}) OR to_cohort_id IN (${ph})`,
      ).run(...cohortIds, ...cohortIds);
      db.prepare(`DELETE FROM cohorts WHERE id IN (${ph})`).run(...cohortIds);
    }

    if (planIds.length > 0) {
      const ph = planIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM assessments WHERE plan_id IN (${ph})`).run(...planIds);
      db.prepare(`DELETE FROM plans WHERE id IN (${ph})`).run(...planIds);
    }

    db.prepare("DELETE FROM spec_discrepancies WHERE spec_id = ?").run(spec_id);
    db.prepare("DELETE FROM epics WHERE id = ?").run(id);
    db.prepare("DELETE FROM specs WHERE id = ?").run(spec_id);

    return true;
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
  const row = db.prepare<EpicRow, string[]>(sql).get(...params);
  return row ? toEpic(row) : null;
}
