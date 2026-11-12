// The browser's only way to name an observation identity it did not read from a response: text it
// parsed from another service's id or restored from its own storage. Every other id comes from a read.
import type { ObservationArtifactRevisionId, ObservationLogicalItemId } from "../grading-contracts/domain/identity";

/** A revision id as Oakridge names it in an artifact composite id, which observation captured unchanged. */
export const artifactRevisionIdOf = (raw: string): ObservationArtifactRevisionId => raw as ObservationArtifactRevisionId;

/** A task id restored from the workspace's own storage, as observation names the task subject. */
export const logicalItemIdOf = (raw: string): ObservationLogicalItemId => raw as ObservationLogicalItemId;
