import { describe, expect, it } from "vitest";

import type { CreateRunRequest } from "../types";
import { selectRunLaunchIdentity } from "./run-launch-idempotency";

const request = (notes: string): CreateRunRequest => ({ workflow_def_id: "definition-1", project_id: null, context: { brief_notes: notes }, epic_profile: null });

describe("run launch idempotency", () => {
  it("reuses one identity for an unchanged submission after an unknown response", () => {
    let sequence = 0;
    const first = selectRunLaunchIdentity(null, request("Build it"), () => `launch-${++sequence}`);
    const retry = selectRunLaunchIdentity(first, request("Build it"), () => `launch-${++sequence}`);
    expect(retry).toBe(first);
  });

  it("creates a new identity when the operator changes the submission", () => {
    let sequence = 0;
    const first = selectRunLaunchIdentity(null, request("Build it"), () => `launch-${++sequence}`);
    const changed = selectRunLaunchIdentity(first, request("Build it differently"), () => `launch-${++sequence}`);
    expect(changed.idempotency_key).toBe("launch-2");
  });
});
