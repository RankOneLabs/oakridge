import type { CheckedScope, ReferenceRoot } from "./generated-contracts";

/** Root identity is independent of source JSON property ordering. */
export function observationRootKey(root: ReferenceRoot): string {
  return JSON.stringify([root.kind, "key" in root ? root.key : null, "worker" in root ? root.worker : null,
    "export" in root ? root.export : null, "schema" in root ? root.schema : null]);
}

/** The compiler emits the complete read set in the pinned checked scope. */
export function selectObservationRoots(scope: Pick<CheckedScope, "reads">): readonly ReferenceRoot[] {
  return scope.reads;
}
