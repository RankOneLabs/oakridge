import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GradingCounts, HumanSubmissionReadback } from "../verification/proof-contract";
import { humanAnswerChecks, scanDefinitions } from "../verification/workspace";

const submission = (label: string, overrides: Partial<HumanSubmissionReadback> = {}): HumanSubmissionReadback => ({ label, status: 201, code: null, submission_id: "s", reviewer_id: "oakridge-operator",
  observation_id: "first-observation", execution_id: "x", evidence_set_id: "evidence", corrects_observation_id: null, ...overrides });
const counts = (overrides: Partial<GradingCounts> = {}): GradingCounts => ({ observations: 5, executions: 5, requests_sent: 9, authority_events: 40, ...overrides });
const passing = { machine_evidence_set_id: "evidence", before: counts(), after_first: counts({ observations: 6 }), after_duplicate: counts({ observations: 6 }), after_correction: counts({ observations: 7 }),
  submissions: [submission("first"), submission("spoofed", { status: 200 }), submission("duplicate", { status: 200 }), submission("correction", { observation_id: "second", corrects_observation_id: "first-observation" })] };
const failed = (input: typeof passing) => humanAnswerChecks(input).filter((check) => !check.passed).map((check) => check.name);

describe("the live human checks", () => {
  test("pass on what a correct service returns", () => { expect(failed(passing)).toEqual([]); });
  test("fail when a request field impersonates a reviewer", () => {
    expect(failed({ ...passing, submissions: passing.submissions.map((entry) => entry.label === "spoofed" ? { ...entry, reviewer_id: "someone-else" } : entry) })).toEqual(["browser reviewer and evaluator fields impersonate nobody"]);
  });
  test("fail when a duplicate appends a row", () => {
    expect(failed({ ...passing, after_duplicate: counts({ observations: 7 }), after_correction: counts({ observations: 8 }) })).toEqual(["a duplicate submission id acknowledges the original and changes nothing"]);
  });
  test("fail when a human answer does not share the machine's evidence", () => {
    expect(failed({ ...passing, machine_evidence_set_id: "other" })).toEqual(["it shares the frozen evidence the machine answer used"]);
  });
  test("fail when a correction overwrites or does not link", () => {
    expect(failed({ ...passing, submissions: passing.submissions.map((entry) => entry.label === "correction" ? { ...entry, corrects_observation_id: null } : entry) })).toEqual(["a correction appends one linked answer on the same evidence"]);
  });
  test("fail when a human answer sends a provider request or writes authority", () => {
    expect(failed({ ...passing, after_correction: counts({ observations: 7, requests_sent: 10, authority_events: 41 }) })).toEqual(["no human answer or correction sent a provider request", "no human answer or correction wrote an authority event"]);
  });
  test("an unread authority count is not an unchanged one", () => {
    expect(failed({ ...passing, before: counts({ authority_events: null }), after_correction: counts({ observations: 7, authority_events: null }) })).toEqual(["no human answer or correction wrote an authority event"]);
  });
});

test("the definition scan names any retained definition carrying a discarded field", () => {
  const root = mkdtempSync(join(tmpdir(), "definition-scan-"));
  mkdirSync(join(root, "workflows"));
  mkdirSync(join(root, "operations"));
  writeFileSync(join(root, "workflows", "clean.json"), JSON.stringify({ source: { stages: { a: { workers: { w: { kind: "agent" } } } } } }));
  writeFileSync(join(root, "operations", "registry.json"), JSON.stringify({ operations: [] }));
  writeFileSync(join(root, "launchable.json"), JSON.stringify([]));
  expect(scanDefinitions(root)).toEqual({ scanned: 1, with_discarded_field: [], files_scanned: 3, files_naming_gated_review: [] });
  writeFileSync(join(root, "workflows", "dirty.json"), JSON.stringify({ source: { stages: { a: { workers: { w: { gated_review: { kind: "unscoped" } } } } } } }));
  expect(scanDefinitions(root).with_discarded_field).toEqual(["dirty.json:/source/stages/a/workers/w/gated_review"]);
});

test("the definition scan reads operation registries and the launchable list whole for any gated_review key", () => {
  const root = mkdtempSync(join(tmpdir(), "definition-scan-"));
  mkdirSync(join(root, "workflows"));
  mkdirSync(join(root, "operations"));
  writeFileSync(join(root, "operations", "registry.json"), JSON.stringify({ operations: [{ id: "o", settings: { gated_review: true } }] }));
  writeFileSync(join(root, "launchable.json"), JSON.stringify([{ id: "w" }]));
  expect(scanDefinitions(root).files_naming_gated_review).toEqual([join("operations", "registry.json")]);
});

test("the retained definitions in this repository name no gated_review anywhere", () => {
  const scan = scanDefinitions();
  expect(scan.scanned).toBeGreaterThan(0);
  expect([...scan.with_discarded_field, ...scan.files_naming_gated_review]).toEqual([]);
});
