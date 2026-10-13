import type { OperatorAttemptView, OperatorUnitView } from "../operator-contracts";

export interface RunAttempt { readonly unit_id: string; readonly attempt: OperatorAttemptView }
export const selectRunAttempts = (units: readonly OperatorUnitView[]): readonly RunAttempt[] =>
  units.flatMap((unit) => unit.attempts.map((attempt) => ({ unit_id: unit.unit_id, attempt })));
