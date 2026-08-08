import { describe, expect, it } from "vitest";
import { validateEpicBranch } from "./epic-branch";

describe("validateEpicBranch", () => {
  it("normalizes an epic integration branch", () => {
    expect(validateEpicBranch("  epic/oakridge-v2  ")).toEqual({ ok: true, branch: "epic/oakridge-v2" });
  });

  it.each(["", "main", "feature/oakridge", "epic/bad branch", "epic/bad..branch"])(
    "rejects a branch that cannot be an epic integration target: %s",
    (branch) => expect(validateEpicBranch(branch).ok).toBe(false),
  );
});
