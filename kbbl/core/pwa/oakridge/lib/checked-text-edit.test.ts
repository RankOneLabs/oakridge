import { describe, expect, it } from "vitest";
import { makePlanGraphFixture } from "../__fixtures__/read-models";
import { replaceCheckedText, selectCheckedTextFields } from "./checked-text-edit";

describe("checked text editing", () => {
  it("uses generated schema labels and preserves sibling values when an atom changes", () => {
    const { body, schemas } = makePlanGraphFixture([{ id: "core", title: "Core", depends_on: [] }]);
    const summary = selectCheckedTextFields(body, schemas).find((field) => field.label === "summary");
    expect(summary?.value).toBe("Two cohorts.");
    if (!summary) throw new Error("summary text field missing");
    const edited = replaceCheckedText(body, summary.path, "Edited summary");
    expect(selectCheckedTextFields(edited ?? body, schemas).find((field) => field.label === "summary")?.value).toBe("Edited summary");
    expect(selectCheckedTextFields(edited ?? body, schemas).find((field) => field.label === "cohorts / 1 / title")?.value).toBe("Core");
    expect(body.data.kind === "record" && body.data.fields[0]?.value?.data.kind === "string" && body.data.fields[0].value.data.value).toBe("Two cohorts.");
  });

  it("rejects a path whose checked structure no longer matches", () => {
    const { body } = makePlanGraphFixture([]);
    expect(replaceCheckedText(body, [{ kind: "field", id: 100 }], "wrong")).toBeNull();
  });
});
