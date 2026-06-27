import { Database } from "bun:sqlite";
import type {
  AgentRuntimeChoice,
  Epic,
  EpicStatus,
  EpicStage,
  EpicModelSelection,
} from "../types/task-tracker";
import { applyEpicTransition, type EpicEvent } from "../orchestrator/epic-state-machine";
import { defaultEpicModelSelections, type RuntimeModelSelection } from "../runtime";

export type { Epic };

type EpicRow = {
  id: string;
  spec_id: string;
  project_id: string;
  title: string;
  status: EpicStatus;
  current_stage: EpicStage;
  agent_runtime: AgentRuntimeChoice;
  planner_runtime: AgentRuntimeChoice;
  planner_model: string;
  worker_runtime: AgentRuntimeChoice;
  worker_model: string;
  created_at: string;
};

function toModelSelection(runtime: AgentRuntimeChoice, model: string): EpicModelSelection {
  return { runtime, model };
}

function toEpic(row: EpicRow): Epic {
  return {
    id: row.id,
    spec_id: row.spec_id,
    project_id: row.project_id,
    title: row.title,
    status: row.status,
    current_stage: row.current_stage,
    agent_runtime: row.agent_runtime,
    planner_model_selection: toModelSelection(row.planner_runtime, row.planner_model),
    worker_model_selection: toModelSelection(row.worker_runtime, row.worker_model),
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
    agent_runtime,
    planner_model_selection,
    worker_model_selection,
  }: {
    id: string;
    spec_id: string;
    project_id: string;
    title: string;
    status: EpicStatus;
    current_stage: EpicStage;
    agent_runtime?: AgentRuntimeChoice;
    planner_model_selection?: RuntimeModelSelection;
    worker_model_selection?: RuntimeModelSelection;
  },
): Epic {
  const runtime = agent_runtime ?? "claude-code";
  const defaults = defaultEpicModelSelections(runtime);
  const planner = planner_model_selection ?? defaults.planner_model_selection;
  const worker = worker_model_selection ?? defaults.worker_model_selection;
  const row = db
    .prepare<EpicRow, [string, string, string, string, EpicStatus, EpicStage, AgentRuntimeChoice, AgentRuntimeChoice, string, AgentRuntimeChoice, string]>(
      `INSERT INTO epics (
         id,
         spec_id,
         project_id,
         title,
         status,
         current_stage,
         agent_runtime,
         planner_runtime,
         planner_model,
         worker_runtime,
         worker_model
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .get(
      id,
      spec_id,
      project_id,
      title,
      status,
      current_stage,
      runtime,
      planner.runtime,
      planner.model,
      worker.runtime,
      worker.model,
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
  const row = db.prepare<EpicRow, string[]>(sql).get(...params);
  return row ? toEpic(row) : null;
}
