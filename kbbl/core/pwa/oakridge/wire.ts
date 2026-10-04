import type {
  CohortPullRequestReconciliation, CohortLifecycleSummary,
  ParkedGate, Project, ProjectId, RepositoryKey, ReviewInbox,
  ReviewInboxItem, RunDetail, RunDiagnosis, RunDiagnosisSession, RunEvent, RunEventEffect, RunEventFrame, SessionRunLocation, SessionMessageRecord, SessionMessageAccepted,
  StageDetail, StageUnit, WorkflowRunId,
} from "./types";
import type { Result } from "../lib/result";
import { parseRepositoryKey } from "./repository-inputs";

const nullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const object = (value: unknown, field: string): { readonly [key: string]: unknown } => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`parse run event: invalid ${field}`);
  return value as { readonly [key: string]: unknown };
};
const string = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`parse run event: invalid ${field}`);
  return value;
};
const number = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`parse run event: invalid ${field}`);
  return value;
};

const LAUNCH_REASONS = new Set<RunEvent["launch_reason"]>([
  "initial", "dependency_satisfied", "artifact_accepted", "gate_decided", "operator", "retry", "recovery",
]);

const parseEffect = (value: unknown): RunEventEffect => {
  const effect = object(value, "effect");
  const kind = string(effect.kind, "effect.kind");
  switch (kind) {
    case "none":
    case "deliver_message":
    case "resume_wait":
      return { kind };
    case "start_stage":
      return { kind, stage_instance_id: string(effect.stage_instance_id, "effect.stage_instance_id") };
    case "worker_decision": {
      if (!Array.isArray(effect.changes) || !Array.isArray(effect.actions)) throw new Error("parse run event: invalid worker decision");
      const actions = effect.actions.map((value) => {
        const action = object(value, "effect.actions[]");
        const worker = string(action.worker, "action.worker");
        if (!["provision", "spec", "plan", "brief", "build", "assessment", "final_integration"].includes(worker)) throw new Error("parse run event: invalid worker");
        return { worker: worker as import("../../../../oakridge-dbos/src/domain/dev-flow-v15").V15WorkerKey,
          action_point: string(action.action_point, "action.action_point") };
      });
      return { kind, cohort_id: string(effect.cohort_id, "effect.cohort_id"), from_state: string(effect.from_state, "effect.from_state"),
        to_state: string(effect.to_state, "effect.to_state"), changes: effect.changes as import("../../../../oakridge-dbos/src/domain/dev-flow-v15").V15Change[], actions };
    }
    case "cohort_transition":
      if (!nullableString(effect.next_actor)) throw new Error("parse run event: invalid effect.next_actor");
      if (effect.refusal !== null) throw new Error("parse run event: invalid effect.refusal");
      return { kind, cohort_id: string(effect.cohort_id, "effect.cohort_id"),
        unit_label: string(effect.unit_label, "effect.unit_label"),
        event_kind: string(effect.event_kind, "effect.event_kind"),
        from_state: string(effect.from_state, "effect.from_state"),
        to_state: string(effect.to_state, "effect.to_state"),
        next_actor: effect.next_actor, refusal: null };
    case "pull_request_observed":
    case "pull_request_merge_confirmed":
      if (!nullableString(effect.merged_at)) throw new Error("parse run event: invalid effect.merged_at");
      return { kind, repository_key: string(effect.repository_key, "effect.repository_key"),
        pull_request_url: string(effect.pull_request_url, "effect.pull_request_url"),
        state: string(effect.state, "effect.state"), source: string(effect.source, "effect.source"),
        merged_at: effect.merged_at };
    case "unrecognized": return { kind, effect_kind: string(effect.effect_kind, "effect.effect_kind") };
    default:
      return { kind: "unrecognized", effect_kind: kind };
  }
};

