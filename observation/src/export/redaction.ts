import type { ExportRecord, RedactionPolicy, RedactionReason } from "./manifest";

export interface RedactedRecord { readonly record: ExportRecord; readonly reasons: readonly RedactionReason[] }
type Reason = RedactionReason["reason"];

function reasonFor(key: string, path: string, artifactKind: string, parent: object): Reason | null {
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
          : reason === "repository_content" ? policy.allow_repository_content : true;
      if (reason && !allowed) {
        reasons.push({ path: nextPath, reason });
        result[key] = { redacted: true, reason };
      } else result[key] = visit(item, nextPath);
    }
    return result;
  }
  return { record: visit(record, "") as ExportRecord, reasons };
}
