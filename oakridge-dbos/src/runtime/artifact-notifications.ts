import { randomUUID } from "node:crypto";

import type { ArtifactLifecycleNotification } from "../domain/artifacts";
import type { ArtifactNotificationRepository } from "../storage/repositories";

export interface ArtifactNotificationTransport {
  send(workflow_id: string, message: ArtifactLifecycleNotification, idempotency_key: string): Promise<void>;
}

export const dispatchArtifactNotifications = async (
  repository: ArtifactNotificationRepository,
  transport: ArtifactNotificationTransport,
  now: () => string = () => new Date().toISOString(),
): Promise<number> => {
  const workerId = randomUUID();
  let delivered = 0;
  for (;;) {
    const claimedAt = now();
    const claimedUntil = new Date(Date.parse(claimedAt) + 30_000).toISOString();
    const pending = await repository.claim_pending_notifications(workerId, claimedAt, claimedUntil, 100);
    for (const notification of pending) {
      try {
        await transport.send(notification.target_workflow_id, notification.message, notification.idempotency_key);
        await repository.mark_notification_delivered(notification.id, workerId, now());
        delivered += 1;
      } catch (error) {
        const failedAt = now();
        await repository.mark_notification_failed(notification.id, workerId, error instanceof Error ? error.message : String(error), new Date(Date.parse(failedAt) + 5_000).toISOString());
      }
    }
    if (pending.length < 100) return delivered;
  }
};
