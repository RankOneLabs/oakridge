import { expect, test } from "bun:test";
import { projectClassifiedBody, type ProjectionArtifactKind } from "../src/langfuse/classification";

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
}
