import type { Result } from "../../lib/result";
import type { FindingSeverity } from "../artifact-types";

export interface TestEvidence {
  passed: number;
  failed: number;
  output?: string | null;
  summary?: string | null;
  cargo_test_output?: string | null;
}

export interface BuildIssue {
  description: string;
  severity: FindingSeverity;
}

/** Fields rendered by the build summary. The artifact body is checked by the
 * viewer registry against the run's projected schema. */
export interface BuildResult {
  commit_sha?: string | null;
  repository_key?: string | null;
  summary: string;
  changed_files: string[];
  tests: TestEvidence;
  delegated_session_metadata?: { cohort_id?: string | null; branch?: string | null } | null;
  issues: BuildIssue[];
}

const SEVERITIES: readonly FindingSeverity[] = ["blocking", "warning", "info"];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export interface FieldError { field: string; detail: string }

/** Reported evidence has its own capture contract, which allows absent prose. */
export function parseTestEvidence(value: unknown, field: string): Result<TestEvidence, FieldError> {
  const failed = isRecord(value) ? value.failing_tests : undefined;
  if (!isRecord(value) || typeof value.passed !== "number" || typeof failed !== "number")
    return { ok: false, error: { field, detail: "expected test counts" } };
  return { ok: true, value: {
    passed: value.passed, failed,
    output: textOrNull(value.test_log ?? value.output), summary: textOrNull(value.test_notes), cargo_test_output: textOrNull(value.cargo_test_output),
  } };
}

/** Select the portion of a schema-checked build publication a specialized view can show. */
export function asBuildSummary(value: unknown): BuildResult | null {
  if (!isRecord(value)) return null;
  const summary = value.change_overview;
  const issues = value.delivery_issues ?? value.known_issues;
  const commit = value.committed_revision ?? value.head_sha;
  if (typeof summary !== "string"
    || !Array.isArray(value.changed_files) || !value.changed_files.every((file) => typeof file === "string")
    || !Array.isArray(issues)) return null;
  const displayIssues: BuildIssue[] = [];
  for (const issue of issues) {
    if (!isRecord(issue) || typeof issue.description !== "string") return null;
    const severity = SEVERITIES.find((level) => level === (issue.finding_impact ?? issue.severity));
    if (!severity) return null;
    displayIssues.push({ description: issue.description, severity });
  }
  const tests = parseTestEvidence(value.tests, "tests");
  if (!tests.ok) return null;
  const metadata = isRecord(value.delegated_session_metadata) ? value.delegated_session_metadata : null;
  return { summary, changed_files: value.changed_files, issues: displayIssues, tests: tests.value,
    commit_sha: textOrNull(commit), repository_key: textOrNull(value.assigned_repository),
    delegated_session_metadata: metadata && { cohort_id: textOrNull(metadata.cohort_id), branch: textOrNull(metadata.source_branch) } };
}

/** How the files a build changed line up with the files its brief put in scope. */
export interface FileScopeComparison {
  changed_in_scope: string[];
  changed_out_of_scope: string[];
  planned_untouched: string[];
}

/** A planned entry covers a changed file when it names that file or a directory above it. */
function isCoveredBy(changedFile: string, plannedEntry: string): boolean {
  const planned = plannedEntry.replace(/\/+$/, "");
  return changedFile === planned || changedFile.startsWith(`${planned}/`);
}

export function selectFileScopeComparison(planned: string[], changed: string[]): FileScopeComparison {
  return {
    changed_in_scope: changed.filter((file) => planned.some((entry) => isCoveredBy(file, entry))),
    changed_out_of_scope: changed.filter((file) => !planned.some((entry) => isCoveredBy(file, entry))),
    planned_untouched: planned.filter((entry) => !changed.some((file) => isCoveredBy(file, entry))),
  };
}

/** Issues most urgent first, keeping the builder's order within a severity. */
export function selectOrderedIssues(issues: BuildIssue[]): BuildIssue[] {
  return [...issues].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
}

export function selectHasBlockingIssue(issues: BuildIssue[]): boolean {
  return issues.some((issue) => issue.severity === "blocking");
}

/** The prose the builder recorded about its test run, in the order a reviewer reads it. */
export function selectTestEvidenceText(tests: TestEvidence): string[] {
  return [tests.summary, tests.output, tests.cargo_test_output].filter((text): text is string => typeof text === "string" && text.trim() !== "");
}
