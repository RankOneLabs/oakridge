export interface PendingThreadPingIdentity {
  readonly thread_id: string;
  readonly idempotency_key: string;
}

export const selectThreadPingIdentity = (
  previous: PendingThreadPingIdentity | null,
  threadId: string,
  createId: () => string,
): PendingThreadPingIdentity => previous?.thread_id === threadId
  ? previous
  : { thread_id: threadId, idempotency_key: createId() };
