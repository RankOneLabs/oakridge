/**
 * The cumulative report: one record tying the brief's live matrix to the proof reports that hold it,
 * beside the offline contract results that must stay with them. It reads reports and runs named test
 * files; it starts no stack and sends no provider request. A missing or failed report reads as failed.
 *
 *   bun observation/verification/cumulative.ts --workspace <proof_id> --grading <proof_id> --relations <proof_id>
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ProofReport } from "./proof-contract";
import { scanDefinitions } from "./workspace";

const ROOT = resolve(import.meta.dir, "../..");
const REPORTS = resolve(import.meta.dir, "reports");

/** Which proof holds each part of the live matrix, and what it cannot reach. */
const MATRIX = [
  { part: "first assessment finding, fresh service, provider and human answers in the PWA with no task", proof: "workspace" },
  { part: "all questions; automatic on admits ready questions, off sends nothing and takes human answers", proof: "grading" },
  { part: "human answer with automatic grading off", proof: "workspace" },
  { part: "analysis graded before tasks, late explicit link, unlinked control, original grades in the composite", proof: "relations" },
  { part: "shared task through two cohorts, revised plan and briefs, several findings, unresolved references", proof: "relations" },
  { part: "per-run spend, budget_deferred, no stage cap", proof: "grading" },
  { part: "replay and restart, lease recovery, stale claim refusal, atomic completion, exhausted failure", proof: "grading" },
  { part: "not-ready capture, grader swap and restart, pinned evaluators, nothing regraded", proof: "grading" },
  { part: "not-ready question refused alone, in API and browser", proof: "workspace" },
  { part: "correction, duplicate, spoofing, acknowledged save, every viewer opens one occurrence", proof: "workspace" },
  { part: "hidden mode leaks nothing; reveal before any answer; composites reveal separately", proof: "workspace" },
  { part: "accept and request-changes create no grade; grades and corrections write no authority event", proof: "workspace" },
] as const;

interface ReportSummary { readonly proof_id: string; readonly status: string; readonly git_head: string | null; readonly passed_checks: number; readonly failed_checks: readonly string[];
  readonly runs: readonly string[]; readonly provider_request_count: number | null }
async function summarize(proof_id: string | undefined): Promise<ReportSummary | null> {
  if (!proof_id) return null;
  const file = Bun.file(join(REPORTS, proof_id, "report.json"));
  if (!await file.exists()) return null;
  const report = await file.json() as ProofReport;
  return { proof_id, status: report.status, git_head: report.source.git_head, passed_checks: report.scenario.checks.filter((check) => check.passed).length,
    failed_checks: report.scenario.checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`),
    runs: report.scenario.evidence.runs.map((run) => run.run_id), provider_request_count: report.scenario.evidence.provider_request_count };
}

interface SuiteResult { readonly command: string; readonly exit_code: number; readonly summary: readonly string[] }
function runSuite(paths: readonly string[]): SuiteResult {
  const command = ["bun", "test", ...paths];
  const ran = Bun.spawnSync(command, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const output = `${ran.stdout.toString()}\n${ran.stderr.toString()}`;
  return { command: command.join(" "), exit_code: ran.exitCode, summary: output.split("\n").filter((line) => /^\s*\d+ (pass|fail)\b|^Ran \d+ tests/.test(line)).map((line) => line.trim()) };
}

const { values } = parseArgs({ options: { workspace: { type: "string" }, grading: { type: "string" }, relations: { type: "string" } } });
const proofs = { workspace: await summarize(values.workspace), grading: await summarize(values.grading), relations: await summarize(values.relations) };
const tools = await Bun.file(resolve(import.meta.dir, "gated-review-tools.json")).json().catch(() => null) as { readonly status?: string; readonly endpoint?: string; readonly tool_names?: readonly string[] } | null;
const definition_scan = scanDefinitions();
const offline = [runSuite(["observation/tests/target-schema.test.ts", "observation/tests/import-boundaries.test.ts"]), runSuite(["workflow-config/src/task-contracts.test.ts"])];
const matrix = MATRIX.map(({ part, proof }) => ({ part, proof, proof_id: proofs[proof]?.proof_id ?? null, status: proofs[proof]?.status ?? "missing" }));
const report = { generated_at: new Date().toISOString(), proofs, matrix,
  review_endpoint: { status: tools?.status ?? "missing", endpoint: tools?.endpoint ?? null, has_merge_pr: tools?.tool_names?.includes("merge_pr") ?? null, has_mark_merge_ready: tools?.tool_names?.includes("mark_merge_ready") ?? null },
  definition_scan, offline_contracts: offline,
  not_live_proof: "offline_contracts are contract results kept beside this report; they stand in for no live scenario.",
  not_reachable: "A real integration publication needs an operator's merge, so integration final and a real integration finding are read only on labelled synthetic revisions (relations) and in browser fixtures." };
const passed = matrix.every((row) => row.status === "passed") && report.review_endpoint.status === "passed" && definition_scan.with_discarded_field.length === 0 && offline.every((suite) => suite.exit_code === 0);
const directory = join(REPORTS, `cumulative-${report.generated_at.replaceAll(/[:.]/g, "-")}`);
await mkdir(directory, { recursive: true });
await Bun.write(join(directory, "report.json"), JSON.stringify({ status: passed ? "passed" : "failed", ...report }, null, 2) + "\n");
console.info(`${passed ? "passed" : "failed"}: ${join(directory, "report.json")}`);
process.exit(passed ? 0 : 1);
