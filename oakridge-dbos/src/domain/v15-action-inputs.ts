/** Action payload fields mirror the named worker inputs in dev-flow-v15.ts. */
import type { V15BindingSource, V15WorkerKey } from "./dev-flow-v15";

export type BindingType = "text" | "run_repository" | "repository_refs" | "prepared_repository" | "artifact_ref" | "nullable_artifact_ref" | "repositories" | "brief_collection" | "completed_cohorts" | "build_outputs" | "accepted_build" | "interruption" | "build_work" | "assessment_work" | "spec_work" | "plan_work" | "brief_work" | "artifact_feedback" | "brief_feedback" | "build_feedback" | "assessment_feedback" | "pr_observation" | "provision_inputs" | "spec_inputs" | "plan_inputs" | "brief_inputs" | "final_inputs";
export interface PayloadContract { readonly fields: Readonly<Record<string, BindingType>>; readonly available: readonly V15BindingSource[] }
interface WorkerPayloadContracts { readonly worker: V15WorkerKey; readonly actions: Readonly<Record<string, PayloadContract>> }
const payload = (fields: PayloadContract["fields"], available: PayloadContract["available"]): PayloadContract => ({ fields, available });
// Destination field types mirror the named inputs in the committed schemas.
// Availability is action-local; knowing a source name alone never makes its
// value available during initial work, another worker's retry, or revision.
export const V15_PAYLOAD_CONTRACTS: readonly WorkerPayloadContracts[] = [
  { worker: "provision", actions: { initial: payload({ repository: "run_repository", base_branch: "text" }, ["inputs.repository", "inputs.base_branch"]), retry: payload({ original: "provision_inputs", interrupted: "interruption" }, ["inputs", "provision.interrupted.execution"]) } },
  ...(["spec", "plan", "brief"] as const).map((worker): WorkerPayloadContracts => {
    const current: V15BindingSource = worker === "spec" ? "spec.outputs.spec_analysis" : worker === "plan" ? "plan.outputs.plan" : "brief.outputs.briefs";
    const initial = worker === "spec" ? payload({ brief_notes: "text", repositories: "repositories" }, ["inputs.brief_notes", "inputs.repositories"])
      : worker === "plan" ? payload({ spec_analysis: "artifact_ref", repositories: "repositories" }, ["inputs.spec_analysis", "inputs.repositories"])
        : payload({ plan: "artifact_ref", repositories: "repositories" }, ["inputs.plan", "inputs.repositories"]);
    return { worker, actions: { initial, revise: payload({ original: `${worker}_inputs`, current: worker === "brief" ? "brief_collection" : "artifact_ref", feedback: worker === "brief" ? "brief_feedback" : "artifact_feedback" }, ["inputs", current, "request.feedback"]),
      retry: payload({ work: `${worker}_work`, interrupted: "interruption", current: worker === "brief" ? "brief_collection" : "nullable_artifact_ref" }, [`${worker}.interrupted.work`, `${worker}.interrupted.execution`, `${worker}.interrupted.current`]) } };
  }),
  { worker: "build", actions: {
    initial: payload({ brief: "artifact_ref", repository: "prepared_repository" }, ["inputs.brief", "inputs.repository"]),
    revise: payload({ brief: "artifact_ref", repository: "prepared_repository", current_build: "build_outputs", feedback: "build_feedback" }, ["inputs.brief", "inputs.repository", "build.outputs", "request.feedback"]),
    retry: payload({ work: "build_work", interrupted: "interruption", build_result: "nullable_artifact_ref", pr_summary: "nullable_artifact_ref" }, ["build.interrupted.work", "build.interrupted.execution", "build.interrupted.build_result", "build.interrupted.pr_summary"]),
    replace_pr: payload({ brief: "artifact_ref", repository: "prepared_repository", current_build: "build_outputs", closed_pr: "pr_observation" }, ["inputs.brief", "inputs.repository", "build.outputs", "observations.pr"]),
  } },
  { worker: "assessment", actions: {
    initial: payload({ brief: "artifact_ref", repository: "prepared_repository", accepted_build: "accepted_build" }, ["inputs.brief", "inputs.repository", "accepted_build"]),
    discuss: payload({ brief: "artifact_ref", repository: "prepared_repository", accepted_build: "accepted_build", current_assessment: "artifact_ref", feedback: "assessment_feedback" }, ["inputs.brief", "inputs.repository", "assessment.work.input.accepted_build", "assessment.outputs.assessment", "request.feedback"]),
    retry: payload({ work: "assessment_work", interrupted: "interruption", assessment: "nullable_artifact_ref" }, ["assessment.interrupted.work", "assessment.interrupted.execution", "assessment.interrupted.assessment"]),
  } },
  { worker: "final_integration", actions: {
    initial: payload({ repository: "repository_refs", completed_cohorts: "completed_cohorts" }, ["inputs.repository", "inputs.completed_cohorts"]),
    retry: payload({ original: "final_inputs", interrupted: "interruption", current: "nullable_artifact_ref" }, ["inputs", "final_integration.interrupted.execution", "final_integration.interrupted.current"]),
  } },
];
