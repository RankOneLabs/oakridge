import type { ArtifactRevision } from "./artifacts";
import type { OutputReleaseContract } from "./compiled-workflow";
import type { ArtifactEnvelope } from "./execution";
import type { UnitId } from "./primitives";

/**
 * When one of a unit's outputs becomes visible to the rest of the run.
 *
 * A run needs two facts about an output and they are not the same fact:
 *
 * - **availability** — may a downstream stage consume this artifact?
 * - **acceptance** — is the producing unit's contract for this slot discharged?
 *
 * They coincide for every release policy whose decider sits outside the run
 * graph. An immediate release has no decider; a gate's decider is an operator.
 * For those the artifact may as well appear the moment it is accepted, and one
 * bit answers both questions.
 *
 * A handoff breaks that. Its whole premise is that a *downstream stage* decides
 * the release, and that stage cannot decide anything about an artifact it has
 * never received. So the artifact has to be available before the decision that
 * accepts it can exist. A model carrying one bit for both facts cannot express
 * this: the consumer waits on acceptance and acceptance waits on the consumer,
 * and the run graph closes into a cycle. That is the deadlock the dev flow
 * shipped with — every run reached its first build unit and stopped there.
 */
export type OutputVisibility = "on_emission" | "on_acceptance";

/**
 * Which of the two moments this output's release policy makes it visible at.
 *
 * Derived from the policy alone, so the producing execution and anything
 * reasoning about the run graph read the same rule rather than each deciding
 * for itself.
 */
export const selectOutputVisibility = (release: OutputReleaseContract): OutputVisibility =>
  release.kind === "handoff" ? "on_emission" : "on_acceptance";

/**
 * One unit telling its stage that an artifact is now available to the run.
 *
 * Availability is published exactly once per artifact revision, by the
 * execution that produced it — the only participant that holds both the
 * artifact and the output contract that dates its visibility. The coordinator
 * relays it; nobody else mints it.
 *
 * A later revision of the same output carries the same `chain_id`, which is
 * how every consumer recognises it as a replacement for what it already holds
 * rather than a second artifact in the same slot.
 */
export interface OutputAvailableEvent {
  readonly kind: "output_available";
  readonly unit_id: UnitId;
  readonly artifact: ArtifactRevision;
}

/** Everything that travels on a stage's availability stream. */
export type StageOutputEvent = OutputAvailableEvent;

/**
 * Replaces any artifact from the same revision chain, or appends.
 *
 * Every consumer of the availability stream keeps its record chain-keyed. A
 * revision is a new artifact id for an output a consumer may already hold, and
 * appending would leave the run reading two artifacts in a slot that has one —
 * which for a fan-out driver means a second unit minted under an id the stage
 * already has, and a stage that fails before it launches anything.
 */
export const withAvailableArtifact = (
  existing: readonly ArtifactRevision[],
  artifact: ArtifactRevision,
): readonly ArtifactRevision[] => [...existing.filter((candidate) => candidate.chain_id !== artifact.chain_id), artifact];

/**
 * The same rule one layer down, where a stage accumulates the artifacts
 * delivered to an incremental input.
 *
 * An envelope's `chain_id` is optional — an artifact resumed from a previous
 * attempt predates it — so identity falls back to the artifact id, under which
 * a replacement is simply a new entry. That is the pre-existing behaviour and
 * no worse than it was; nothing silently matches the wrong chain.
 */
export const envelopeIdentity = (envelope: ArtifactEnvelope): string => envelope.chain_id ?? envelope.artifact_id;

export const withReplacedEnvelope = (
  existing: readonly ArtifactEnvelope[],
  envelope: ArtifactEnvelope,
): readonly ArtifactEnvelope[] =>
  [...existing.filter((candidate) => envelopeIdentity(candidate) !== envelopeIdentity(envelope)), envelope];
