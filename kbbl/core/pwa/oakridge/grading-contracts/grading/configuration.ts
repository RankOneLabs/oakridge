// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationJsonValue } from "../domain/primitives";
import type { ObservationQuestionScope } from "./evidence";
import type { ObservationQuestionDefinition } from "./question";
import type { ObservationEvidenceCapabilityReference } from "../ports/producer-profile";

export type ObservationConfigurationDocument = ObservationDraftConfiguration | ObservationPublishedConfiguration;

export interface ObservationDraftConfiguration { readonly status: "draft"; readonly definitions: readonly ObservationJsonValue[] }

export interface ObservationPublishedConfiguration {
  readonly status: "published";
  readonly version: number;
  readonly hash: string;
  readonly published_at: string;
  readonly definitions: ObservationGradingDefinitions;
}

export type ObservationGradingDefinitions = readonly ObservationGradingDefinition[];

export interface ObservationConfigurationIssue {
  readonly definition_index: number | null;
  readonly path: readonly (string | number)[];
  readonly detail: string;
}

export interface ObservationRegisteredSelector {
  readonly artifact_kind: string;
  readonly item_selector: string;
  readonly item_kind: string;
  readonly item_fields: readonly string[];
}

export type ObservationGradingDefinition = ObservationGradingDefinitionFields & ObservationQuestionScope;

export interface ObservationGradingDefinitionFields {
  readonly id: string;
  readonly targets: readonly ObservationGradingTarget[];
  readonly evidence: readonly ObservationEvidenceCapabilityReference[];
  readonly question: ObservationGradingQuestion;
  readonly evaluators: readonly ObservationEvaluatorEntry[];
}

export type ObservationGradingTarget = { readonly artifact: string; readonly selector: string };

export type ObservationGradingQuestion = {
  readonly text: string | null;
  readonly response: ObservationQuestionDefinition["response_kind"];
  readonly values: readonly ObservationJsonValue[] | null;
  readonly missing_evidence_policy: ObservationQuestionDefinition["missing_evidence_policy"];
  readonly abstain_semantics: string;
  readonly unclear_semantics: string;
  readonly interpretation_caveats: string;
};

export type ObservationEvaluatorEntry = ObservationGraderEntry | ObservationHumanEvaluatorEntry;

export interface ObservationGraderEntry {
  readonly runner: string;
  readonly model: string;
  readonly instructions: ObservationJsonValue;
  readonly estimated_cost_per_call: number;
}

export interface ObservationHumanEvaluatorEntry { readonly runner: "human" }
