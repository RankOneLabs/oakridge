/**
 * Request and response bodies of the operator HTTP API, declared once.
 * kbbl/scripts/generate-operator-contracts.ts generates the PWA's types from
 * these exports and everything they reference, with brands and Dates as the
 * strings they serialize to.
 */
export type { RunPage, RunView, RunSummary, RunUnitSummary, RunInspectView, InspectAttention } from "../projections/run-view";
export type { DefinitionPage, DefinitionSummary, DefinitionDetail, PinnedDefinition } from "../projections/definition-view";
export type { UnitView } from "../projections/unit-view";
export type { InboxItem, InboxPage, RunInboxBatch, RunInboxBatchEntry } from "../projections/inbox";
export type { ArtifactDetail, ArtifactRevisionStatus } from "../projections/artifact-view";
export type { UnitHistory, UnitDiagnostics } from "../projections/history-view";
export type { CollaborationThreadView } from "../projections/collaboration-view";
export type { ProjectDraft, ProjectList, ProjectView } from "./projects";
export type { RunEvent } from "../projections/run-event";
export type { StreamFrameData, StreamInvalidation } from "../projections/operator-event";
export type { SessionHold, SessionHoldResponse } from "../projections/session-hold";
export type { IngressRequest, LaunchRequest, DecideRequest, PublishRequest, IngressResponse, IngressCommitted } from "./ingress";
