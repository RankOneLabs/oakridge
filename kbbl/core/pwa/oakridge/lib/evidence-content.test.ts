import { describe, expect, test } from "vitest";
import type { ObservationJsonValue } from "../grading-contracts/domain/primitives";
import type { ObservationEvidenceReference } from "../grading-contracts/grading/evidence";
import { id } from "../__fixtures__/grading";
import assessment from "./__fixtures__/id-linked-assessment.json";
import brief from "./__fixtures__/id-linked-brief.json";
import plan from "./__fixtures__/id-linked-plan.json";
import { decodeEvidenceContent, selectEvidenceSummary } from "./evidence-content";

// These JSON fixtures contain a first finding and cohort; imported optional keys need the JSON wire type.
const revision = (ref: string, content: ObservationJsonValue, item_path: string | null = null): ObservationEvidenceReference =>
  ({ source: "revision", revision_id: id("assessment:2"), ref, item_path, content });
const reported = (ref: string, content: ObservationJsonValue): ObservationEvidenceReference =>
  ({ source: "reported", reported_by: "agent", revision_id: id("assessment:2"), ref, item_path: "/findings/0/evidence/0", content });
const task = { id: "T1", description: "Render frozen evidence as fields", requirement_ids: ["R1"] };
const criterion = { id: "T1", text: "Evidence is readable", decision_ids: ["fields"] };
const tests = { passed: 7, failed: 0, summary: "PWA checks pass", output: "7 tests passed" };
const build = { head_sha: "abc123", summary: "Render evidence fields", changed_files: ["kbbl/core/pwa"], tests, known_issues: [] };

describe("frozen evidence decoding", () => {
  test("subject assessment finding retains its addressed path and nullable description", () => {
    expect(decodeEvidenceContent(revision("subject", assessment.findings[0] as ObservationJsonValue, "/findings/3"))).toMatchObject({
      kind: "assessment_finding", value: { task_ids: ["criterion-brief"], status: "met", description: null, item_path: "/findings/3" },
    });
  });
  test("subject spec finding", () => {
    const value = { id: "F1", description: "Evidence needs labels", severity: "warning" };
    expect(decodeEvidenceContent(revision("subject", value))).toEqual({ kind: "finding", value });
  });
  test("subject task", () => expect(decodeEvidenceContent(revision("subject", task))).toEqual({ kind: "task", value: task }));
  test("spec task", () => expect(decodeEvidenceContent(revision("spec_task", task))).toEqual({ kind: "task", value: task }));
  test("subject acceptance entry", () => expect(decodeEvidenceContent(revision("subject", criterion))).toEqual({ kind: "acceptance_entry", value: criterion }));
  test("numbered requirement", () => {
    const value = { id: "R1", description: "Show labels", status: "implementable" };
    expect(decodeEvidenceContent(revision("requirement:2", value))).toEqual({ kind: "requirement", value });
  });
  test("whole plan", () => expect(decodeEvidenceContent(revision("plan", plan))).toEqual({ kind: "plan", value: plan }));
  test("contribution cohort", () => expect(decodeEvidenceContent(revision("contribution_context", plan.cohorts[0]!, "/cohorts/0"))).toEqual({ kind: "plan_cohort", value: plan.cohorts[0] }));
  test("contribution brief", () => expect(decodeEvidenceContent(revision("contribution_context", brief))).toEqual({ kind: "brief", value: brief }));
  test("build result uses parser defaults", () => expect(decodeEvidenceContent(revision("build_result", build))).toMatchObject({ kind: "build_result", value: { ...build, repository_key: null, delegated_session_metadata: null } }));
  test("reported test evidence uses parser defaults", () => expect(decodeEvidenceContent(reported("test_evidence", tests))).toEqual({ kind: "test_evidence", value: { ...tests, cargo_test_output: null } }));
  test("reported citation mirrors the producer", () => {
    const value = { kind: "test", citation: "bun run test:pwa", detail: null };
    expect(decodeEvidenceContent(reported("citation:1", value))).toEqual({ kind: "reported_citation", value });
  });
  test("repository file text", () => expect(decodeEvidenceContent({ source: "repository", ref: "citation:0", repository_key: "oakridge", commit_sha: "abc123", path: "a.ts", line_range: null, is_absent: false, is_binary: false, byte_size: null, content: "export const count = 1;" })).toEqual({ kind: "file_text", value: "export const count = 1;" }));
  test("launch spec text", () => expect(decodeEvidenceContent({ source: "run_input", run_id: id("run-1"), input_path: "/spec", ref: "spec", content: "Show evidence fields" })).toEqual({ kind: "spec_text", value: "Show evidence fields" }));
  test("revision spec text", () => expect(decodeEvidenceContent(revision("spec", "Updated spec"))).toEqual({ kind: "spec_text", value: "Updated spec" }));
  test.each([
    revision("subject", { task_ids: ["T1"], evidence: "invalid" }),
    revision("spec", { text: "wrong type" }),
    revision("task_context:0", task),
    revision("contribution_context", brief, "/cohorts/0"),
    revision("spec_task", criterion),
    reported("citation:0", { kind: "file", citation: "a.ts", detail: 1 }),
    reported("plan", plan),
    revision("test_evidence", tests),
    revision("unlisted", null),
  ])("preserves unsupported or malformed content ($ref, $source)", (reference) => {
    expect(decodeEvidenceContent(reference)).toEqual({ kind: "unknown", value: reference.content });
  });
});

test("only whole artifacts collapse to one-line summaries", () => {
  expect([
    revision("plan", plan), revision("build_result", build), revision("contribution_context", brief),
    revision("spec", "\n  First line\nSecond line"), revision("contribution_context", plan.cohorts[0]!, "/cohorts/0"), revision("subject", task),
  ].map((reference) => selectEvidenceSummary(decodeEvidenceContent(reference)))).toEqual([
    "Prepare the operator view. (1 cohort)", "Render evidence fields", "Operator view (pwa)", "First line", null, null,
  ]);
});
