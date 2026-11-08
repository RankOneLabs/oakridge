import type { QuestionDefinition, QuestionKey } from "../grading/question";
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

export interface EvidenceCollector {
  collect(artifact: SourceArtifact, question: QuestionKey, sources: CapturedSources): Promise<EvidenceCollection>;
}

/** The relation a composite follows: from a logical item, back along incoming edges of this
 * type to the occurrences that declared it, and on to those occurrences' answers. */
export interface CompositePath {
  readonly logical_scope: string;
  readonly relation_type: RelationType;
}

/** The only way producer knowledge enters the service. It is injected at composition, and
 * generic storage, grading and projection code consumes these contracts without importing it. */
export interface ProducerProfile {
  readonly producer: string;
  readonly extraction: ExtractionProfile;
  readonly questions: readonly QuestionDefinition[];
  readonly evidence: EvidenceCollector;
  readonly composite: CompositePath;
}
