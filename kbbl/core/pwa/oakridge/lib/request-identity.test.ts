// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { makeCommandSubmission, makeStartPinnedRunRequest } from "../__fixtures__/read-models";
import { operatorDraftIdentity, readPendingCommand, savePendingCommand } from "./operator-drafts";
import { discardPendingLaunch, readPendingLaunch, savePendingLaunch } from "./operator-launch";

afterEach(() => localStorage.clear());

describe("operator request identity", () => {
  test("retains one command request id when a delivery is retried", () => {
    const first = makeCommandSubmission({ request_id: "ping-1" });
    savePendingCommand(first);
    expect(readPendingCommand(first)?.request_id).toBe("ping-1");
    expect(readPendingCommand(first)).toEqual(first);
  });

  test("keeps different scopes' pending commands under different identities", () => {
    const first = makeCommandSubmission({ scope_id: "scope-one", request_id: "ping-1" });
    const second = makeCommandSubmission({ scope_id: "scope-two", request_id: "ping-2" });
    savePendingCommand(first);
    savePendingCommand(second);
    expect(operatorDraftIdentity(first)).not.toBe(operatorDraftIdentity(second));
    expect([readPendingCommand(first)?.request_id, readPendingCommand(second)?.request_id]).toEqual(["ping-1", "ping-2"]);
  });

  test("retains a pinned run launch request across an uncertain response", () => {
    const first = makeStartPinnedRunRequest({ request_id: "launch-1" });
    savePendingLaunch(first);
    expect(readPendingLaunch()).toEqual(first);
  });

  test("a discarded launch can be replaced with a new request id", () => {
    savePendingLaunch(makeStartPinnedRunRequest({ request_id: "launch-1" }));
    discardPendingLaunch();
    savePendingLaunch(makeStartPinnedRunRequest({ request_id: "launch-2" }));
    expect(readPendingLaunch()?.request_id).toBe("launch-2");
  });
});
