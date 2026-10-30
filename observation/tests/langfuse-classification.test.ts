import { expect, test } from "bun:test";
import { classifyProjectionField, evidenceKindForCapturedPath, projectClassifiedBody,
  type ProjectionArtifactKind } from "../src/langfuse/classification";

const inheritedFields = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"] as const;

for (const [kind, field] of [
  ["analysis", "source_spec_refs"], ["plan", "dependency_order"], ["brief", "cohort_id"],
  ["assessment", "head_sha"],
] as const satisfies readonly (readonly [ProjectionArtifactKind, string])[]) {
  test(`${kind} withholds undeclared fields and passes declared public fields`, () => {
    const projected = projectClassifiedBody(kind, { [field]: "safe-reference", benign_new_field: "private text" });
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.field_kinds.benign_new_field).toBe("unclassified_content");
    expect(projected.value.public_fields).toEqual({ [field]: "safe-reference" });
  });

  test(`${kind} stamps inherited object names as unclassified_content`, () => {
    const body = Object.fromEntries(inheritedFields.map((name) => [name, `private ${name}`]));
    const projected = projectClassifiedBody(kind, body);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.public_fields).toEqual({});
    for (const name of inheritedFields) {
      expect(classifyProjectionField(kind, name)).toEqual({ ok: true, value: "unclassified_content" });
      expect(Object.hasOwn(projected.value.field_kinds, name)).toBe(true);
      expect(projected.value.field_kinds[name]).toBe("unclassified_content");
    }
  });
}

// Evidence classification is derived from the source body field, never hardcoded at the
// packaging site, so reclassifying a field changes what may be disclosed.
for (const [artifact_kind, path, expected] of [
  ["plan", "/dependency_order/0", "public"],
  ["brief", "/cohort_id", "public"],
  ["assessment", "/head_sha", "public"],
  ["plan", "/cohorts/0/acceptance_criteria/1", "internal"],
  ["brief", "/acceptance_criteria/0", "internal"],
  ["assessment", "/findings/2", "internal"],
  ["brief", "/files_in_scope/0", "internal"],
  ["plan", "/benign_new_field/0", "internal"],
  ["tasks", "/tasks/0", "internal"],
  ["", "/findings/0", "internal"],
  ["plan", "/", "internal"],
] as const satisfies readonly (readonly [string, string, string])[]) {
  test(`${artifact_kind || "<undeclared>"} ${path} classifies as ${expected}`, () => {
    expect(evidenceKindForCapturedPath(artifact_kind, path)).toEqual({ ok: true, value: expected });
  });
}

test("a field declared repository content maps to repository content, not internal", () => {
  // No development field is classified repository_content today; the mapping must still
  // carry that kind through rather than failing it closed with restricted content.
  expect(classifyProjectionField("brief", "files_in_scope")).toEqual({ ok: true, value: "restricted" });
  expect(evidenceKindForCapturedPath("brief", "/files_in_scope/0")).toEqual({ ok: true, value: "internal" });
});
