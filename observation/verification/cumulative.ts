/**
 * The cumulative report: one record tying the brief's live matrix to the proof reports that hold it,
 * beside the offline contract results that must stay with them, the code each proof ran on, and every scenario still pending. It reads reports and runs named test
 * files; it starts no stack and sends no provider request. A missing or failed report reads as failed.
 *
 *   bun observation/verification/cumulative.ts --workspace <proof_id> --grading <proof_id> --relations <proof_id>
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { CumulativeMatrixRow, CumulativeProof, CumulativeProofSummary, CumulativeReport, OfflineContractResult, PendingScenario, ProofReport } from "./proof-contract";
import { scanDefinitions } from "./workspace";

const ROOT = resolve(import.meta.dir, "../..");
const REPORTS = resolve(import.meta.dir, "reports");

/** Which proof holds each part of the live matrix, and what it cannot reach. */
const MATRIX: readonly { readonly part: string; readonly proof: CumulativeProof }[] = [
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
];

/** Code a proof's result depends on. A change here after a proof ran means that proof did not run on this head. */
const PRODUCT_PATHS = ["observation/src", "kbbl/core", "oakridge-dbos/src", "workflow-core", "workflow-config", "scripts"] as const;
const git = (args: readonly string[]): string | null => {
  const ran = Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return ran.exitCode === 0 ? ran.stdout.toString().trim() : null;
};
const HEAD = git(["rev-parse", "HEAD"]);
const productChangesSince = (head: string | null): readonly string[] | null => {
  if (!head || !HEAD) return null;
  const changed = git(["diff", "--name-only", head, HEAD, "--", ...PRODUCT_PATHS]);
  return changed === null ? null : changed.split("\n").filter((line) => line.length > 0);
};

interface ReadProof { readonly summary: CumulativeProofSummary; readonly pending: readonly PendingScenario[] }
async function readProof(proof_id: string | undefined): Promise<ReadProof | null> {
  if (!proof_id) return null;
  const file = Bun.file(join(REPORTS, proof_id, "report.json"));
  if (!await file.exists()) return null;
  const report = await file.json() as ProofReport;
  return { pending: report.pending, summary: { proof_id, status: report.status, git_head: report.source.git_head, worktree_clean: report.source.worktree_clean,
    product_changes_since: productChangesSince(report.source.git_head), passed_checks: report.scenario.checks.filter((check) => check.passed).length,
    failed_checks: report.scenario.checks.filter((check) => !check.passed).map((check) => `${check.name}: ${check.detail}`),
    runs: report.scenario.evidence.runs.map((run) => run.run_id), provider_request_count: report.scenario.evidence.provider_request_count } };
}

function runSuite(command: readonly string[]): OfflineContractResult {
  const ran = Bun.spawnSync([...command], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const output = `${ran.stdout.toString()}\n${ran.stderr.toString()}`;
  return { command: command.join(" "), exit_code: ran.exitCode,
    summary: output.split("\n").filter((line) => /^\s*\d+ (pass|fail)\b|^Ran \d+ tests|^test result:/.test(line)).map((line) => line.trim()) };
}

/** One entry per pending id; the first reason given wins. */
const distinctPending = (lists: readonly (readonly PendingScenario[])[]): readonly PendingScenario[] =>
  [...new Map(lists.flat().map((scenario) => [scenario.id, scenario] as const).reverse()).values()].reverse();

const { values } = parseArgs({ options: { workspace: { type: "string" }, grading: { type: "string" }, relations: { type: "string" } } });
const read = { workspace: await readProof(values.workspace), grading: await readProof(values.grading), relations: await readProof(values.relations) };
const proofs = { workspace: read.workspace?.summary ?? null, grading: read.grading?.summary ?? null, relations: read.relations?.summary ?? null };
const tools = await Bun.file(resolve(import.meta.dir, "gated-review-tools.json")).json().catch(() => null) as { readonly status?: string; readonly endpoint?: string; readonly tool_names?: readonly string[] } | null;
const definition_scan = scanDefinitions();
const offline = [
  runSuite(["bun", "test", "observation/tests/target-schema.test.ts", "observation/tests/import-boundaries.test.ts"]),
  runSuite(["bun", "test", "workflow-config/src/task-contracts.test.ts"]),
  runSuite(["cargo", "test", "--locked", "--manifest-path", "workflow-core/Cargo.toml", "-p", "workflow-evaluator", "--test", "task_contracts"]),
];
const matrix = MATRIX.map(({ part, proof }): CumulativeMatrixRow => ({ part, proof, proof_id: proofs[proof]?.proof_id ?? null, status: proofs[proof]?.status ?? "missing" }));
const generated_at = new Date().toISOString();
const review_endpoint = { status: tools?.status ?? "missing", endpoint: tools?.endpoint ?? null,
  has_merge_pr: tools?.tool_names?.includes("merge_pr") ?? null, has_mark_merge_ready: tools?.tool_names?.includes("mark_merge_ready") ?? null };
const passed = matrix.every((row) => row.status === "passed") && review_endpoint.status === "passed"
  && definition_scan.with_discarded_field.length === 0 && definition_scan.files_naming_gated_review.length === 0 && offline.every((suite) => suite.exit_code === 0);
const report: CumulativeReport = { status: passed ? "passed" : "failed", generated_at, git_head: HEAD, proofs, matrix, review_endpoint, definition_scan, offline_contracts: offline,
  pending: distinctPending([read.workspace?.pending ?? [], read.grading?.pending ?? [], read.relations?.pending ?? []]),
  not_live_proof: "offline_contracts are contract results kept beside this report; they stand in for no live scenario. A proof whose product_changes_since is not empty ran on earlier code." };
const directory = join(REPORTS, `cumulative-${generated_at.replaceAll(/[:.]/g, "-")}`);
await mkdir(directory, { recursive: true });
await Bun.write(join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.info(`${report.status}: ${join(directory, "report.json")}`);
process.exit(passed ? 0 : 1);
