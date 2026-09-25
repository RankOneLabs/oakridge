export type Sid = string & { readonly __brand: 'Sid' };
/** `oakridge.artifact.id` — mirrors `ArtifactId` in oakridge-dbos `src/domain/primitives.ts`. */
export type ArtifactId = string & { readonly __brand: 'ArtifactId' };
export type SpecId = string & { readonly __brand: 'SpecId' };
export type PlanId = string & { readonly __brand: 'PlanId' };
export type BriefId = string & { readonly __brand: 'BriefId' };
export type ThreadId = string & { readonly __brand: 'ThreadId' };
