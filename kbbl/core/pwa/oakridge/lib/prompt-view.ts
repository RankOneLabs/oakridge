import type { ExecutedPromptTurn } from "../../../executed-prompt";
import type { OperatorAttemptView, OperatorUnitView } from "../operator-contracts/projections/unit-view";

/** The three provenance sections derive only from the recorded attempt intent and retained turns. */
export interface PromptView {
  readonly attempt_id: string;
  readonly worker: string;
  readonly stage: string | null;
  readonly template: { readonly identifier: string; readonly path: string; readonly digest: string; readonly content: null } | null;
  readonly inputs: OperatorAttemptView["intent"];
  readonly session_id: string | null;
}
interface PromptSelection {
  readonly units: readonly OperatorUnitView[];
  readonly unit_id: string;
  readonly attempt_id: string;
}
export function selectPromptView({ units, unit_id, attempt_id }: PromptSelection): PromptView | null {
  const unit = units.find((candidate) => candidate.unit_id === unit_id);
  if (!unit) return null;
  const attempt = unit.attempts.find((candidate) => candidate.id === attempt_id);
  if (!attempt) return null;
  const prompt = attempt.intent?.prompt;
  // The current API exposes prompt metadata, not source content addressable by digest.
  return { attempt_id: attempt.id, worker: attempt.worker, stage: unit.stage,
    template: prompt ? { identifier: prompt.path, path: prompt.path, digest: prompt.digest, content: null } : null,
    inputs: attempt.intent, session_id: attempt.kbbl_session_id };
}
export type ExecutedPromptRead =
  | { readonly state: "retained"; readonly turns: readonly ExecutedPromptTurn[] }
  | { readonly state: "not_retained" };
