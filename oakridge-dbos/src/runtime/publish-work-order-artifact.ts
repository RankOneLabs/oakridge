import { createHash, randomUUID } from "node:crypto";

import type { ArtifactId, JsonValue, OutputCollectionKey, WorkOrderId } from "../domain/primitives";
import type { PublishWorkOrderArtifactResult } from "../domain/run-record";
import type { RunRecordRepository } from "../storage/repositories";

export interface PublishWorkOrderArtifactCommand {
  readonly work_order_id: WorkOrderId;
  readonly capability: string;
  readonly output_name: string;
  readonly collection_key: OutputCollectionKey | null;
  readonly body: JsonValue;
  readonly idempotency_key: string | null;
}

export interface PublishWorkOrderArtifactDependencies {
  readonly records: Pick<RunRecordRepository, "publish_artifact">;
  now(): string;
  new_artifact_id?: () => string;
}

/** One publication pipeline shared by HTTP agents and in-process executors. */
export const publishWorkOrderArtifact = async (
  command: PublishWorkOrderArtifactCommand,
  dependencies: PublishWorkOrderArtifactDependencies,
): Promise<PublishWorkOrderArtifactResult> => {
  const payloadHash = createHash("sha256").update(JSON.stringify(command.body)).digest("hex");
  return dependencies.records.publish_artifact({
    artifact_id: (dependencies.new_artifact_id ?? randomUUID)() as ArtifactId,
    work_order_id: command.work_order_id,
    capability_hash: createHash("sha256").update(command.capability).digest("hex"),
    output_name: command.output_name,
    collection_key: command.collection_key,
    body: command.body,
    idempotency_key: command.idempotency_key ?? payloadHash,
    payload_hash: payloadHash,
    published_at: dependencies.now(),
  });
};
