import { expect, test } from "vitest";
import type { submitCohortRequest } from "../client";
import { OakridgeHttpError } from "./client-errors";
import { deliverCohortRequest } from "./cohort-request-delivery";

type Envelope = Parameters<typeof submitCohortRequest>[0];
for (const request of [{ kind: "retry_build" }, { kind: "abandon", reason: "stop" }] as const) {
  test(`${request.kind} refreshes the version and request identity after a conflict`, async () => {
    const retained = new Map<string, Envelope>();
    let version = 1;
    const submitted: Envelope[] = [];
    const delivery = { retained, key: "cohort", load: async (): Promise<Envelope> => ({ cohort_id: "cohort",
      id: `request-${version}`, expected_version: version, request }), submit: async (envelope: Envelope) => {
      submitted.push(envelope);
      throw new OakridgeHttpError(409, "version conflict");
    } };
    await expect(deliverCohortRequest(delivery)).rejects.toThrow("version conflict");
    version = 2;
    await expect(deliverCohortRequest(delivery)).rejects.toThrow("version conflict");
    expect(submitted.map(({ id, expected_version }) => ({ id, expected_version })))
      .toEqual([{ id: "request-1", expected_version: 1 }, { id: "request-2", expected_version: 2 }]);
  });
}

for (const failure of [new Error("lost response"), new OakridgeHttpError(503, "unavailable")]) {
  test(`uncertain delivery preserves the envelope after ${failure.message}`, async () => {
    const retained = new Map<string, Envelope>();
    let reads = 0;
    const submitted: Envelope[] = [];
    const delivery = { retained, key: "cohort", load: async (): Promise<Envelope> => {
      reads++;
      return { cohort_id: "cohort", id: `request-${reads}`, expected_version: reads, request: { kind: "retry_build" } };
    }, submit: async (envelope: Envelope) => { submitted.push(envelope); throw failure; } };
    await expect(deliverCohortRequest(delivery)).rejects.toThrow(failure.message);
    await expect(deliverCohortRequest(delivery)).rejects.toThrow(failure.message);
    expect(submitted[1]).toBe(submitted[0]);
    expect(reads).toBe(1);
  });
}
