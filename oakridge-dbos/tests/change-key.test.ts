import { describe, expect, test } from "bun:test";
import { isTagCurrent, selectEntityTag } from "../src/http/change-key";
import type { ReadChangeKey } from "../src/storage/read-store";

const tag = selectEntityTag("4.1.0" as ReadChangeKey, "epoch");

describe("isTagCurrent", () => {
  test("a header naming the current tag is current", () => {
    expect(isTagCurrent(tag, tag)).toBe(true);
  });
  test("a tag from before the latest change is not current", () => {
    expect(isTagCurrent(selectEntityTag("3.1.0" as ReadChangeKey, "epoch"), tag)).toBe(false);
  });
  test("a tag from before a restart is not current", () => {
    expect(isTagCurrent(selectEntityTag("4.1.0" as ReadChangeKey, "earlier"), tag)).toBe(false);
  });
  test("a list of tags is current when any one matches", () => {
    expect(isTagCurrent(`W/"other", ${tag}`, tag)).toBe(true);
  });
  test("no header is never current", () => {
    expect(isTagCurrent(undefined, tag)).toBe(false);
  });
});