export const parseRunEvent = (value: unknown): RunEvent => {
  const event = object(value, "event");
  const sequence = string(event.sequence, "sequence");
  if (!/^\d+$/.test(sequence)) throw new Error("parse run event: invalid sequence");
  const owner = object(event.owner, "owner");
  if (owner.kind !== "run" && owner.kind !== "stage_instance" && owner.kind !== "cohort") {
    throw new Error("parse run event: invalid owner.kind");
  }
  const launch_reason = string(event.launch_reason, "launch_reason");
  if (!LAUNCH_REASONS.has(launch_reason as RunEvent["launch_reason"])) throw new Error("parse run event: invalid launch_reason");
  if (!nullableString(event.effect_workflow_id)) throw new Error("parse run event: invalid effect_workflow_id");
  return {
    sequence, transition_id: string(event.transition_id, "transition_id"),
    run_id: string(event.run_id, "run_id") as WorkflowRunId,
    owner: { kind: owner.kind, id: string(owner.id, "owner.id") },
    launch_reason: launch_reason as RunEvent["launch_reason"],
    prior_owner_version: number(event.prior_owner_version, "prior_owner_version"),
    resulting_owner_version: number(event.resulting_owner_version, "resulting_owner_version"),
    effect: parseEffect(event.effect), effect_workflow_id: event.effect_workflow_id,
    actor: string(event.actor, "actor"), occurred_at: string(event.occurred_at, "occurred_at"),
  };
};

export const parseRunEventFrame = (value: unknown): RunEventFrame => {
  const event = object(value, "frame");
  if (typeof event.replayed !== "boolean") throw new Error("parse run event: invalid replayed");
  return { ...parseRunEvent(event), replayed: event.replayed };
};

export const parseOakridgeRunEventFrame = (data: string): RunEventFrame | null => {
  try { return parseRunEventFrame(JSON.parse(data)); } catch { return null; }
};

const isJsonValue = (value: unknown): value is import("./types").JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
};


type RawStageUnit = Omit<StageUnit, "repository_key"> & { repository_key?: string | null };
type RawStageDetail = Omit<StageDetail, "units"> & { units?: RawStageUnit[] };
export type RawRunDetail = Omit<RunDetail, "stages"> & {
  stages: RawStageDetail[];
};
export type RawParkedGate = Omit<ParkedGate, "repository_key"> & { repository_key?: string | null };
type RawCohortPullRequestReconciliation = Omit<CohortPullRequestReconciliation, "repository_key"> & { repository_key: string };
type RawCohortLifecycleSummary = Omit<CohortLifecycleSummary, "repository_key" | "pull_request_reconciliation"> & {
  repository_key?: string | null;
  pull_request_reconciliation?: RawCohortPullRequestReconciliation | null;
};
type RawReviewInboxItem = Omit<ReviewInboxItem, "repository_key"> & { repository_key?: string | null };
export interface RawReviewInbox {
  cohorts: RawCohortLifecycleSummary[];
  items: RawReviewInboxItem[];
  attention_count: number;
}

export interface ResponseParseError {
  operation: string;
  detail: string;
}

interface RawProject extends Omit<Project, "id"> {
  readonly id: string;
}

const ok = <T>(value: T): Result<T, ResponseParseError> => ({ ok: true, value });
const err = (operation: string, detail: string): Result<never, ResponseParseError> => ({ ok: false, error: { operation, detail } });

export const parseProject = (value: unknown): Result<Project, ResponseParseError> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return err("parse project", "response was not an object");
  const project = value as Partial<RawProject>;
  if (typeof project.id !== "string" || !project.id.trim()) return err("parse project", "response contained an empty project id");
  if (typeof project.name !== "string") return err("parse project", "response contained an invalid project name");
  if (typeof project.repo_dir !== "string") return err("parse project", "response contained an invalid repository path");
  if (typeof project.created_at !== "string") return err("parse project", "response contained an invalid creation time");
  if (project.integration_branch !== null && project.integration_branch !== undefined && typeof project.integration_branch !== "string") {
    return err("parse project", "response contained an invalid integration branch");
  }
  const forge = project.forge_repository;
  if (forge !== null && forge !== undefined && (typeof forge !== "object" || forge.provider !== "github"
      || typeof forge.owner !== "string" || typeof forge.name !== "string")) {
    return err("parse project", "response contained an invalid forge repository");
  }
  return ok({ ...project, id: project.id as ProjectId } as Project);
};

function parseOptionalRepositoryKey(value: string | null | undefined): Result<RepositoryKey | null | undefined, ResponseParseError> {
  if (value == null) return ok(value);
  const key = parseRepositoryKey(value);
  return key ? ok(key) : err("parse repository key", "response contained an empty repository key");
}

function parseRequiredRepositoryKey(value: string): Result<RepositoryKey, ResponseParseError> {
  const key = parseRepositoryKey(value);
  return key ? ok(key) : err("parse repository key", "response contained an empty repository key");
}


