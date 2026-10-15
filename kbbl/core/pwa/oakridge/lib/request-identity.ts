export interface PendingRequestIdentity {
  readonly identity: string;
  readonly idempotency_key: string;
}

/**
 * Hold one idempotency key per request identity.
 *
 * A retry of the same request must carry the key its first attempt used, so the
 * server replays instead of launching a second run or sending a second ping; a
 * genuinely different request must get a fresh one. Three surfaces — run
 * launch, thread ping, unit admission — each grew their own copy of that rule
 * with a differently named identity field. The identity is whatever string
 * distinguishes one request from another: a thread id, a stage/unit pair, or a
 * fingerprint of the whole request body.
 */
export const selectRequestIdentity = (
  previous: PendingRequestIdentity | null,
  identity: string,
  createId: () => string,
): PendingRequestIdentity => previous?.identity === identity
  ? previous
  : { identity, idempotency_key: createId() };
