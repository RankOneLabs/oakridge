import { describe, expect, it } from "vitest";
import { settleEdit } from "./edit-outcome";

describe("settleEdit", () => {
  it("settles a saved edit as ok", async () => {
    expect(await settleEdit(Promise.resolve({ id: "rev-2" }))).toEqual({ ok: true, value: undefined });
  });

  it("settles a rejected save as its message", async () => {
    expect(await settleEdit(Promise.reject(new Error("409 stale revision")))).toEqual({ ok: false, error: "409 stale revision" });
  });
});
