import type { Brand } from "./primitives";

export type RunId = Brand<string, "ObservationRunId">;
export type ArtifactRevisionId = Brand<string, "ObservationArtifactRevisionId">;
export type ItemOccurrenceId = Brand<string, "ObservationItemOccurrenceId">;
export type RelationId = Brand<string, "ObservationRelationId">;
export type EvidenceSetId = Brand<string, "ObservationEvidenceSetId">;
export type QuestionId = Brand<string, "ObservationQuestionId">;
export type ExecutionId = Brand<string, "ObservationExecutionId">;
export type GradeObservationId = Brand<string, "ObservationGradeObservationId">;
export type CanonicalDigest = Brand<`canonical-json/v1:${string}`, "CanonicalDigest">;
