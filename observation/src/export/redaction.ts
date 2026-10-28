import type { ExportRecord, RedactionPolicy, RedactionReason } from "./manifest";

export interface RedactedRecord { readonly record: ExportRecord; readonly reasons: readonly RedactionReason[] }
type Reason = RedactionReason["reason"];

// Classifies known build_body/test_evidence fields from workflow-config/development.yaml,
// plus legacy content fields. New top-level build fields fail closed.
const BUILD_BODY_FIELDS: Readonly<Record<string, Reason | "public" | "nested_tests">> = {
  repository_key: "public", head_sha: "public", summary: "public", changed_files: "public",
  delegated_session_metadata: "public", known_issues: "public", tests: "nested_tests",
  output: "raw_build_output", repository_content: "repository_content",
  repository_snapshot: "repository_content",
};
const BUILD_TEST_FIELDS: Readonly<Record<string, Reason | "public">> = {
  passed: "public", failed: "public", summary: "public",
  output: "raw_test_output", cargo_test_output: "raw_test_output",
};

function declaredReason(fields: Readonly<Record<string, Reason | "public" | "nested_tests">>, key: string): Reason | null {
  const kind = fields[key] ?? "unclassified_content";
  return kind === "public" || kind === "nested_tests" ? null : kind;
}

function reasonFor(key: string, path: string, artifactKind: string, parent: object): Reason | null {
  if (artifactKind === "build_result" && path === "/source_revision" && key === "body") {
    const body = "body" in parent ? parent.body : null;
    return body !== null && typeof body === "object" && !Array.isArray(body) ? null : "unclassified_content";
  }
  if (artifactKind === "build_result" && path === "/occurrence" && key === "selected_value") {
    const selector = "item_selector" in parent && typeof parent.item_selector === "string" ? parent.item_selector : "";
    if (/repo|snapshot|source_file/.test(selector)) return "repository_content";
    if (/test.*(output|log|stdout|stderr)/.test(selector)) return "raw_test_output";
    if (/(build|output|log|stdout|stderr)/.test(selector)) return "raw_build_output";
    const value = "selected_value" in parent ? parent.selected_value : null;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? null : "unclassified_content";
  }
  if (artifactKind === "build_result" && (path === "/source_revision/body" || path === "/occurrence/selected_value")
    && key === "tests" && "tests" in parent && (parent.tests === null || typeof parent.tests !== "object"
      || Array.isArray(parent.tests))) return "raw_test_output";
  if (artifactKind === "build_result" && (path === "/source_revision/body" || path === "/occurrence/selected_value"))
    return declaredReason(BUILD_BODY_FIELDS, key);
  if (artifactKind === "build_result" && (path === "/source_revision/body/tests" || path === "/occurrence/selected_value/tests"))
    return declaredReason(BUILD_TEST_FIELDS, key);
  if (key === "content" && /^\/evidence_set\/evidence_refs\/\d+$/.test(path)) {
    const kind = "kind" in parent ? parent.kind : null;
    return kind === "raw_build_output" || kind === "raw_test_output" || kind === "repository_content"
      ? kind : kind === "public" ? null : "unclassified_content";
  }
  const name = key.toLowerCase();
  const place = path.toLowerCase();
  const ref = "ref" in parent && typeof parent.ref === "string" ? parent.ref.toLowerCase() : "";
  const selector = "item_selector" in parent && typeof parent.item_selector === "string"
    ? parent.item_selector.toLowerCase() : "";
  if (name === "selected_value" && /repo|snapshot|source_file/.test(selector)) return "repository_content";
  if (name === "selected_value" && /test.*(output|log|stdout|stderr)/.test(selector)) return "raw_test_output";
  if (name === "selected_value" && /(build|output|log|stdout|stderr)/.test(selector)
    && artifactKind === "build_result") return "raw_build_output";
  if (["repository_content", "repository_snapshot", "repo_content", "source_code", "file_contents"].includes(name)
    || ((name === "content" || name === "body") && (/\/(repository|repo|snapshot|files)(\/|$)/.test(place)
      || /repo|snapshot|source_file/.test(ref)))) return "repository_content";
  if (["raw_test_output", "test_output"].includes(name) || name.endsWith("_test_output")
    || (["output", "stdout", "stderr", "content"].includes(name)
      && (/\/(tests?|test_results?)(\/|$)/.test(place) || /test_output|test_log/.test(ref)))) return "raw_test_output";
  if (["raw_build_output", "build_output"].includes(name) || name.endsWith("_build_output")
    || (["output", "stdout", "stderr", "content"].includes(name)
      && (/\/(build|builds)(\/|$)/.test(place) || /build_output|build_log/.test(ref)
        || ((place.endsWith("/source_revision/body") || place.endsWith("/occurrence/selected_value"))
          && artifactKind === "build_result")))) return "raw_build_output";
  return null;
}

/** Replace sensitive values with an explicit marker, preserving every omission path. */
export function redactRecord(record: ExportRecord, policy: RedactionPolicy): RedactedRecord {
  const reasons: RedactionReason[] = [];
  const artifactKind = record.source_revision.artifact_kind;
  function visit(value: unknown, path: string): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((item, index) => visit(item, `${path}/${index}`));
    if (value === null || typeof value !== "object") return value;
    const result: { [key: string]: unknown } = {};
    for (const [key, item] of Object.entries(value)) {
      const nextPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      const reason = reasonFor(key, path, artifactKind, value);
      const allowed = reason === "raw_build_output" ? policy.allow_raw_build_output
        : reason === "raw_test_output" ? policy.allow_raw_test_output
          : reason === "repository_content" ? policy.allow_repository_content : reason === null;
      if (reason && !allowed) {
        reasons.push({ path: nextPath, reason });
        result[key] = { redacted: true, reason };
      } else result[key] = visit(item, nextPath);
    }
    return result;
  }
  return { record: visit(record, "") as ExportRecord, reasons };
}
