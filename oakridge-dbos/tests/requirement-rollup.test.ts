import { expect, test } from "bun:test";
import { selectRequirementRollup, type RequirementRollupRead } from "../src/projections/requirement-rollup";
import type { RevisionId, UnitId } from "../src/domain/primitives";
const revision = (id: string, unit: string, artifact: string, body: unknown, seq = 1): RequirementRollupRead["revisions"][number] => ({ id: id as RevisionId, unit_id: unit as UnitId, artifact, body, seq });
const accepted = (target: string, review = "integration_review"): RequirementRollupRead["decisions"][number] => ({ target_revision_id: target as RevisionId, review, effect: "approve" });
const assessment = (status: "met" | "partial", head_sha: string) => ({ head_sha, verdict: status === "met" ? "pass" : "fail", test_evidence: { passed: 1, failed: 0 },
  item_assessments: [{ subject: { kind: "requirement", id: "R1" }, status, observation: "judged", evidence: [] }], next_actions: [], additional_findings: [] });
function fixture(): RequirementRollupRead {
  return {
    units: ["repo-a", "repo-b"].map(id => ({ id: id as UnitId, stage: "integration", input: { repository: { key: id }, briefs: [{ build_items: [{ requirement_ids: ["R1", "R2"] }] }] } })),
    revisions: [revision("spec:1", "analysis", "spec", { requirements: [{ id: "R1" }, { id: "R2" }] }),
      revision("a:1", "repo-a", "assessment", assessment("met", "sha-a")), revision("b:1", "repo-b", "assessment", assessment("partial", "sha-b"))],
    decisions: [accepted("spec:1", "spec_review"), accepted("a:1"), accepted("b:1")],
  };
}
test("one canonical requirement retains both approved repository judgments", () => expect(selectRequirementRollup(fixture())[0]).toEqual({
  requirement_id: "R1", status: "judged", repositories: [
    { repository_key: "repo-a", status: "met", revision_id: "a:1", head_sha: "sha-a" },
    { repository_key: "repo-b", status: "partial", revision_id: "b:1", head_sha: "sha-b" },
  ],
}));
test("unapproved assessments and unjudged requirements are pending", () => {
  const read = fixture();
  const rollup = selectRequirementRollup({ ...read, decisions: read.decisions.slice(0, 1) });
  expect(rollup.map(row => ({ status: row.status, repositories: row.repositories.map(repo => repo.status) })))
    .toEqual([{ status: "pending", repositories: ["pending", "pending"] }, { status: "pending", repositories: ["pending", "pending"] }]);
});
test("the latest accepted revision wins while a newer unapproved one is ignored", () => {
  const read = fixture();
  const revisions = [...read.revisions, revision("a:2", "repo-a", "assessment", assessment("partial", "accepted-sha"), 2), revision("a:3", "repo-a", "assessment", assessment("met", "draft-sha"), 3)];
  expect(selectRequirementRollup({ ...read, revisions, decisions: [...read.decisions, accepted("a:2")] })[0].repositories[0].revision_id).toBe("a:2");
});
test("a repository whose briefs do not include a requirement contributes no judgment", () => {
  const read = fixture();
  expect(selectRequirementRollup({ ...read, units: [read.units[0], { ...read.units[1], input: { repository: { key: "repo-b" }, briefs: [] } }] })[0].repositories).toHaveLength(1);
});
test("rollup evaluation leaves the source snapshot unchanged", () => {
  const read = fixture(); const before = JSON.stringify(read);
  selectRequirementRollup(read);
  expect(JSON.stringify(read)).toBe(before);
});