export function parseRunDetail(run: RawRunDetail): Result<RunDetail, ResponseParseError> {
  const stages: StageDetail[] = [];
  for (const stage of run.stages) {
    const units: StageUnit[] = [];
    for (const unit of stage.units ?? []) {
      const repositoryKey = parseOptionalRepositoryKey(unit.repository_key);
      if (!repositoryKey.ok) return repositoryKey;
      if (unit.state !== undefined && (typeof unit.state !== "string" || !unit.state)) {
        return err("parse run detail", "response contained an invalid cohort state");
      }
      units.push({ ...unit, repository_key: repositoryKey.value });
    }
    stages.push({ ...stage, units: stage.units ? units : stage.units });
  }
  return ok({
    ...run,
    stages,
  });
}

export function parseParkedGates(gates: RawParkedGate[]): Result<ParkedGate[], ResponseParseError> {
  const parsed: ParkedGate[] = [];
  for (const gate of gates) {
    const repositoryKey = parseOptionalRepositoryKey(gate.repository_key);
    if (!repositoryKey.ok) return repositoryKey;
    const revisions = gate.artifact_revision_ids ?? (gate.artifact_revision_id ? [gate.artifact_revision_id] : []);
    if (!Array.isArray(revisions) || revisions.some((id) => typeof id !== "string")) {
      return err("parse parked gates", "response contained invalid artifact revision ids");
    }
    parsed.push({ ...gate, repository_key: repositoryKey.value, artifact_revision_ids: revisions });
  }
  return ok(parsed);
}

export function parseReviewInbox(inbox: RawReviewInbox): Result<ReviewInbox, ResponseParseError> {
  const cohorts: CohortLifecycleSummary[] = [];
  for (const cohort of inbox.cohorts) {
    const repositoryKey = parseOptionalRepositoryKey(cohort.repository_key);
    if (!repositoryKey.ok) return repositoryKey;
    const links = cohort.links ?? [];
    const facts = cohort.facts ?? [];
    if (!Array.isArray(links) || links.some((link) => !link || typeof link.key !== "string"
      || typeof link.label !== "string" || typeof link.url !== "string")) {
      return err("parse review inbox", "response contained invalid cohort links");
    }
    if (!Array.isArray(facts) || facts.some((fact) => !fact || typeof fact.key !== "string"
      || typeof fact.label !== "string" || typeof fact.value !== "string")) {
      return err("parse review inbox", "response contained invalid cohort facts");
    }
    let reconciliation: CohortPullRequestReconciliation | null | undefined = cohort.pull_request_reconciliation == null
      ? cohort.pull_request_reconciliation
      : undefined;
    if (cohort.pull_request_reconciliation) {
      const reconciliationKey = parseRequiredRepositoryKey(cohort.pull_request_reconciliation.repository_key);
      if (!reconciliationKey.ok) return reconciliationKey;
      reconciliation = { ...cohort.pull_request_reconciliation, repository_key: reconciliationKey.value };
    }
    cohorts.push({ ...cohort, repository_key: repositoryKey.value, links, facts,
      pull_request_reconciliation: reconciliation });
  }
  const items: ReviewInboxItem[] = [];
  for (const item of inbox.items) {
    const repositoryKey = parseOptionalRepositoryKey(item.repository_key);
    if (!repositoryKey.ok) return repositoryKey;
    items.push({ ...item, repository_key: repositoryKey.value });
  }
  return ok({ cohorts, items, attention_count: inbox.attention_count });
}


export function parseSessionRunLocation(value: unknown): Result<SessionRunLocation, ResponseParseError> {
  const operation = "parse session run location";
  if (!value || typeof value !== "object" || Array.isArray(value)) return err(operation, "response was not an object");
  const raw = value as Partial<Record<keyof SessionRunLocation, unknown>>;
  if (typeof raw.run_id !== "string" || !raw.run_id) return err(operation, "response contained an empty run id");
  if (typeof raw.stage_instance_id !== "string" || !raw.stage_instance_id) return err(operation, "response contained an empty stage instance id");
  if (typeof raw.stage_key !== "string") return err(operation, "response contained an invalid stage key");
  if (typeof raw.unit_id !== "string") return err(operation, "response contained an invalid unit id");
  if (typeof raw.work_order_id !== "string" || !raw.work_order_id) return err(operation, "response contained an empty work order id");
  return ok({
    run_id: raw.run_id as WorkflowRunId, stage_instance_id: raw.stage_instance_id,
    stage_key: raw.stage_key, unit_id: raw.unit_id, work_order_id: raw.work_order_id,
  });
}

