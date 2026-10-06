import type { CheckedValue, DefinitionBundle, VersionedValue } from "../core-client/generated-contracts";
import { observationRootKey, selectObservationRoots } from "../core-client/observation-roots";
import type { OutputPublication, Result } from "./commit";
import type { AuthoritySnapshot } from "./snapshot-reader";

/** Evaluate the pending publication in the same decision that commits its pointer. */
export function stagePublications(bundle: DefinitionBundle, source: AuthoritySnapshot, outputs: readonly OutputPublication[]): Result<AuthoritySnapshot> {
  const scope = bundle.scopes.find((scope) => scope.key === source.owner.scope_key);
  if (!scope) return { ok: false, error: { operation: "stage_publications", entity_id: source.owner.id, detail: "scope declaration missing" } };
  let observations = [...source.snapshot.observations];
  for (const output of outputs) {
    if (!output.revision_id) return { ok: false, error: { operation: "stage_publications", entity_id: source.owner.id, detail: "publication revision identity missing" } };
    const revision_id = output.revision_id;
    const roots = selectObservationRoots(scope);
    const definition = scope.outputs.find((item) => item.key === output.output_key);
    const member_shape = bundle.schemas.find((schema) => schema.key === definition?.schema)?.shape;
    const key_index = member_shape?.kind === "record" ? member_shape.fields.findIndex((field) => field.key === definition?.collection_key) : -1;
    const member_key = (value: CheckedValue): string | null => {
      const key = value.data.kind === "record" ? value.data.fields.find((field) => field.field_id === key_index)?.value : null;
      return key?.data.kind === "string" ? key.data.value : null;
    };
    const bodies_root = roots.find((root) => root.kind === "output_collection" && root.key === output.output_key);
    const revisions_root = roots.find((root) => root.kind === "output_revisions" && root.key === output.output_key);
    const bodies = observations.find((item) => bodies_root && observationRootKey(item.root) === observationRootKey(bodies_root))?.value.data;
    const revisions = observations.find((item) => revisions_root && observationRootKey(item.root) === observationRootKey(revisions_root))?.value.data;
    const members = bodies?.kind === "list" ? bodies.items.map((body,index) => ({ key: member_key(body), body, revision: revisions?.kind === "list" ? revisions.items[index] ?? null : null })) : [];
    const collection_members = [...members.filter((item) => item.key !== output.collection_key), { key: output.collection_key, body: output.body, revision: null }]
      .sort((left,right) => (left.key ?? "").localeCompare(right.key ?? ""));
    const replace = (root: VersionedValue["root"], value: CheckedValue): void => {
      const existing = observations.find((observation) => observationRootKey(observation.root) === observationRootKey(root));
      observations = observations.filter((observation) => observationRootKey(observation.root) !== observationRootKey(root));
      observations.push({ root, value, identity: existing?.identity ?? `publication:${output.revision_id}:${JSON.stringify(root)}`, version: (existing?.version ?? 0) + 1 });
    };
    if (!output.collection_key) replace({ kind: "output", key: output.output_key }, output.body);
    for (const root of roots) {
      if (!("key" in root) || root.key !== output.output_key) continue;
      if (root.kind === "output_revision") replace(root, { schema: root.schema, data: { kind: "reference", brand: "artifact_revision", id: output.revision_id } });
      if (root.kind === "optional_output_revision") {
        const shape = bundle.schemas.find((schema) => schema.key === root.schema)?.shape;
        if (shape?.kind === "optional") replace(root, { schema: root.schema, data: { kind: "optional", value: { schema: shape.item, data: { kind: "reference", brand: "artifact_revision", id: output.revision_id } } } });
      }
      if (root.kind === "output_collection" || root.kind === "output_revisions") {
        const shape = bundle.schemas.find((schema) => schema.key === root.schema)?.shape;
        if (shape?.kind !== "list") continue;
        const items = root.kind === "output_collection" ? collection_members.map((item) => item.body)
          : collection_members.flatMap((item) => item.key === output.collection_key
            ? [{ schema: shape.item, data: { kind: "reference" as const, brand: "artifact_revision" as const, id: revision_id } }]
            : item.revision ? [item.revision] : []);
        replace(root, { schema: root.schema, data: { kind: "list", items } });
      }
    }
  }
  return { ok: true, value: { ...source, snapshot: { ...source.snapshot, observations } } };
}
