// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationMeasurementState } from "../grading/execution";
import type { ObservationItemStatusRead, ObservationMachineStatusRead, ObservationQuestionStatusRead } from "../grading/item-reads";
import type { ObservationAttemptRead } from "./execution-store";

export type ObservationItemStatusResponse = ObservationItemStatusRead<ObservationMeasurementState, ObservationAttemptRead>;

export type ObservationQuestionStatusResponse = ObservationQuestionStatusRead<ObservationMeasurementState, ObservationAttemptRead>;

export type ObservationMachineStatusResponse = ObservationMachineStatusRead<ObservationMeasurementState, ObservationAttemptRead>;
