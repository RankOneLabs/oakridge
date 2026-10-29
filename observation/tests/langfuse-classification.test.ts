import { expect, test } from "bun:test";
import { classifyProjectionField, projectClassifiedBody, type ProjectionArtifactKind } from "../src/langfuse/classification";

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
