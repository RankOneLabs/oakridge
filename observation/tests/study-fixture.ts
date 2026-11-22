import type { JsonValue } from "../src/domain/primitives";

export const subject = (kind: string, id: string) => ({ subject: { kind, id }, status: "met", observation: "Verified", evidence: [] });
export const assessment = (head_sha: string, item_assessments: readonly JsonValue[], additional_findings: readonly JsonValue[] = []) => ({
  head_sha, item_assessments, additional_findings, proposals: [], verifications: [], test_evidence: { passed: 1, failed: 0 },
  verdict: additional_findings.length ? "pass_with_notes" : "pass",
});
const build = (cohort_id: string, head_sha: string) => ({ cohort_id, head_sha, title: cohort_id, summary: "Study fixture", changed_files: [] });
const qualification = { case_id: "A1", reference_passes: true, omissions_isolated: true, controls_replayed: true, detail: "Qualified" };
const digest = "sha256:fixture";
const pr = { pr_url: "https://example.test/oakridge/pull/1", branch: "study-fixture", summary: "Study fixture" };
const pr_state = { url: pr.pr_url, state: "open", number: 1, head_sha: null, merged_at: null };
export const studyBodies: Readonly<Record<string, JsonValue>> = {
  plan: {
    question: "Does the result generalize?", hypotheses: [{ id: "H1", statement: "Case omissions affect scores" }],
    cases: [{ id: "A1", group: "group", is_control: true }], groups: [{ id: "group", case_ids: ["A1"] }],
    outcomes: [{ id: "O1", rule: "Compare the control" }], decision_rule: [{ condition: "Comparable", next_step: "Expand" }],
    models: [{ id: "M1", route: "test/model", per_attempt_cap_cents: 50, expected_cost_per_attempt: { cents: 20, basis: "assumption" } }],
    pilot_selection: { case_ids: ["A1"], risk_reason: "Control", criteria: [{ id: "A1", text: "Control scores" }] },
    slice_paid: { models: ["M1"], repeats: 1, cap_cents: 50 },
    full_study_repeats: 1, iteration_triggers: [{ id: "T1", text: "Revisit if its control fails" }],
  },
  slice_build: { build: build("slice", "slice-head"), generator_digest: digest, case_ids: ["A1"], qualifications: [qualification],
    digest_recipe: { files: ["generator.py"], command: "sha256sum generator.py" } },
  slice_report: { run_key: "slice-paid", generator_digest: digest, qualifications: [qualification],
    paid_results: [{ case_id: "A1", model_id: "M1", outcome: "scored", detail: "Scored", spend_cents: 20,
      launch_command: "run-cohort slice.json", store_path: "slice/A1" }],
    criteria_marks: [{ id: "A1", status: "met", evidence: "Scored" }], trigger_marks: [{ id: "T1", status: "not_fired", evidence: "Control scored" }],
    proposed_changes: [] },
  slice_assessment: { ...assessment("slice-head", [subject("case", "A1"), subject("criterion", "A1"), subject("trigger", "T1")],
    [{ id: "F1", severity: "warning", observation: "Monitor the control", related_subjects: [{ kind: "case", id: "A1" }], evidence: [] }]),
    proposals: [{ key: "control", instruction: "Retain the control's score", citation: { revision_id: "design:slice_report:1", pointer: "/criteria_marks/0" } }],
    run_key: "slice-paid" },
  expansion: { build: build("group", "expand-head"), generator_digest: digest, case_ids: ["A1"], qualifications: [qualification] },
  "expand.assessment": assessment("expand-head", [subject("case", "A1")]),
  "integration.assessment": assessment("integration-head", [subject("case", "A1"), subject("cohort_file", "C1")]),
  freeze: { build: build("freeze", "freeze-head"), generator_digest: digest, image_digest: "image", is_byte_identical: true,
    cohorts: [{ id: "C1", case_ids: ["A1"], groups: ["group"], file: "cohort.json", digest, attempt_count: 1, cap_cents: 50, cost_basis: "per_attempt_cap" }] },
  pr, pr_state, observed_state: pr_state,
  manual_merge_target: pr,
  workspace: { repository_path: "/tmp/study", push_remote_owner: "example", head: "abc", base_branch: "capture" },
  spend_request: { cohort_file: "slice.json", attempt_count: 1, cap_cents: 50, generator_digest: digest, case_ids: ["A1"] },
};
