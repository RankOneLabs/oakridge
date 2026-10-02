import { createHash, randomUUID } from "node:crypto";

import type { ArtifactId, AttemptId, JsonValue, OutputCollectionKey, Result } from "../domain/primitives";
import type { PublishWorkOrderArtifact, PublishWorkOrderArtifactResult } from "../domain/run-record";
import type { RunRecordRepository } from "../storage/repositories";

export interface PublishWorkOrderArtifactCommand {
  /** The attempt the capability was issued to — the `work_order_id` on the wire. */
  readonly attempt_id: AttemptId;
  readonly capability: string;
  readonly output_name: string;
  readonly collection_key: OutputCollectionKey | null;
  readonly body: JsonValue;
  readonly idempotency_key: string | null;
}

export interface PublishWorkOrderArtifactDependencies {
  readonly records: Pick<RunRecordRepository, "publish_artifact" | "check_artifact_publication">;
  readonly enrich?: (input: { readonly attempt_id: AttemptId; readonly output_name: string; readonly body: JsonValue }) =>
    Promise<Result<JsonValue | null, { readonly code: string; readonly detail: string }>>;
  now(): string;
  new_artifact_id?: () => string;
}

/** One publication pipeline shared by HTTP agents and in-process executors. */
export const publishWorkOrderArtifact = async (
  command: PublishWorkOrderArtifactCommand,
  dependencies: PublishWorkOrderArtifactDependencies,
): Promise<PublishWorkOrderArtifactResult> => {
  const payloadHash = createHash("sha256").update(JSON.stringify(command.body)).digest("hex");
  const request: PublishWorkOrderArtifact = {
    artifact_id: (dependencies.new_artifact_id ?? randomUUID)() as ArtifactId,
    attempt_id: command.attempt_id,
    capability_hash: createHash("sha256").update(command.capability).digest("hex"),
    output_name: command.output_name,
    collection_key: command.collection_key,
    body: command.body,
    idempotency_key: command.idempotency_key ?? payloadHash,
    payload_hash: payloadHash,
    published_at: dependencies.now(),
  };
  const existing = await dependencies.records.check_artifact_publication(request);
  if (existing) return existing;
  const enriched = dependencies.enrich
    ? await dependencies.enrich({ attempt_id: command.attempt_id, output_name: command.output_name, body: command.body })
    : { ok: true as const, value: null };
  if (!enriched.ok) return { kind: "enrichment_unavailable", detail: enriched.error.detail };
  return dependencies.records.publish_artifact({ ...request, enrichment: enriched.value });
};
