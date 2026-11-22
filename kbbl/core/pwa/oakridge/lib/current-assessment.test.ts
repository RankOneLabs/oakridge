import { describe, expect, it } from "vitest";
import { CURRENT_ASSESSMENT, MET_WITH_REGRESSION } from "../__fixtures__/current-assessments";
import { parseCurrentAssessment, selectDerivedVerdict } from "./current-assessment";

describe("assessment rendering", () => {
  it("reads the assessment evidence", () => expect(parseCurrentAssessment(CURRENT_ASSESSMENT).ok).toBe(true));
  it("derives the regression verdict", () => expect(selectDerivedVerdict(MET_WITH_REGRESSION).verdict).toBe("fail"));
});
