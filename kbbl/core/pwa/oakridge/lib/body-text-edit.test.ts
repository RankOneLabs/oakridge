import { describe, expect, it } from "vitest";
import { makePlanGraphFixture } from "../__fixtures__/read-models";
import { selectFieldText } from "../artifact-types";
import { replaceBodyText, selectBodyTextFields } from "./body-text-edit";

describe("body text editing", () => {
  it("labels each text by its field names and keeps the other values when one changes", () => {
    const { body } = makePlanGraphFixture([{ id: "core", title: "Core", depends_on: [] }]);
    const summary = selectBodyTextFields(body).find((field) => field.label === "summary");
    expect(summary?.value).toBe("Two cohorts.");
    if (!summary) throw new Error("summary text field missing");
    const edited = replaceBodyText(body, summary.path, "Edited summary");
    expect(selectBodyTextFields(edited ?? body).find((field) => field.label === "summary")?.value).toBe("Edited summary");
    expect(selectBodyTextFields(edited ?? body).find((field) => field.label === "cohorts / 1 / title")?.value).toBe("Core");
    expect(selectFieldText(body, "summary")).toBe("Two cohorts.");
  });

  it("rejects a path the body no longer has", () => {
    const { body } = makePlanGraphFixture([]);
    expect(replaceBodyText(body, [{ kind: "field", key: "missing" }], "wrong")).toBeNull();
  });
});
