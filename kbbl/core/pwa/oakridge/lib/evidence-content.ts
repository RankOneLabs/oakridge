import type { ObservationEvidenceReference } from "../grading-contracts/grading/evidence";
import type { ObservationJsonValue } from "../grading-contracts/domain/primitives";
import { parseAssessmentFinding, type AssessmentFinding } from "./assessment";
import { readBuildBrief, type BuildBrief } from "./build-brief";
import { parseBuildResult, parseTestEvidence, type BuildResult, type TestEvidence } from "./build-result";
import { parseCohort, parsePlan, parsePlanCriterion, type Plan, type PlanCohort, type PlanCriterion } from "./plan";
import { isSpecFinding, isSpecRequirement, type SpecFinding, type SpecRequirement } from "./spec-analysis";
import { parseTask, type Task } from "./tasks";

/** Mirrors reported() in observation/src/producers/oakridge/evidence.ts. */
export interface ReportedCitation {
  kind: "file" | "test" | "output";
  citation: string;
  detail: string | null;
}

export type EvidenceContent =
  | { kind: "finding"; value: SpecFinding }
  | { kind: "assessment_finding"; value: AssessmentFinding }
  | { kind: "task"; value: Task }
  | { kind: "acceptance_entry"; value: PlanCriterion }
  | { kind: "requirement"; value: SpecRequirement }
  | { kind: "plan"; value: Plan }
  | { kind: "plan_cohort"; value: PlanCohort }
  | { kind: "brief"; value: BuildBrief }
  | { kind: "build_result"; value: BuildResult }
  | { kind: "test_evidence"; value: TestEvidence }
  | { kind: "reported_citation"; value: ReportedCitation }
  | { kind: "file_text"; value: string }
  | { kind: "spec_text"; value: string }
  | { kind: "unknown"; value: ObservationJsonValue };

function isReportedCitation(value: unknown): value is ReportedCitation {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "kind" in value && "citation" in value && "detail" in value
    && (value.kind === "file" || value.kind === "test" || value.kind === "output")
    && typeof value.citation === "string" && (value.detail === null || typeof value.detail === "string");
}

/** The subject family also supplies the item header, without inventing reference provenance. */
export function decodeSubjectContent(value: ObservationJsonValue, item_path: string): EvidenceContent {
  const assessment = parseAssessmentFinding(value, "subject", item_path);
  if (assessment.ok) return { kind: "assessment_finding", value: assessment.value };
  if (isSpecFinding(value)) return { kind: "finding", value };
  const task = parseTask(value, "subject");
  if (task.ok) return { kind: "task", value: task.value };
  const criterion = parsePlanCriterion(value, "subject");
  if (criterion.ok) return { kind: "acceptance_entry", value: criterion.value };
  return { kind: "unknown", value };
}

/** Dispatch by the producer's reference family and source, never by unrelated shapes. */
export function decodeEvidenceContent(reference: ObservationEvidenceReference): EvidenceContent {
  const { content: value, source } = reference;
  const family = reference.ref.replace(/:\d+$/, "");
  const itemPath = "item_path" in reference ? reference.item_path ?? "" : "";
  switch (family) {
    case "subject": {
      if (source !== "revision") break;
      return decodeSubjectContent(value, itemPath);
    }
    case "spec":
      if ((source === "run_input" || source === "revision") && typeof value === "string") return { kind: "spec_text", value };
      break;
    case "build_result": {
      if (source !== "revision") break;
      const parsed = parseBuildResult(value);
      if (parsed.ok) return { kind: "build_result", value: parsed.value };
      break;
    }
    case "spec_task": {
      if (source !== "revision") break;
      const parsed = parseTask(value, "spec_task");
      if (parsed.ok) return { kind: "task", value: parsed.value };
      break;
    }
    case "requirement":
      if (source === "revision" && isSpecRequirement(value)) return { kind: "requirement", value };
      break;
    case "plan": {
      if (source !== "revision") break;
      const parsed = parsePlan(value);
      if (parsed.ok) return { kind: "plan", value: parsed.value };
      break;
    }
    case "contribution_context": {
      if (source !== "revision") break;
      if (/^\/cohorts\/\d+$/.test(itemPath)) {
        const parsed = parseCohort(value, itemPath);
        if (parsed.ok) return { kind: "plan_cohort", value: parsed.value };
      } else {
        const brief = readBuildBrief(value);
        if (brief) return { kind: "brief", value: brief };
      }
      break;
    }
    case "test_evidence": {
      if (source !== "reported") break;
      const parsed = parseTestEvidence(value, "test_evidence");
      if (parsed.ok) return { kind: "test_evidence", value: parsed.value };
      break;
    }
    case "citation":
      if (source === "repository" && typeof value === "string") return { kind: "file_text", value };
      if (source === "reported" && isReportedCitation(value)) return { kind: "reported_citation", value };
      break;
  }
  return { kind: "unknown", value };
}

/** Whole artifacts have a compact first line; short references render inline. */
export function selectEvidenceSummary(content: EvidenceContent): string | null {
  const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
  switch (content.kind) {
    case "plan": return `${oneLine(content.value.summary)} (${content.value.cohorts.length} cohorts)`;
    case "build_result": return oneLine(content.value.summary);
    case "brief": return `${oneLine(content.value.title)} (${content.value.cohort_id})`;
    case "spec_text": return content.value.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "Spec";
    default: return null;
  }
}
