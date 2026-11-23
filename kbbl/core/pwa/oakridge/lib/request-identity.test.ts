import { describe, expect, it } from "vitest";

import type { CreateRunRequest } from "../launch-types";
import { selectRequestIdentity } from "./request-identity";

const launchRequest = (notes: string): CreateRunRequest => ({
  workflow_def_id: "definition-1", project_id: null,
  workflow_input: { message: notes },
  session_settings: {},
  grading_enabled: false,
});

describe("request identity", () => {
  it("retains one identity when the same request is retried after an unknown response", () => {
    const first = selectRequestIdentity(null, "thread-1", () => "ping-1");
    expect(selectRequestIdentity(first, "thread-1", () => "ping-2")).toBe(first);
  });

  it("creates a different identity for a different request", () => {
    const first = selectRequestIdentity(null, "thread-1", () => "ping-1");
    expect(selectRequestIdentity(first, "thread-2", () => "ping-2").idempotency_key).toBe("ping-2");
  });

  it("treats a whole run-launch body as the identity, so an unchanged resubmission replays", () => {
    let sequence = 0;
    const first = selectRequestIdentity(null, JSON.stringify(launchRequest("Build it")), () => `launch-${++sequence}`);
    const retry = selectRequestIdentity(first, JSON.stringify(launchRequest("Build it")), () => `launch-${++sequence}`);
    expect(retry).toBe(first);
  });

  it("mints a new key once the operator edits the run they are launching", () => {
    let sequence = 0;
    const first = selectRequestIdentity(null, JSON.stringify(launchRequest("Build it")), () => `launch-${++sequence}`);
    const changed = selectRequestIdentity(first, JSON.stringify(launchRequest("Build it differently")), () => `launch-${++sequence}`);
    expect(changed.idempotency_key).toBe("launch-2");
  });

});
