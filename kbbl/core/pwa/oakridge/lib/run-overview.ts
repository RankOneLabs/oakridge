import type { ArtifactId, Sid } from "../../lib/ids";
import type { CoreStatus, RunDetail, RunDiagnosis, RunDiagnosisSession } from "../types";

/** The diagnosis is already the complete backend answer rendered by the overview. */
export type RunOverview = RunDiagnosis;

export interface RunArtifactRef {
  readonly artifact_id: ArtifactId;
  readonly type_id: string;
  readonly version: number;
  readonly stage_name: string;
  readonly label: string | null;
  readonly created_at: string | null;
}

/** Sidebar ordering only; lifecycle diagnosis remains a committed backend fact. */
export const selectRunArtifacts = (run: RunDetail): readonly RunArtifactRef[] =>
  run.stages.flatMap((stage) => stage.artifacts.map((artifact) => ({
    artifact_id: artifact.id as ArtifactId,
    type_id: artifact.type_id,
    version: artifact.version,
    stage_name: stage.name,
    label: artifact.label ?? null,
    created_at: artifact.created_at ?? null,
  })));

export interface RunSidebarSessionRow {
  readonly session_id: Sid;
  readonly stage_key: string;
  readonly unit_id: string;
  readonly attempt_label: string;
  readonly status: CoreStatus;
  readonly is_current: boolean;
  readonly requires_operator_action: boolean;
}

export interface RunSidebarSessionsView {
  readonly rows: readonly RunSidebarSessionRow[];
  readonly is_action_state_known: true;
  readonly is_session_list_known: true;
}

const attemptLabel = (session: RunDiagnosisSession): string => session.attempt_count > 1
  ? `attempt ${session.attempt_number} of ${session.attempt_count}`
  : `attempt ${session.attempt_number}`;

export const selectRunSidebarSessions = (
  diagnosis: RunDiagnosis,
  purgedSessionIds: ReadonlySet<string>,
): RunSidebarSessionsView => ({
  is_action_state_known: true,
  is_session_list_known: true,
  rows: diagnosis.sessions.filter((session) => !purgedSessionIds.has(session.session_id)).map((session) => ({
    session_id: session.session_id as Sid,
    stage_key: session.stage_key,
    unit_id: session.cohort_id,
    attempt_label: attemptLabel(session),
    status: session.status,
    is_current: session.attempt_number === session.attempt_count,
    requires_operator_action: diagnosis.sessions_awaiting_action.some((candidate) => candidate.session_id === session.session_id),
  })),
});
