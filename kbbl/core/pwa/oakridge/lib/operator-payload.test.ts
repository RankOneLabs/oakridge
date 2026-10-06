import { expect, it } from "vitest";
import type { OperatorSchema } from "../operator-contracts";
import { parseOperatorFieldValue } from "./operator-payload";

const boolean: OperatorSchema = { key: "flag", shape: { kind: "boolean" } };
const integer: OperatorSchema = { key: "count", shape: { kind: "integer", min: -10, max: 10 } };
const reference: OperatorSchema = { key: "revision", shape: { kind: "reference", brand: "artifact_revision" } };
it.each(["", " ", "yes", "FALSE", "0"])("rejects invalid boolean text %j", (raw) => {
  expect(parseOperatorFieldValue({ raw, schema: boolean }).ok).toBe(false);
});
it.each(["", " ", "1.5", "1e1", "0x1", "NaN", "11", "9007199254740993"])("rejects invalid integer text %j", (raw) => {
  expect(parseOperatorFieldValue({ raw, schema: integer }).ok).toBe(false);
});
it.each([{ raw: "true", value: true }, { raw: "false", value: false }])("parses explicit boolean $raw", ({ raw, value }) => {
  expect(parseOperatorFieldValue({ raw, schema: boolean })).toEqual({ ok: true, value });
});
it.each([{ raw: "0", value: 0 }, { raw: " -2 ", value: -2 }])("parses explicit integer $raw", ({ raw, value }) => {
  expect(parseOperatorFieldValue({ raw, schema: integer })).toEqual({ ok: true, value });
});
it("decodes a reference payload as an object", () => {
  expect(parseOperatorFieldValue({ raw: '{"brand":"artifact_revision","id":"revision-1"}', schema: reference }))
    .toEqual({ ok: true, value: { brand: "artifact_revision", id: "revision-1" } });
});
it.each(['"revision-1"', '{"brand":"resource","id":"revision-1"}', '{"brand":"artifact_revision","id":""}', '{'])
  ("rejects invalid reference text %j", (raw) => {
    expect(parseOperatorFieldValue({ raw, schema: reference }).ok).toBe(false);
  });