const record = (value: unknown, field: string): { readonly [key: string]: unknown } => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`oakridge wire: invalid ${field}`);
  return value as { readonly [key: string]: unknown };
};
const textField = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new Error(`oakridge wire: invalid ${field}`);
  return value;
};
const numericField = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`oakridge wire: invalid ${field}`);
  return value;
};
const list = (value: unknown, field: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`oakridge wire: invalid ${field}`);
  return value;
};
const CORE_STATUSES = new Set(["pending", "active", "blocked", "complete", "failed", "cancelled"]);
const BLOCKED_REASONS = new Set(["dependency", "gate", "capacity", "external", "operator", "retry"]);
const NEXT_ACTORS = new Set(["core", "agent", "service", "operator", "external"]);
const statusField = (value: unknown, field: string): void => {
  if (typeof value !== "string" || !CORE_STATUSES.has(value)) throw new Error(`oakridge wire: invalid ${field}`);
};
const nullableEnum = (value: unknown, values: ReadonlySet<string>, field: string): void => {
  if (value !== null && (typeof value !== "string" || !values.has(value))) throw new Error(`oakridge wire: invalid ${field}`);
};

const parseDiagnosisSession = (value: unknown, field: string): RunDiagnosisSession => {
  const session = record(value, field);
  textField(session.session_id, `${field}.session_id`);
  textField(session.stage_key, `${field}.stage_key`);
  textField(session.cohort_id, `${field}.cohort_id`);
  textField(session.cohort_key, `${field}.cohort_key`);
  textField(session.worker, `${field}.worker`);
  textField(session.execution_id, `${field}.execution_id`);
  textField(session.action_point, `${field}.action_point`);
  if (typeof session.is_current !== "boolean") throw new Error(`${field}.is_current must be a boolean`);
  statusField(session.status, `${field}.status`);
  return session as unknown as RunDiagnosisSession;
};

export const parseRunDiagnosis = (value: unknown): RunDiagnosis => {
  const diagnosis = record(value, "diagnosis");
  const rawRun = record(diagnosis.run, "run");
  textField(rawRun.id, "run.id");
  statusField(rawRun.status, "run.status");
  nullableEnum(rawRun.blocked_reason, BLOCKED_REASONS, "run.blocked_reason");
  nullableEnum(rawRun.next_actor, NEXT_ACTORS, "run.next_actor");
  for (const [index, value] of list(rawRun.stages, "run.stages").entries()) {
    const stage = record(value, `run.stages[${index}]`);
    statusField(stage.status, `run.stages[${index}].status`);
    nullableEnum(stage.blocked_reason, BLOCKED_REASONS, `run.stages[${index}].blocked_reason`);
    nullableEnum(stage.next_actor, NEXT_ACTORS, `run.stages[${index}].next_actor`);
    for (const [unitIndex, rawUnit] of list(stage.units, `run.stages[${index}].units`).entries()) {
      const unit = record(rawUnit, `run.stages[${index}].units[${unitIndex}]`);
      statusField(unit.status, `run.stages[${index}].units[${unitIndex}].status`);
      nullableEnum(unit.blocked_reason, BLOCKED_REASONS, `run.stages[${index}].units[${unitIndex}].blocked_reason`);
      nullableEnum(unit.next_actor, NEXT_ACTORS, `run.stages[${index}].units[${unitIndex}].next_actor`);
      if (typeof unit.retryable !== "boolean") throw new Error(`oakridge wire: invalid run.stages[${index}].units[${unitIndex}].retryable`);
    }
  }
  const parsedRun = parseRunDetail(rawRun as unknown as RawRunDetail);
  if (!parsedRun.ok) throw new Error(`oakridge wire: ${parsedRun.error.detail}`);
  const sessions = list(diagnosis.sessions, "sessions").map((item, index) => parseDiagnosisSession(item, `sessions[${index}]`));
  const current_session = diagnosis.current_session === null ? null : parseDiagnosisSession(diagnosis.current_session, "current_session");
  const sessions_awaiting_action = list(diagnosis.sessions_awaiting_action, "sessions_awaiting_action")
    .map((item, index) => parseDiagnosisSession(item, `sessions_awaiting_action[${index}]`));
  const active_gates = list(diagnosis.active_gates, "active_gates").map((item, index) => {
    const gate = record(item, `active_gates[${index}]`);
    textField(gate.id, `active_gates[${index}].id`);
    if (gate.stage_instance_id !== null) textField(gate.stage_instance_id, `active_gates[${index}].stage_instance_id`);
    if (gate.cohort_id !== null) textField(gate.cohort_id, `active_gates[${index}].cohort_id`);
    statusField(gate.run_state, `active_gates[${index}].run_state`);
    return gate;
  });
  const parsedGates = parseParkedGates(active_gates as unknown as RawParkedGate[]);
  if (!parsedGates.ok) throw new Error(`oakridge wire: ${parsedGates.error.detail}`);
  const recent_artifacts = list(diagnosis.recent_artifacts, "recent_artifacts").map((item, index) => {
    const artifact = record(item, `recent_artifacts[${index}]`);
    textField(artifact.artifact_id, `recent_artifacts[${index}].artifact_id`);
    textField(artifact.type_id, `recent_artifacts[${index}].type_id`);
    numericField(artifact.revision, `recent_artifacts[${index}].revision`);
    textField(artifact.stage_name, `recent_artifacts[${index}].stage_name`);
    if (artifact.label !== null) textField(artifact.label, `recent_artifacts[${index}].label`);
    textField(artifact.created_at, `recent_artifacts[${index}].created_at`);
    return artifact;
  });
  const stage_progress = record(diagnosis.stage_progress, "stage_progress");
  for (const key of ["total", ...CORE_STATUSES]) numericField(stage_progress[key], `stage_progress.${key}`);
  const pull_request_merge_waits = list(diagnosis.pull_request_merge_waits, "pull_request_merge_waits").map((item, index) => {
    const wait = record(item, `pull_request_merge_waits[${index}]`);
    for (const key of ["cohort_id", "stage_instance_id", "unit_id", "pull_request_url"]) {
      textField(wait[key], `pull_request_merge_waits[${index}].${key}`);
    }
    return wait;
  });
  return { run: parsedRun.value, sessions, current_session, sessions_awaiting_action,
    active_gates: parsedGates.value.map((gate, index) => ({ ...gate, cohort_id: active_gates[index]?.cohort_id as string | null })),
    recent_artifacts: recent_artifacts as unknown as RunDiagnosis["recent_artifacts"],
    stage_progress: stage_progress as unknown as RunDiagnosis["stage_progress"],
    pull_request_merge_waits: pull_request_merge_waits as unknown as RunDiagnosis["pull_request_merge_waits"] };
};

