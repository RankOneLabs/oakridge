/**
 * Request and response bodies of the operator HTTP API, declared once.
 * kbbl/scripts/generate-operator-contracts.ts generates the PWA's types from
 * these exports and everything they reference, with brands and Dates as the
 * strings they serialize to.
 */
export type { StartPinnedRunRequest, StartedRun } from "../storage/mutation-service";
export type { RunPage, RunView, RunSummary, RunDetail } from "../projections/run-view";
export type { DefinitionPage, DefinitionSummary, PinnedDefinition } from "../projections/definition-view";
export type { ScopeView, Decision } from "../projections/scope-view";
export type { InboxItem, InboxPage, ReviewInbox } from "../projections/inbox";
export type { SessionLocation, RunSessionAttempt } from "../projections/session-view";
export type { ArtifactDetail, ArtifactRevisionStatus } from "../projections/artifact-view";
export type { CollaborationThreadView } from "../projections/collaboration-view";
export type { ScopeHistory } from "./diagnostics";
export type { CommandReceipt, ScopeCommandRequest, EditCommandPayload } from "./scope-commands";
export type { ProjectDraft, ProjectList, ProjectView } from "./projects";
export type { RunEvent } from "../projections/run-event";
