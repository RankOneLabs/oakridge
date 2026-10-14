import { describe, expect, it } from "vitest";
import { makeSpecFile } from "../__fixtures__/read-models";

import {
  MAX_SPEC_FILE_BYTES,
  formatBytes,
  readSpecFile,
  selectSpecFileRefusal,
  selectLoadedSpecRefusal,
} from "./spec-file";

describe("selectSpecFileRefusal", () => {
  it("accepts a file within the limit", () => {
    expect(selectSpecFileRefusal(makeSpecFile("spec.md", 4_096))).toBeNull();
  });

  it("refuses an empty file by name", () => {
    expect(selectSpecFileRefusal(makeSpecFile("spec.md", 0))?.detail).toBe("spec.md is empty.");
  });

  /**
   * A spec is forwarded into an agent's prompt, so the wrong file picked
   * by accident costs more than a rejected upload.
   */
  it("refuses a file over the limit and says both sizes", () => {
    const refusal = selectSpecFileRefusal(makeSpecFile("dump.json", MAX_SPEC_FILE_BYTES + 1));
    expect(refusal?.detail).toBe("dump.json is 1.0 MB, over the 1.0 MB limit for a spec.");
  });

  it("accepts a file exactly at the limit", () => {
    expect(selectSpecFileRefusal(makeSpecFile("spec.md", MAX_SPEC_FILE_BYTES))).toBeNull();
  });
});

describe("selectLoadedSpecRefusal", () => {
  it("accepts text with content", () => {
    expect(selectLoadedSpecRefusal(makeSpecFile("spec.md", 12), "Ship it")).toBeNull();
  });

  /**
   * Whitespace passes the size guard, and would otherwise fail later against
   * the textarea's own required check — pointing the operator at a field they
   * are not looking at.
   */
  it("refuses a file that is only whitespace", () => {
    expect(selectLoadedSpecRefusal(makeSpecFile("spec.md", 12), "  \n\t ")?.detail)
      .toBe("spec.md has no readable text.");
  });
});

describe("readSpecFile", () => {
  it("returns the text and the name it came from", async () => {
    expect(await readSpecFile(makeSpecFile("spec.md", 7, "Ship it"))).toEqual({
      ok: true, value: { text: "Ship it", file_name: "spec.md" },
    });
  });

  it("preserves the exact text, including trailing structure", async () => {
    const body = "# Spec\n\n- one\n- two\n";
    const result = await readSpecFile(makeSpecFile("spec.md", body.length, body));
    expect(result.ok && result.value.text).toBe(body);
  });

  it("refuses before reading when the file is too large", async () => {
    let read = false;
    const result = await readSpecFile(makeSpecFile("dump.json", MAX_SPEC_FILE_BYTES + 1, async () => {
      read = true;
      return "x";
    }));
    expect(result.ok).toBe(false);
    expect(read).toBe(false);
  });

  it("converts a failed read into an error value", async () => {
    const result = await readSpecFile(makeSpecFile("spec.md", 7, () => Promise.reject(new Error("gone"))));
    expect(result).toEqual({
      ok: false, error: { operation: "read_spec_file", detail: "Could not read spec.md." },
    });
  });
});

describe("formatBytes", () => {
  it("reads kilobytes below a megabyte", () => {
    expect(formatBytes(4_096)).toBe("4 KB");
  });

  it("reads megabytes at and above one", () => {
    expect(formatBytes(2_621_440)).toBe("2.5 MB");
  });

  /** A tiny file should not round to "0 KB" in a message about its size. */
  it("never reports a non-empty file as zero", () => {
    expect(formatBytes(12)).toBe("1 KB");
  });
});
