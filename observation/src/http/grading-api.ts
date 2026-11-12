/**
 * Request and response bodies of the grading routes kbbl forwards to the browser
 * (kbbl/core/server/handlers/observation-proxy.ts), declared once.
 * kbbl/scripts/generate-grading-contracts.ts generates the PWA's types from these
 * exports and everything they reference, keeping their branded ids, with Dates as
 * the strings they serialize to.
 */
// Every list is one of these: GET .../gradeable-items, unlinked-items, unresolved-references, logical-items,
// composite-drilldown and items/:id/answers each return a Paged of the item type below.
export type { Paged, PageRequest } from "../grading/composite";
// GET /v1/runs/:run_id/grading-spend
export type { RunSpend } from "../storage/execution-store";
// GET /v1/runs/:run_id/items/at, and each row of unlinked-items
export type { AddressedItem, ItemAddress } from "../grading/item-reads";
// GET /v1/runs/:run_id/gradeable-items rows, unresolved-references rows
export type { GradeableItemRow, UnresolvedReferenceRead } from "../grading/item-reads";
// GET /v1/runs/:run_id/logical-items rows and /logical-items/:local_id
export type { CompositeRead, StageCompositeRead } from "../grading/item-reads";
// GET /v1/runs/:run_id/logical-items/:local_id/lineage
export type { LogicalItemLineage, LineageEntry } from "../grading/composite";
// GET /v1/runs/:run_id/composite-drilldown rows; the key it takes is one a composite served
export type { DrilldownRowRead, DrilldownQuestionRead, MeasurementStatusRead } from "../grading/item-reads";
export type { CompositeDrilldownKey, CompositeSelector } from "../grading/composite";
// GET /v1/items/:id/status
export type { ItemStatusResponse, QuestionStatusResponse, MachineStatusResponse } from "../storage/grading-record-store";
// GET /v1/items/:id/answers rows
export type { AnswerRead } from "../grading/item-reads";
// GET /v1/items/:id/lineage
export type { LineagePage } from "../storage/projection-store";
// GET /v1/reviewer; POST /v1/items/:id/answers, its acknowledgment and its refusal
export type { ReviewerRead, HumanSubmissionRequest, HumanSubmissionAcknowledgment, SubmissionRefusalBody } from "./grades";
// Any other refusal
export type { ErrorBody } from "./errors";

// GET /v1/runs/:run_id/grading-stages
export type { RunStageRead } from "../grading/task-stages";
