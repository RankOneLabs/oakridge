/**
 * Request and response bodies of the operator HTTP API, declared once.
 * kbbl/scripts/generate-operator-contracts.ts generates the PWA's types from
 * these exports and everything they reference, with brands and Dates as the
 * strings they serialize to.
 */
export type { RunPage, RunView, RunSummary, RunDetail, RunUnitSummary, RunInspectView, InspectAttention } from "../projections/run-view";
export type { DefinitionPage, DefinitionSummary, DefinitionDetail, PinnedDefinition } from "../projections/definition-view";
export type { CollaborationThreadView } from "../projections/collaboration-view";
export type { ProjectDraft, ProjectList, ProjectView } from "./projects";
export type { RunEvent } from "../projections/run-event";
export type { IngressRequest, LaunchRequest, DecideRequest, IngressResponse } from "./ingress";
