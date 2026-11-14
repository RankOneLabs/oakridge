import { describe, expect, test } from "vitest";
import { parseAssessment, selectCheckStatus, selectCheckText, selectCriterionCounts, selectCriterionReport, type AssessmentFinding, type CheckTask, type CriterionCheck } from "./assessment";
import linkedAssessment from "./__fixtures__/id-linked-assessment.json";
import emptyEvidenceAssessment from "./__fixtures__/empty-evidence-assessment.json";
import unresolvedAssessment from "./__fixtures__/unresolved-assessment.json";
import linkedBrief from "./__fixtures__/id-linked-brief.json";
import { readBuildBrief } from "./build-brief";
import type { PlanCriterion, PlanTraceId } from "./plan";

const task = (id: string): PlanTraceId => id as PlanTraceId;
const criterion = (id: string, text: string): PlanCriterion => ({ id: task(id), text, decision_ids: [] });

interface FindingFields {
  status: AssessmentFinding["status"];
  task_ids?: string[];
  description?: string;
}

const finding = ({ status, task_ids = [], description }: FindingFields): AssessmentFinding => ({
  item_path: "/findings/0",
  task_ids: task_ids.map(task),
  status,
  evidence: [],
  description: description ?? null,
});

const label = (check: CriterionCheck) => (check.kind === "unassessed" ? `#${check.number}` : check.finding.description);

describe("parseAssessment", () => {
  const body = linkedAssessment;
  const validFinding = linkedAssessment.findings[0];

  const errorField = (findings: unknown[]) => {
    const parsed = parseAssessment({ ...body, findings });
    return parsed.ok ? null : parsed.error.field;
  };

  test("reads task links and typed references", () => {
    const parsed = parseAssessment(linkedAssessment);
    expect(parsed.ok && parsed.value.findings[0]).toEqual({
      item_path: "/findings/0",
      task_ids: ["criterion-brief"],
      status: "met",
      evidence: [
        { kind: "file", ref: "kbbl/core/pwa/oakridge/lib/build-brief.ts:100-110", detail: "Parser accepts linked criteria." },
        { kind: "test", ref: "build-brief.test.ts::reads id-linked brief", detail: null },
        { kind: "output", ref: "bun run test:pwa", detail: "Passed" },
      ],
      description: null,
    });
  });

  test("reads the recorded commit", () => {
    const parsed = parseAssessment(linkedAssessment);
    expect(parsed.ok && parsed.value.head_sha).toBe("abc123def456");
  });

  test("addresses each finding by its place in the revision", () => {
    const parsed = parseAssessment({ ...body, findings: [validFinding, validFinding] });
    expect(parsed.ok && parsed.value.findings.map((entry) => entry.item_path)).toEqual(["/findings/0", "/findings/1"]);
  });

  test("keeps an empty evidence list observable", () => {
    const parsed = parseAssessment(emptyEvidenceAssessment);
    expect(parsed.ok && parsed.value.findings[0]?.evidence).toEqual([]);
  });

  test("accepts a finding linked to no task", () => {
    const parsed = parseAssessment({ ...body, findings: [{ ...validFinding, task_ids: [] }] });
    expect(parsed.ok && (parsed.value.shape === "build_items" ? null : parsed.value.findings[0]?.task_ids)).toEqual([]);
  });

  test("refuses a finding with no task_ids", () => {
    const { task_ids: _, ...withoutTaskIds } = validFinding;
    expect(errorField([withoutTaskIds])).toBe("findings[0].task_ids");
  });

  test.each([["a blank id", [""]], ["a non-string id", [7]], ["a bare string", "criterion-brief"]])("refuses task_ids holding %s", (_, task_ids) => {
    expect(errorField([{ ...validFinding, task_ids }])).toBe("findings[0].task_ids");
  });

  test("refuses a finding that only names its criterion in prose", () => {
    expect(errorField([{ criterion: "It works.", status: "met", evidence: [] }])).toBe("findings[0].task_ids");
  });

  test("refuses prose evidence", () => {
    expect(errorField([{ ...validFinding, evidence: "It does not." }])).toBe("findings[0].evidence");
  });

  test("refuses a finding with no evidence list", () => {
    const { evidence: _, ...withoutEvidence } = validFinding;
    expect(errorField([withoutEvidence])).toBe("findings[0].evidence");
  });

  test("refuses a prose entry in an evidence list", () => {
    expect(errorField([{ ...validFinding, evidence: ["It does not."] }])).toBe("findings[0].evidence[0]");
  });

  test("names an unknown evidence kind at its entry", () => {
    expect(errorField([{ ...validFinding, evidence: [{ kind: "url", ref: "example" }] }])).toBe("findings[0].evidence[0].kind");
  });

  test("reads absent test evidence as null", () => {
    const parsed = parseAssessment({ ...body, test_evidence: null });
    expect(parsed.ok && parsed.value.test_evidence).toBeNull();
  });

  test("names a finding status outside the contract", () => {
    expect(errorField([validFinding, { ...validFinding, status: "done" }])).toBe("findings[1].status");
  });

  test("reads an omitted status and description as null", () => {
    const parsed = parseAssessment({ ...body, findings: [{ task_ids: [], evidence: [] }] });
    expect(parsed.ok && [parsed.value.findings[0]?.status, parsed.value.findings[0]?.description]).toEqual([null, null]);
  });

  test("names the field of broken test evidence", () => {
    const parsed = parseAssessment({ ...body, test_evidence: { passed: "3" } });
    expect(parsed.ok ? null : parsed.error.field).toBe("test_evidence.passed");
  });

  test("rejects a verdict outside the contract", () => {
    expect(parseAssessment({ ...body, verdict: "maybe" }).ok).toBe(false);
  });

  test("rejects string actions instead of converting them", () => {
    const parsed = parseAssessment({ ...body, recommended_next_actions: ["Old action"] });
    expect(parsed.ok ? null : parsed.error.field).toBe("recommended_next_actions");
  });
});

