// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { makeDecisionSubmission, makeLaunchRequest } from "../__fixtures__/read-models";
import { operatorDraftIdentity, readPendingDecision, savePendingDecision } from "./operator-drafts";
import { discardPendingLaunch, readPendingLaunch, savePendingLaunch } from "./operator-launch";

afterEach(() => localStorage.clear());

describe("operator request identity", () => {
  test("retains one decision request id when a delivery is retried", () => {
    const first = makeDecisionSubmission({ request_id: "ping-1" });
    savePendingDecision(first);
    expect(readPendingDecision(first)?.request_id).toBe("ping-1");
    expect(readPendingDecision(first)).toEqual(first);
  });

  test("keeps different units' pending decisions under different identities", () => {
    const first = makeDecisionSubmission({ unit_id: "unit-one", request_id: "ping-1" });
    const second = makeDecisionSubmission({ unit_id: "unit-two", request_id: "ping-2" });
    savePendingDecision(first);
    savePendingDecision(second);
    expect(operatorDraftIdentity(first)).not.toBe(operatorDraftIdentity(second));
    expect([readPendingDecision(first)?.request_id, readPendingDecision(second)?.request_id]).toEqual(["ping-1", "ping-2"]);
  });

  test("retains a pinned run launch request across an uncertain response", () => {
    const first = makeLaunchRequest({ request_id: "launch-1" });
    savePendingLaunch(first);
    expect(readPendingLaunch()).toEqual(first);
  });

  test("a discarded launch can be replaced with a new request id", () => {
    savePendingLaunch(makeLaunchRequest({ request_id: "launch-1" }));
    discardPendingLaunch();
    savePendingLaunch(makeLaunchRequest({ request_id: "launch-2" }));
    expect(readPendingLaunch()?.request_id).toBe("launch-2");
  });
});
