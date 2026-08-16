import { describe, expect, it } from "vitest";

import { selectThreadPingIdentity } from "./thread-ping-idempotency";

describe("thread ping idempotency", () => {
  it("retains one identity when the same thread is retried after an unknown response", () => {
    const first = selectThreadPingIdentity(null, "thread-1", () => "ping-1");
    expect(selectThreadPingIdentity(first, "thread-1", () => "ping-2")).toBe(first);
  });

  it("creates a different identity for another thread", () => {
    const first = selectThreadPingIdentity(null, "thread-1", () => "ping-1");
    expect(selectThreadPingIdentity(first, "thread-2", () => "ping-2").idempotency_key).toBe("ping-2");
  });
});