describe("selectCriterionReport", () => {
  const criteria = [criterion("T1", "One."), criterion("T2", "Two."), criterion("T3", "Three."), criterion("T4", "Four.")];
  const report = selectCriterionReport(criteria, [
    finding({ status: "met", task_ids: ["T2"], description: "Two holds." }),
    finding({ status: "partial", task_ids: ["T4"], description: "Four half holds." }),
    finding({ status: "not_met", task_ids: ["T1"], description: "One fails." }),
    finding({ status: "not_met", description: "Something else fails." }),
  ]);

  test("puts not met before partial before unassessed, finding order then brief order within each", () => {
    expect(report.needs_attention.map(label)).toEqual(["One fails.", "Something else fails.", "Four half holds.", "#3"]);
  });

  test("keeps met findings apart", () => {
    expect(report.met.map(label)).toEqual(["Two holds."]);
  });

  test("tallies findings and the brief tasks no finding names", () => {
    expect(report.tally).toEqual({ met: 1, partial: 1, not_met: 2, unassessed: 1 });
  });

  test("a finding linked to several tasks is one check and counts once", () => {
    const linked = selectCriterionReport(criteria.slice(0, 2), [finding({ status: "met", task_ids: ["T1", "T2"], description: "Both hold." })]);
    expect(linked.met).toHaveLength(1);
    expect(linked.tally).toEqual({ met: 1, partial: 0, not_met: 0, unassessed: 0 });
  });

  test("a finding names each of its tasks with the brief's number and wording", () => {
    const linked = selectCriterionReport(criteria.slice(0, 2), [finding({ status: "met", task_ids: ["T2", "T1"] })]);
    expect(linked.met[0]).toMatchObject({ tasks: [{ id: "T2", number: 2, text: "Two." }, { id: "T1", number: 1, text: "One." }], unresolved_task_ids: [] });
  });

  test("several findings for one task each stay visible and each count", () => {
    const shared = selectCriterionReport(criteria.slice(0, 1), [
      finding({ status: "met", task_ids: ["T1"], description: "First holds." }),
      finding({ status: "not_met", task_ids: ["T1"], description: "Second fails." }),
    ]);
    expect([shared.met.map(label), shared.needs_attention.map(label), shared.tally]).toEqual([
      ["First holds."], ["Second fails."], { met: 1, partial: 0, not_met: 1, unassessed: 0 },
    ]);
  });

  test("a finding linked to no task is valid and has nothing unresolved", () => {
    const unlinked = selectCriterionReport([], [finding({ status: "partial", description: "Unlinked." })]);
    expect(unlinked.needs_attention).toMatchObject([{ kind: "finding", tasks: [], unresolved_task_ids: [] }]);
  });

  test("an id the brief does not hold stays visible as unresolved beside the ids it does", () => {
    const unresolved = selectCriterionReport(criteria.slice(0, 1), [finding({ status: "not_met", task_ids: ["T1", "T9"] })]);
    expect(unresolved.needs_attention).toMatchObject([{ kind: "finding", unresolved_task_ids: ["T9"] }]);
  });

  test("a brief task no finding names is unassessed, with its brief number", () => {
    const unassessed = selectCriterionReport(criteria.slice(0, 2), [finding({ status: "met", task_ids: ["T1"] })]);
    expect(unassessed.needs_attention).toEqual([{ kind: "unassessed", number: 2, criterion: criteria[1] }]);
  });

  test("links by id across reordering and rewording of the brief", () => {
    const brief = readBuildBrief(linkedBrief);
    const parsed = parseAssessment(linkedAssessment);
    if (brief === null || brief.shape !== "legacy" || !parsed.ok || parsed.value.shape === "build_items") throw new Error("fixture failed to parse");
    const reworded = [...brief.acceptance_criteria].reverse().map((entry) => ({ ...entry, text: `Reworded: ${entry.text}` }));
    expect(selectCriterionReport(reworded, parsed.value.findings).met).toMatchObject([
      { tasks: [{ id: "criterion-brief", number: 2, text: "Reworded: The brief remains readable." }], unresolved_task_ids: [] },
    ]);
  });

  test("never links by wording: matching text under an unknown id leaves the task unassessed", () => {
    const wordy = selectCriterionReport(criteria.slice(0, 1), [finding({ status: "met", task_ids: ["T9"], description: "One." })]);
    expect(wordy.met).toMatchObject([{ unresolved_task_ids: ["T9"] }]);
    expect(wordy.needs_attention).toMatchObject([{ kind: "unassessed", number: 1 }]);
  });

  test("reports an unknown fixture id as unresolved and leaves the brief's tasks unassessed", () => {
    const brief = readBuildBrief(linkedBrief);
    const parsed = parseAssessment(unresolvedAssessment);
    if (brief === null || brief.shape !== "legacy" || !parsed.ok || parsed.value.shape === "build_items") throw new Error("fixture failed to parse");
    const unresolved = selectCriterionReport(brief.acceptance_criteria, parsed.value.findings);
    expect(unresolved.needs_attention.map((check) => check.kind === "unassessed" ? `#${check.number}` : check.unresolved_task_ids)).toEqual([
      ["criterion-missing"], "#1", "#2",
    ]);
  });

  test("an integration assessment has no brief, so no id is unresolved and no task unassessed", () => {
    const integration = selectCriterionReport(null, [finding({ status: "partial", task_ids: ["T9"], description: "Alone." })]);
    expect(integration.needs_attention).toMatchObject([{ kind: "finding", tasks: [{ id: "T9", number: null, text: null }], unresolved_task_ids: [] }]);
    expect(integration.tally).toEqual({ met: 0, partial: 1, not_met: 0, unassessed: 0 });
  });

  test("a finding with no status reads as unassessed but remains a finding", () => {
    const unstated = selectCriterionReport(criteria.slice(0, 1), [finding({ status: null, task_ids: ["T1"] })]);
    expect([unstated.needs_attention.map((check) => check.kind), unstated.tally.unassessed]).toEqual([["finding"], 1]);
  });
});

