import { describe, expect, it } from "vitest";

import { selectSessionCloseRefusal } from "./session-close";

const hold = {
  session_id: "e1a84fd7-0750-404b-a82c-9daefdfbdde1",
  execution_id: "f5aeeb42:pipefitter-tiers-spec",
  execution_workflow_id: "oakridge-unit-rerun:f5aeeb42:pipefitter-tiers-spec",
  run_id: "69032301-a22f-4498-8948-6896e2e57302",
  stage_instance_id: "f5aeeb42-9c16-41b3-8134-4161aa36aa39",
  stage_key: "build",
  unit_id: "pipefitter-tiers-spec",
};

const heldBody = {
  error: "session is running stage 'build' (unit 'pipefitter-tiers-spec')",
  code: "session_held_by_execution",
  hold,
};

describe("selectSessionCloseRefusal", () => {
  it("reports a hold refusal as overridable", () => {
    expect(selectSessionCloseRefusal(409, heldBody).kind).toBe("held_by_execution");
  });

  it("carries the hold so the operator sees which unit is at stake", () => {
    const refusal = selectSessionCloseRefusal(409, heldBody);
    expect(refusal.kind === "held_by_execution" && refusal.hold.unit_id).toBe(
      "pipefitter-tiers-spec",
    );
  });

  it("keeps the server's explanation as the message", () => {
    expect(selectSessionCloseRefusal(409, heldBody).message).toBe(heldBody.error);
  });

  it("reports an unknown session as a plain rejection", () => {
    expect(selectSessionCloseRefusal(404, { error: "unknown session" })).toEqual({
      kind: "rejected",
      message: "unknown session",
    });
  });

  // A hold code without a usable hold cannot offer an override — the button
  // would need the hold to explain what it is abandoning.
  it("does not treat a hold code with a malformed hold as overridable", () => {
    const refusal = selectSessionCloseRefusal(409, {
      error: "session is held",
      code: "session_held_by_execution",
      hold: { session_id: "e1a84fd7" },
    });
    expect(refusal.kind).toBe("rejected");
  });

  it("falls back to the status when the body carries no message", () => {
    expect(selectSessionCloseRefusal(500, null).message).toBe("remove session failed: 500");
  });

  it("falls back to the status when the body is not an object", () => {
    expect(selectSessionCloseRefusal(502, "Bad Gateway").message).toBe(
      "remove session failed: 502",
    );
  });
});
