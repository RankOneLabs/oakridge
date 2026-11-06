import { expect, test } from "bun:test";
import { boundReviewer, credentialsFromEnv } from "../src/http/ingest-auth";
import { tenant } from "./grading-fixture";

test("grade credentials require an explicit reviewer binding in configuration", () => {
  expect(() => credentialsFromEnv({ OBSERVATION_GRADE_CREDENTIALS: JSON.stringify([
    { ...tenant, token: "grade" },
  ]) } as NodeJS.ProcessEnv)).toThrow("reviewer_id binding");
  expect(boundReviewer({ ...tenant, token: "operator", reviewer_id: "oakridge-operator" })).toBe("oakridge-operator");
});
