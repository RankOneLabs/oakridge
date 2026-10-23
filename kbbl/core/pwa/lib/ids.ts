export type Sid = string & { readonly __brand: 'Sid' };
/** `oakridge.artifact.id` — mirrors `ArtifactId` in oakridge-dbos `src/domain/primitives.ts`. */
export type ArtifactId = string & { readonly __brand: 'ArtifactId' };
