import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { canonicalDigest } from "canonical-json";
import { regenerateLiveFixtures } from "../scripts/regenerate-live-fixtures";
import type { LiveReport } from "../scripts/jev-live-walkthrough";
import type { SourceEventDelivery } from "../src/ingest/cursor";

interface VerifiedFiles { readonly capture: string; readonly rows: string; readonly grade: string }
interface FixtureIdentity { readonly run_id: string; readonly definition_id: string; readonly failure_cases: object }
const root = resolve(import.meta.dir, "../..");
const files = await Bun.file(join(root, "observation/verification/latest.json")).json() as VerifiedFiles;

test("the fixture run and revision bodies match the capture verified by the recorded real grade", async () => {
  const capture = await Bun.file(join(root, files.capture)).json() as SourceEventDelivery[];
  const report = await Bun.file(join(root, files.grade)).json() as LiveReport;
  const digest = canonicalDigest(capture);
  if (!digest.ok) throw new Error(digest.error.detail);
  expect(String(digest.value)).toBe(report.capture_digest);
  let previous = { commit_txid: "0", id: "" };
  for (const delivery of capture) {
    expect(delivery.previous).toEqual(previous);
    expect(delivery.outcome.run_id).toBe(report.run_id);
    previous = delivery.cursor;
  }
  const events = await Bun.file(join(root, "observation/fixtures/oakridge/run-slice/events.json")).json() as FixtureIdentity;
  expect(events.run_id).toBe(report.run_id);
  expect(events.definition_id).toBe(report.records.question.expected_definition_id);
  expect(report.question_id).toBe("plan.criterion_traceability");
  expect(report.execution_id).toBe(report.records.observation.execution_id);
  expect(report.records.execution.status).toBe("completed");
  expect(report.records.evaluator.provider).toBe("typesafe");
  expect(report.raw_answer).toEqual(report.records.execution.reproducibility_metadata.raw_answer);
  expect(report.probabilities).toEqual(report.records.observation.probabilities);
  expect(Object.keys(events.failure_cases).sort()).toEqual(["duplicate_item", "reordered_criterion_ids", "revision_update",
    "missing_source_ref", "conflicting_duplicate", "incomplete_evidence", "repeated_delivery", "grader_failure", "human_correction"].sort());
});

test("fixture regeneration refuses an unverified capture before changing any fixture", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observation-regeneration-"));
  try {
    const report = await Bun.file(join(root, files.grade)).json() as LiveReport;
    const grade = join(directory, "grade.json");
    await Bun.write(grade, JSON.stringify({ ...report, capture_digest: "changed" }));
    const sentinel = join(directory, "events.json");
    await Bun.write(sentinel, "original fixtures");
    await expect(regenerateLiveFixtures({ capture: join(root, files.capture), rows: join(root, files.rows),
      grade, output: directory })).rejects.toThrow("grade did not verify these exact capture bytes");
    expect(await Bun.file(sentinel).text()).toBe("original fixtures");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
