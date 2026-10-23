import { describe, expect, it } from "vitest";

import { selectSessionCloseRefusal } from "./session-close";

const hold = { session_id: "e1a84fd7-0750-404b-a82c-9daefdfbdde1", run_id: "run-69032301", unit_id: "pipefitter-tiers-spec",
  worker: "builder", action_id: "f5aeeb429c1641b3" };

const heldBody = {
  error: "session is running worker 'builder' on unit 'pipefitter-tiers-spec' of run run-69032301; closing it now would strand that attempt",
  code: "session_held_by_attempt",
  hold,
};

describe("selectSessionCloseRefusal", () => {
  it("reports a held session separately from other rejections", () => {
    expect(selectSessionCloseRefusal(409, heldBody).kind).toBe("held_by_attempt");
  });

  it("carries the hold so the operator sees which unit is at stake", () => {
    const refusal = selectSessionCloseRefusal(409, heldBody);
    expect(refusal.kind === "held_by_attempt" && refusal.hold.unit_id).toBe(
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

  it("does not treat a malformed hold as a valid held-session refusal", () => {
    const refusal = selectSessionCloseRefusal(409, {
      error: "session is held",
      code: "session_held_by_attempt",
      hold: { session_id: "e1a84fd7" },
    });
    expect(refusal.kind).toBe("rejected");
  });

  it("falls back to the status when the body carries no message", () => {
    expect(selectSessionCloseRefusal(500, null).message).toBe("session close failed: 500");
  });

  it("falls back to the status when the body is not an object", () => {
    expect(selectSessionCloseRefusal(502, "Bad Gateway").message).toBe(
      "session close failed: 502",
    );
  });
});
