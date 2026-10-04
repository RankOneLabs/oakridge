import type { submitCohortRequest } from "../client";
import { isDefinitiveRequestRejection } from "./client-errors";

type CohortRequestEnvelope = Parameters<typeof submitCohortRequest>[0];
export interface CohortRequestDelivery {
  readonly retained: Map<string, CohortRequestEnvelope>;
  readonly key: string;
  readonly load: () => Promise<CohortRequestEnvelope>;
  readonly submit: typeof submitCohortRequest;
}

/** Replay uncertain delivery; reload the owner after a definitive rejection. */
export const deliverCohortRequest = async (input: CohortRequestDelivery): ReturnType<typeof submitCohortRequest> => {
  const envelope = input.retained.get(input.key) ?? await input.load();
  input.retained.set(input.key, envelope);
  try {
    const result = await input.submit(envelope);
    input.retained.delete(input.key);
    return result;
  } catch (cause) {
    if (isDefinitiveRequestRejection(cause)) input.retained.delete(input.key);
    throw cause;
  }
};
