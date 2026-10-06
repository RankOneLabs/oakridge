import type { CheckedValue, DefinitionBundle, VersionedValue } from "../core-client/generated-contracts";
import { observationRootKey, selectObservationRoots } from "../core-client/observation-roots";
import type { OutputPublication, Result } from "./commit";
import type { AuthoritySnapshot } from "./snapshot-reader";

interface PublicationMember { readonly key: string; readonly body: CheckedValue; readonly revision_id: string }

/** Evaluate the pending publication in the same decision that commits its pointer. */
export function stagePublications(bundle: DefinitionBundle, source: AuthoritySnapshot, outputs: readonly OutputPublication[]): Result<AuthoritySnapshot> {
  const scope = bundle.scopes.find((scope) => scope.key === source.owner.scope_key);
  if (!scope) return { ok: false, error: { operation: "stage_publications", entity_id: source.owner.id, detail: "scope declaration missing" } };
  let observations = [...source.snapshot.observations];
  const staged_members = new Map<string, readonly PublicationMember[]>();
  const roots = selectObservationRoots(scope);
  for (const output of outputs) {
    if (!output.revision_id) return { ok: false, error: { operation: "stage_publications", entity_id: source.owner.id, detail: "publication revision identity missing" } };
    const revision_id = output.revision_id;
    const members = staged_members.get(output.output_key) ?? source.current_outputs
      .filter((slot) => slot.output_key === output.output_key)
      .map((slot) => ({ key: slot.collection_key, body: slot.body, revision_id: slot.current_revision_id }));
    const collection_members = [...members.filter((item) => item.key !== output.collection_key),
      { key: output.collection_key, body: output.body, revision_id }]
      .sort((left,right) => left.key.localeCompare(right.key));
    staged_members.set(output.output_key, collection_members);
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
          : collection_members.map((item) => ({ schema: shape.item, data: { kind: "reference" as const, brand: "artifact_revision" as const, id: item.revision_id } }));
        replace(root, { schema: root.schema, data: { kind: "list", items } });
      }
    }
  }
  return { ok: true, value: { ...source, snapshot: { ...source.snapshot, observations } } };
}
