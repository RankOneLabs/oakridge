import { expect, test } from "bun:test";
import { OAKRIDGE_REGISTRATIONS } from "../src/producers/oakridge/catalogue";
import { selectRevision } from "../src/projection/extractor";
import { logicalItemRelation, occurrenceRelation } from "../src/projection/relations";
import { fixtureBody } from "./grading-fixture";
import { studyBodies } from "./study-fixture";

const developmentFields: Readonly<Record<string, readonly string[]>> = {
  "analysis.analysis": ["analysis.requirements", "item.findings"],
  "analysis.spec": ["spec.requirements", "item.analysis_finding_ids"],
  "planning.plan": ["plan.cohorts", "item.allocations", "item.requirement_id"],
  "brief.brief": ["brief.repository_key", "item.requirement_ids", "item.build_item_ids"],
  "cohort.assessment": ["item.subject.kind", "item.subject.id", "item.related_build_item_ids", "item.citation"],
  "integration.assessment": ["item.subject.kind", "item.subject.id", "item.related_build_item_ids", "item.citation"],
};
const studyFields: Readonly<Record<string, readonly string[]>> = {
  "design.slice_build": ["slice_build.qualifications", "item.case_id"],
  "design.slice_report": ["slice_report.criteria_marks", "slice_report.trigger_marks", "slice_report.paid_results", "item.case_id"],
  "design.slice_assessment": ["item.subject.kind", "item.subject.id", "item.related_subjects", "item.citation"],
  "expand.expansion": ["expansion.qualifications", "item.case_id"],
  "expand.assessment": ["item.subject.kind", "item.subject.id", "item.related_subjects", "item.citation"],
  "freeze.freeze": ["freeze.cohorts", "item.case_ids"],
  "integration.assessment": ["item.subject.kind", "item.subject.id", "item.related_subjects", "item.citation"],
};

function artifactChecks(yaml: string, stage: string, artifact: string): string[] {
  const lines = yaml.split("\n");
  const stages = lines.indexOf("stages:");
  const stageIndex = lines.indexOf(`  ${stage}:`, stages + 1);
  const artifacts = lines.indexOf("    artifacts:", stageIndex + 1);
  const artifactIndex = lines.indexOf(`      ${artifact}:`, artifacts + 1);
  if (stageIndex < 0 || artifacts < 0 || artifactIndex < 0) return [];
  const boundary = lines.findIndex((line, index) => index > artifactIndex && /^ {0,6}[^\s#]/.test(line));
  return lines.slice(artifactIndex + 1, boundary < 0 ? undefined : boundary).filter((line) => /^          - (?:&\w+\s*)?check:/.test(line));
}

test("registered development and study links are producer-explicit and their authored fields are covered by validation", async () => {
  const sources = {
    development: await Bun.file(new URL("../../workflow-config/development.yaml", import.meta.url)).text(),
    study: await Bun.file(new URL("../../workflow-config/study.yaml", import.meta.url)).text(),
  };
  let relationCount = 0;
  for (const { key, extractors } of OAKRIDGE_REGISTRATIONS) {
    if (key.workflow !== "development" && key.workflow !== "study") continue;
    if (!extractors.length) continue;
    const address = `${key.stage}.${key.artifact}`;
    const body = key.workflow === "study" ? studyBodies[address] ?? studyBodies[key.artifact]
      : await fixtureBody(`current-${address === "integration.assessment" ? "integration" : key.artifact}`);
    if (body === undefined) throw new Error(`Missing fixture for ${address}`);
    const pass = selectRevision(body, "fixture", extractors);
    expect(pass.issues).toEqual([]);
    for (const { item } of pass.items) for (const link of item.links) {
      relationCount++;
      const relation = link.target === "logical_item" ? logicalItemRelation("from", link, "to") : occurrenceRelation("from", link, "to");
      expect(relation.asserted_by).toBe("producer_explicit");
    }
    const fields = (key.workflow === "study" ? studyFields : developmentFields)[address] ?? [];
    const checks = artifactChecks(sources[key.workflow], key.stage, key.artifact).join("\n");
    for (const field of fields) expect(checks).toContain(field);
  }
  expect(relationCount).toBeGreaterThan(20);
});
