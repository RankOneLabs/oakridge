import { afterEach, describe, expect, it } from "vitest";
import { clearPendingLaunch, readPendingLaunch, savePendingLaunch } from "./operator-launch";
import { makeLaunchRequest } from "../__fixtures__/read-models";

afterEach(() => localStorage.clear());

describe("pending launch", () => {
  it("retries with the session settings the first attempt sent", () => {
    const request = makeLaunchRequest({ config: { sessions: { planning: { harness: "codex", model: "gpt-5.5", effort: null } } } });
    savePendingLaunch(request);
    expect(readPendingLaunch()).toEqual(request);
    clearPendingLaunch(request);
  });
});