describe("selectCheckStatus", () => {
  test("reads an unassessed task as having no status", () => {
    expect(selectCheckStatus({ kind: "unassessed", number: 1, criterion: criterion("T1", "One.") })).toBeNull();
  });
});

describe("selectCheckText", () => {
  const checkFor = (fields: FindingFields, tasks: CheckTask[] = [{ id: task("T1"), number: 1, text: "One." }]): CriterionCheck => ({
    kind: "finding", finding: finding(fields), tasks, unresolved_task_ids: [],
  });

  test("reads a finding by what it says", () => {
    expect(selectCheckText(checkFor({ status: "met", description: "It holds." }))).toBe("It holds.");
  });

  test("falls back to the wording of the task it names", () => {
    expect(selectCheckText(checkFor({ status: "met" }))).toBe("One.");
  });

  test("skips a named task the brief does not hold", () => {
    expect(selectCheckText(checkFor({ status: "met" }, [{ id: task("T9"), number: null, text: null }, { id: task("T1"), number: 1, text: "One." }]))).toBe("One.");
  });

  test("calls a finding with neither unnamed", () => {
    expect(selectCheckText(checkFor({ status: "met" }, []))).toBe("Unnamed finding");
  });

  test("reads an unassessed task by the brief's wording", () => {
    expect(selectCheckText({ kind: "unassessed", number: 1, criterion: criterion("T1", "One.") })).toBe("One.");
  });
});

describe("selectCriterionCounts", () => {
  test("drops empty counts and leads with the worst", () => {
    expect(selectCriterionCounts({ met: 3, partial: 0, not_met: 1, unassessed: 0 })).toEqual([
      { status: "not_met", count: 1 },
      { status: "met", count: 3 },
    ]);
  });
});
