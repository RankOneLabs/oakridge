import { expect, test } from "bun:test";
import { canonicalDigest } from "../src/canonical/canonical-json";
import { occurrenceId } from "../src/projection/occurrence-id";

const first = { producer: "oakridge", namespace: "local", revision_id: "r1", extractor_id: "plan.criteria",
  extractor_version: "1", item_selector: "/cohorts/*/acceptance_criteria/*", item_id_or_path: "/cohorts/0/acceptance_criteria/0" };

test("occurrence id is the canonical digest of the ordered seven-field tuple", () => {
  const expected = canonicalDigest(["oakridge", "local", "r1", "plan.criteria", "1",
    "/cohorts/*/acceptance_criteria/*", "/cohorts/0/acceptance_criteria/0"]);
  if (!expected.ok) throw new Error(expected.error.detail);
  const actual = occurrenceId(first);
  expect(String(actual.ok && actual.value)).toBe(String(expected.value));
  expect(occurrenceId(first)).toEqual(occurrenceId(first));
});

test("extractor version and successor revision each produce a distinct identity", () => {
  const original = occurrenceId(first);
  expect(occurrenceId({ ...first, extractor_version: "2" })).not.toEqual(original);
  expect(occurrenceId({ ...first, revision_id: "r2", item_id_or_path: "/cohorts/0/acceptance_criteria/1" })).not.toEqual(original);
  expect(occurrenceId(first)).toEqual(original);
});
