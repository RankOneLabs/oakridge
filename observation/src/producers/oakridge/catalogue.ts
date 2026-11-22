import { ARTIFACT_KEYS } from "./artifact-versions";
import type { RegisteredSelector } from "../../grading/configuration";
import { ok } from "../../domain/primitives";
import { definition, pathItem, register, type Registration } from "./extractor-helpers";
import { extractorRegistrations } from "./extractors/index.generated";

export * from "./extractor-helpers";

export const OAKRIDGE_REGISTRATIONS: readonly Registration[] = [
  ...extractorRegistrations,
  register(ARTIFACT_KEYS.$core["*"].blocker, [
    definition("blocker.body", "blocker", "/", (body) => ok([pathItem("blocker", "/", "", body)])),
  ]),
  ...[
    ARTIFACT_KEYS["fan-out"].item.result, ARTIFACT_KEYS["fan-out"].prepare.workspace,
    ARTIFACT_KEYS["review-loop"].document.critique, ARTIFACT_KEYS["review-loop"].document.draft,
  ].map((key) => register(key, [])),
];

export interface RegistrationLookup {
  readonly definition_id: string;
  readonly stage: string;
  readonly artifact_kind: string;
  readonly artifact_schema_version: string;
}
export function selectRegistration(capture: RegistrationLookup, registrations = OAKRIDGE_REGISTRATIONS): Registration | undefined {
  return registrations.find(({ key }) => key.artifact === capture.artifact_kind && key.schema_version === capture.artifact_schema_version
    && (key.workflow === "$core" || (key.definition_id === capture.definition_id && key.stage === capture.stage)));
}

export const OAKRIDGE_SELECTORS: readonly RegisteredSelector[] = [...new Map(OAKRIDGE_REGISTRATIONS
  .flatMap(({ extractors }) => extractors.map(({ artifact_kind, item_selector, item_kind }) =>
    [JSON.stringify([artifact_kind, item_selector, item_kind]), { artifact_kind, item_selector, item_kind,
      item_fields: fieldsForItem(item_kind) }] as const))).values()];

function fieldsForItem(item_kind: string): readonly string[] {
  switch (item_kind) {
    case "build_item": return ["/id", "/instructions", "/requirement_ids", "/verification"];
    case "finding": return ["/id", "/severity", "/observation", "/evidence", "/expected_change_locations", "/resolution"];
    case "requirement": return ["/id", "/text", "/acceptance_conditions", "/source_refs", "/analysis_finding_ids"];
    case "allocation": return ["/requirement_id", "/contribution"];
    case "technical_decision": return ["/id", "/build_item_ids", "/decision", "/rationale"];
    case "item_assessment": return ["/subject/id", "/subject", "/status", "/observation", "/evidence"];
    case "additional_finding": return ["/id", "/severity", "/observation", "/related_build_item_ids", "/related_subjects", "/evidence"];
    case "feedback_proposal": return ["/key", "/instruction", "/citation"];
    case "assignment_verification": return ["/round_id", "/outcome"];
    case "case": return ["/id", "/group", "/is_control"];
    case "criterion": case "trigger": return ["/id", "/text"];
    case "cohort_file": return ["/id", "/case_ids", "/groups", "/file", "/digest", "/attempt_count", "/cap_cents", "/cost_basis"];
    case "qualification": return ["/case_id", "/reference_passes", "/omissions_isolated", "/controls_replayed", "/detail"];
    case "paid_result": return ["/case_id", "/model_id", "/outcome", "/detail", "/spend_cents", "/launch_command", "/store_path"];
    case "criterion_mark": case "trigger_mark": return ["/id", "/status", "/evidence"];
    case "hypothesis": return ["/id", "/statement"];
    case "outcome": return ["/id", "/rule"];
    case "blocker": return ["/text", "/suggested_choices"];
    default: return [];
  }
}
