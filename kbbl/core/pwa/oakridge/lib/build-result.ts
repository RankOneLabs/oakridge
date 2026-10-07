import type { Result } from "../../lib/result";
import type { FindingSeverity, RepositoryKey } from "../types";

/**
 * Mirrors `TestEvidence` in oakridge-dbos/src/domain/dev-flow-artifacts.ts.
 * Builders routinely omit the text fields, so absence reads as null.
 */
export interface TestEvidence {
  passed: number;
  failed: number;
  output: string | null;
  summary: string | null;
  cargo_test_output: string | null;
}

/** Mirrors `DelegatedBuildMetadata`; builders publish only the fields they know. */
export interface DelegatedBuildMetadata {
  cohort_id: string | null;
  session_id: string | null;
  branch: string | null;
}

/** Mirrors `BuildIssue`. */
export interface BuildIssue {
  description: string;
  severity: FindingSeverity;
}

/** Mirrors the registered oakridge-dbos `dev.build_result` artifact body. */
export interface BuildResult {
  repository_key: RepositoryKey | null;
  summary: string;
  changed_files: string[];
  tests: TestEvidence;
  delegated_session_metadata: DelegatedBuildMetadata | null;
  known_issues: BuildIssue[];
}

export interface BuildResultParseError {
  operation: "parse_build_result";
  field: string;
  detail: string;
}

type Parsed<T> = Result<T, BuildResultParseError>;

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { operation: "parse_build_result", field, detail } });
const SEVERITIES: readonly FindingSeverity[] = ["blocking", "warning", "info"];

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Where in a body a shared shape broke; each artifact parser wraps it in its own error. */
export interface FieldError {
  field: string;
  detail: string;
}

/** Shared by build results (`tests`) and assessments (`test_evidence`). */
export function parseTestEvidence(value: unknown, field: string): Result<TestEvidence, FieldError> {
  if (!isRecord(value)) return { ok: false, error: { field, detail: "expected an object" } };
  if (typeof value.passed !== "number") return { ok: false, error: { field: `${field}.passed`, detail: "expected a number" } };
  if (typeof value.failed !== "number") return { ok: false, error: { field: `${field}.failed`, detail: "expected a number" } };
  return {
    ok: true,
    value: {
      passed: value.passed,
      failed: value.failed,
      output: nullableString(value.output),
      summary: nullableString(value.summary),
      cargo_test_output: nullableString(value.cargo_test_output),
    },
  };
}

function parseIssues(value: unknown): Parsed<BuildIssue[]> {
  if (!Array.isArray(value)) return fail("known_issues", "expected an array");
  const issues: BuildIssue[] = [];
  for (const [index, entry] of value.entries()) {
    const severity = isRecord(entry) ? SEVERITIES.find((candidate) => candidate === entry.severity) : undefined;
    if (!isRecord(entry) || typeof entry.description !== "string" || !severity) {
      return fail(`known_issues[${index}]`, "expected a description and a blocking, warning or info severity");
    }
    issues.push({ description: entry.description, severity });
  }
  return ok(issues);
}

export function parseBuildResult(body: unknown): Parsed<BuildResult> {
  if (!isRecord(body)) return fail("body", "expected an object");
  if (typeof body.summary !== "string") return fail("summary", "expected a string");
  if (!Array.isArray(body.changed_files) || !body.changed_files.every((file) => typeof file === "string")) {
    return fail("changed_files", "expected an array of strings");
  }
  const tests = parseTestEvidence(body.tests, "tests");
  if (!tests.ok) return fail(tests.error.field, tests.error.detail);
  const issues = parseIssues(body.known_issues);
  if (!issues.ok) return issues;
  const metadata = body.delegated_session_metadata;
  return ok({
    repository_key: nullableString(body.repository_key) as RepositoryKey | null,
    summary: body.summary,
    changed_files: body.changed_files,
    tests: tests.value,
    delegated_session_metadata: isRecord(metadata)
      ? { cohort_id: nullableString(metadata.cohort_id), session_id: nullableString(metadata.session_id), branch: nullableString(metadata.branch) }
      : null,
    known_issues: issues.value,
  });
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
  return [tests.summary, tests.output, tests.cargo_test_output].filter((text): text is string => text !== null && text.trim() !== "");
}

/** A build result body, or null when it breaks the contract. */
export function readBuildResult(body: unknown): BuildResult | null {
  const parsed = parseBuildResult(body);
  return parsed.ok ? parsed.value : null;
}
