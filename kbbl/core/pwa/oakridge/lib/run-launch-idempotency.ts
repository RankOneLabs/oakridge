import type { CreateRunRequest } from "../types";

export interface PendingRunLaunchIdentity {
  readonly request_fingerprint: string;
  readonly idempotency_key: string;
}

export const selectRunLaunchIdentity = (
  previous: PendingRunLaunchIdentity | null,
  request: CreateRunRequest,
  createId: () => string,
): PendingRunLaunchIdentity => {
  const requestFingerprint = JSON.stringify(request);
  return previous?.request_fingerprint === requestFingerprint
    ? previous
    : { request_fingerprint: requestFingerprint, idempotency_key: createId() };
};
