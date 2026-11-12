import type { QuestionDefinition } from "../grading/question";
import type { EvidencePlan, SubjectQuestion } from "../grading/evidence";
import type { JsonValue, Result } from "../domain/primitives";
import type { ExtractorDefinition, RelationType } from "../projection/extractor";
import type { RelationDeclaration } from "../projection/relations";
import type { CapturedSources, EvidenceCollection, SourceArtifact } from "./artifact-source";

/** The fields of a captured revision a profile may use to relate it to another revision. */
export interface RevisionHeader {
  readonly artifact_kind: string;
  readonly subject_id: string | null;
}
export interface RevisionLink {
  readonly target_artifact_kind: string;
  readonly subject_revision_id: string;
}
export interface DeclarationDecodeError { readonly operation: "decode_relation_declaration"; readonly entity_id: string; readonly detail: string }
export interface ExtractionProfile {
  definitions(artifact_kind: string, schema_version: string): readonly ExtractorDefinition[];
  revisionLink(revision: RevisionHeader): RevisionLink | null;
  /** The relations a journaled producer declaration states for one run, exactly as supplied. */
  declaredRelations(declaration: JsonValue, run_id: string): Result<readonly RelationDeclaration[], DeclarationDecodeError>;
}

/** Storage supplies the exact plan frozen with a subject; direct collectors may use configured plans. */
export interface CollectionQuestion extends SubjectQuestion { readonly collection_plan?: EvidencePlan }
export interface EvidenceCollector {
  collect(artifact: SourceArtifact, question: CollectionQuestion, sources: CapturedSources): Promise<EvidenceCollection>;
}

/** One stage a composite keeps apart from the others. Publication alone makes a final stage's results final. */
export interface CompositeStage {
  readonly stage: string;
  readonly is_final_on_publication: boolean;
}
/** The fields of a captured revision a profile may use to place it in a stage. */
export interface StagedRevision {
  readonly artifact_kind: string;
  readonly unit_id: string;
}
/** The relation a composite follows: from a logical item, back along incoming edges of this type to
 * the occurrences that declared it, and on to those occurrences' answers. It reads only the item kinds
 * listed here, and keeps them in the profile's stages, in this order. */
export interface CompositePath {
  readonly logical_scope: string;
  readonly relation_type: RelationType;
  readonly item_kinds: readonly string[];
  readonly stages: readonly CompositeStage[];
  /** A revision's stage, or null when it contributes to none. */
  stageOf(revision: StagedRevision): string | null;
}

/** The only way producer knowledge enters the service. It is injected at composition, and
 * generic storage, grading and projection code consumes these contracts without importing it. */
export interface ProducerProfile {
  readonly producer: string;
  readonly extraction: ExtractionProfile;
  readonly questions: readonly QuestionDefinition[];
  readonly evidence: EvidenceCollector;
  readonly capabilities: EvidenceCapabilities;
  readonly composite: CompositePath;
}

/** A definition references a capability and the parameters its schema accepts. */
export type EvidenceCapabilityReference = string | {
  readonly capability: string;
  readonly params?: JsonValue;
};
/** All resolvers for a subject share captured reads and the same task identity. */
export interface EvidenceResolutionContext {
  readonly artifact: SourceArtifact;
  readonly question: SubjectQuestion;
  readonly sources: CapturedSources;
}
export interface EvidenceCapability {
  readonly params: import("zod").z.ZodType;
  readonly subject: { readonly fields: readonly string[]; readonly task_subject: boolean };
  resolve(context: EvidenceResolutionContext, params: unknown): Promise<EvidenceCollection>;
}
/** Capability names describe evidence, never question identities. */
export type EvidenceCapabilities = Readonly<{ [name: string]: EvidenceCapability }>;
