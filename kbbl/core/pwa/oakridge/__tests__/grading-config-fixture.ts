import type { ObservationJsonValue as Json } from "../grading-contracts/domain/primitives";
import type { ObservationGradingDefinitions, ObservationPublishedConfiguration } from "../grading-contracts/grading/configuration";
import type { GradingConfigurationRead } from "../client-grading-config";
export const configDefinitions: readonly Json[] = [{
  id: "finding.quality", scope: "per_item", targets: [{ artifact: "analysis", selector: "/findings/*" }], evidence: ["subject"],
  question: { text: "Is the finding useful?", response: "choice", values: ["yes", "no"], missing_evidence_policy: "abstain", abstain_semantics: "Incomplete evidence", unclear_semantics: "Uncertain", interpretation_caveats: "One finding" },
  evaluators: [{ runner: "jev_direct", model: "jev-1", estimated_cost_per_call: 0.01, instructions: { system_one: { type: "choice", instructions: "Read the evidence", criteria: { yes: "Useful", no: "Unhelpful" } } } }, { runner: "fastino_glide", model: "glide", estimated_cost_per_call: 0.02, instructions: { system_one: { type: "score", instructions: "Score it", criteria: ["Weak", "Strong"] } } }, { runner: "llm_judge", model: "judge", estimated_cost_per_call: 0.03, instructions: { rubric: "Check citations", max_evidence_chars: 4000 } }],
}];
export const publishedConfig = (version = 3): ObservationPublishedConfiguration => ({ status: "published", version, hash: `hash-${version}`, published_at: "2026-11-12T12:00:00Z", definitions: configDefinitions as unknown as ObservationGradingDefinitions });
export const configRead = (): GradingConfigurationRead => ({
  draft: { document: { status: "draft", definitions: configDefinitions }, digest: "draft-base" },
  versions: { versions: [1, 3].map((version) => ({ version, hash: `hash-${version}`, published_at: "2026-11-12T12:00:00Z", definition_count: 1 })), damaged_versions: [], latest_version: 3 },
  catalogue: { selectors: [{ artifact_kind: "analysis", item_selector: "/findings/*", item_kind: "finding", item_fields: [] }, { artifact_kind: "assessment", item_selector: "/items/*", item_kind: "finding", item_fields: [] }], evidence_capabilities: [{ name: "subject", params_schema: { type: "object" }, subject_requirements: { fields: [], task_subject: false } }, { name: "citation", params_schema: { type: "object", properties: { path: { type: "string" } } }, subject_requirements: { fields: [], task_subject: false } }], runners: ["jev_direct", "fastino_glide", "llm_judge"] },
  runtime: { version: 3, hash: "hash-3", applied_at: "2026-11-12T12:00:00Z", last_failure: null, graders: { state: "configured", graders: [] } },
  latest: publishedConfig(), selected: null,
});
