import { describe, expect, it } from "vitest";
import { selectStatusTone } from "./status-tone";

describe("selectStatusTone", () => {
  it("marks a unit needing the operator as a warning and a finished one as success", () => {
    expect(selectStatusTone({ kind: "unit", status: "attention" })).toBe("warning");
    expect(selectStatusTone({ kind: "unit", status: "complete" })).toBe("success");
  });

  it("never shows a cancelled unit as complete", () => {
    expect(selectStatusTone({ kind: "unit", status: "cancelled" })).toBe("muted");
  });

  it("shows a stalled inbox item as danger", () => {
    expect(selectStatusTone({ kind: "inbox_item", status: "stalled" })).toBe("danger");
  });

  it("shows a failed attempt as danger", () => {
    expect(selectStatusTone({ kind: "attempt", status: "failed" })).toBe("danger");
  });

  it("maps the development definition's verdicts", () => {
    expect(["pass", "pass_with_notes", "fail"].map((status) => selectStatusTone({ kind: "artifact_value", status })))
      .toEqual(["success", "warning", "danger"]);
  });

  it("uses muted for an artifact value no definition enum maps", () => {
    expect(selectStatusTone({ kind: "artifact_value", status: "superseded" })).toBe("muted");
  });
});