export const parseSessionMessageRecord = (value: unknown): SessionMessageRecord => {
  const message = record(value, "session message");
  for (const key of ["id", "run_id", "thread_id", "message_id", "delivery_key", "created_at"])
    textField(message[key], `session message.${key}`);
  for (const key of ["cohort_id", "artifact_thread_id"])
    if (message[key] !== null) textField(message[key], `session message.${key}`);
  for (const partyName of ["sender", "recipient"]) {
    const party = record(message[partyName], `session message.${partyName}`);
    if (party.kind !== "core" && party.kind !== "agent" && party.kind !== "service" && party.kind !== "operator")
      throw new Error(`oakridge wire: invalid session message.${partyName}.kind`);
    if (party.id !== null) textField(party.id, `session message.${partyName}.id`);
  }
  if (!isJsonValue(message.body)) throw new Error("oakridge wire: invalid session message.body");
  if (message.delivery_status === "pending") {
    if (message.delivery_result !== null || message.delivered_at !== null) throw new Error("oakridge wire: invalid session message.delivery_result");
  } else if (message.delivery_status === "delivered") {
    if (record(message.delivery_result, "session message.delivery_result").kind !== "delivered") throw new Error("oakridge wire: invalid session message.delivery_result.kind");
    textField(message.delivered_at, "session message.delivered_at");
  } else if (message.delivery_status === "failed") {
    const result = record(message.delivery_result, "session message.delivery_result");
    if (result.kind !== "failed") throw new Error("oakridge wire: invalid session message.delivery_result.kind");
    textField(result.detail, "session message.delivery_result.detail");
    if (message.delivered_at !== null) throw new Error("oakridge wire: invalid session message.delivered_at");
  } else throw new Error("oakridge wire: invalid session message.delivery_status");
  return message as unknown as SessionMessageRecord;
};

export const parseSessionMessageAccepted = (value: unknown): SessionMessageAccepted => {
  const accepted = record(value, "session message accepted");
  if (accepted.kind !== "accepted") throw new Error("oakridge wire: invalid session message accepted.kind");
  textField(accepted.workflow_id, "session message accepted.workflow_id");
  return { kind: "accepted", workflow_id: accepted.workflow_id as string,
    message: parseSessionMessageRecord(accepted.message) };
};
