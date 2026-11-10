import type { Brand } from "./primitives";

export type RunId = Brand<string, "ObservationRunId">;
export type ArtifactRevisionId = Brand<string, "ObservationArtifactRevisionId">;
export type ItemOccurrenceId = Brand<string, "ObservationItemOccurrenceId">;
export type LogicalItemId = Brand<string, "ObservationLogicalItemId">;
export type RelationId = Brand<string, "ObservationRelationId">;
export type EvidenceSetId = Brand<string, "ObservationEvidenceSetId">;
export type QuestionId = Brand<string, "ObservationQuestionId">;
export type EvaluatorDefinitionId = Brand<string, "ObservationEvaluatorDefinitionId">;
export type ExecutionId = Brand<string, "ObservationExecutionId">;
export type GradeObservationId = Brand<string, "ObservationGradeObservationId">;
/** The producer unit that published a revision. */
export type UnitId = Brand<string, "ObservationUnitId">;
/** The reviewer a grade credential is bound to. */
export type ReviewerId = Brand<string, "ObservationReviewerId">;
export type CanonicalDigest = Brand<`canonical-json/v1:${string}`, "CanonicalDigest">;
