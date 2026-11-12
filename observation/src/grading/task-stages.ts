import type { CapturePin } from "./evidence";
import type { Result } from "../domain/primitives";

/** The readiness fields of DBOS UnitView, including its stage's declared artifacts. */
export interface WorkflowUnit {
  readonly unit_id: string;
  readonly stage: string | null;
  readonly depends_on: readonly string[];
  readonly status: { readonly kind: "not_started" | "active" | "done" | "cancelled" };
  readonly artifacts: readonly { readonly artifact_key: string }[];
}
export interface WorkflowStage { readonly stage: string; readonly artifact_kinds: readonly string[] }
export interface StageReadError { readonly operation: "read_run_stages"; readonly entity_id: string; readonly detail: string }
export interface RunStageSource { read(run_id: string): Promise<Result<readonly WorkflowUnit[], StageReadError>> }
/** `is_run_complete`: DBOS has settled every unit, so no stage can still appear or publish. */
export interface RollupContext { readonly stages: readonly WorkflowStage[]; readonly pins: readonly CapturePin[]; readonly is_run_complete: boolean }

/** Stable topological readiness order; stage-less parents still carry dependency paths.
 * Cyclic/unavailable dependencies never hide units: remaining units retain their read order. */
export function stagesFromReadiness(units: readonly WorkflowUnit[]): readonly WorkflowStage[] {
  const remaining = new Map(units.map((unit) => [unit.unit_id, unit]));
  const ordered: WorkflowUnit[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((unit) => unit.depends_on.every((id) => !remaining.has(id)));
    const next = ready.length > 0 ? ready : [...remaining.values()];
    for (const unit of next) { remaining.delete(unit.unit_id); ordered.push(unit); }
  }
  const stages = new Map<string, Set<string>>();
  for (const unit of ordered) {
    if (unit.stage === null) continue;
    const kinds = stages.get(unit.stage) ?? new Set<string>();
    for (const artifact of unit.artifacts) kinds.add(artifact.artifact_key);
    stages.set(unit.stage, kinds);
  }
  return [...stages].map(([stage, kinds]) => ({ stage, artifact_kinds: [...kinds] }));
}
/** The root unit stays open until its children settle, so a run is over once every unit is terminal. */
export const isRunComplete = (units: readonly WorkflowUnit[]): boolean =>
  units.length > 0 && units.every((unit) => unit.status.kind === "done" || unit.status.kind === "cancelled");
export const isStageGraded = (stage: WorkflowStage, pins: readonly CapturePin[]): boolean =>
  pins.some((pin) => stage.artifact_kinds.includes(pin.artifact_kind));
export type StageState =
  | { readonly state: "not_graded" }
  | { readonly state: "pending" }
  | { readonly state: "gap" }
  | { readonly state: "linked" };
export type RunStageRead = WorkflowStage & StageState;
export interface StageStateInput {
  readonly stage: WorkflowStage;
  readonly pins: readonly CapturePin[];
  readonly is_published: boolean;
  readonly has_current_items: boolean;
}
export function selectStageState(input: StageStateInput): StageState {
  if (!isStageGraded(input.stage, input.pins)) return { state: "not_graded" };
  if (!input.is_published) return { state: "pending" };
  return { state: input.has_current_items ? "linked" : "gap" };
}
export interface UnknownStage { readonly kind: "unknown_stage"; readonly stage: string }
export const validateStage = (stages: readonly WorkflowStage[], stage: string): Result<string, UnknownStage> =>
  stages.some((candidate) => candidate.stage === stage) ? { ok: true, value: stage } : { ok: false, error: { kind: "unknown_stage", stage } };
