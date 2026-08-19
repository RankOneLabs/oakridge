import { describe, expect, it } from "vitest";

import {
  MAX_BRIEF_NOTES_BYTES,
  formatBytes,
  readBriefNotesFile,
  selectBriefNotesFileRefusal,
  selectLoadedBriefNotesRefusal,
  selectMissingBriefNotesDetail,
} from "./brief-notes";

const file = (name: string, size: number, text?: string | (() => Promise<string>)) => ({
  name,
  size,
  text: typeof text === "function" ? text : async () => text ?? "",
});

describe("selectBriefNotesFileRefusal", () => {
  it("accepts a file within the limit", () => {
    expect(selectBriefNotesFileRefusal(file("brief.md", 4_096))).toBeNull();
  });

  it("refuses an empty file by name", () => {
    expect(selectBriefNotesFileRefusal(file("brief.md", 0))?.detail).toBe("brief.md is empty.");
  });

  /**
   * Brief notes are forwarded into an agent's prompt, so the wrong file picked
   * by accident costs more than a rejected upload.
   */
  it("refuses a file over the limit and says both sizes", () => {
    const refusal = selectBriefNotesFileRefusal(file("dump.json", MAX_BRIEF_NOTES_BYTES + 1));
    expect(refusal?.detail).toBe("dump.json is 1.0 MB, over the 1.0 MB limit for brief notes.");
  });

  it("accepts a file exactly at the limit", () => {
    expect(selectBriefNotesFileRefusal(file("brief.md", MAX_BRIEF_NOTES_BYTES))).toBeNull();
  });
});

describe("selectLoadedBriefNotesRefusal", () => {
  it("accepts text with content", () => {
    expect(selectLoadedBriefNotesRefusal(file("brief.md", 12), "Ship it")).toBeNull();
  });

  /**
   * Whitespace passes the size guard, and would otherwise fail later against
   * the textarea's own required check — pointing the operator at a field they
   * are not looking at.
   */
  it("refuses a file that is only whitespace", () => {
    expect(selectLoadedBriefNotesRefusal(file("brief.md", 12), "  \n\t ")?.detail)
      .toBe("brief.md has no readable text.");
  });
});

describe("readBriefNotesFile", () => {
  it("returns the text and the name it came from", async () => {
    expect(await readBriefNotesFile(file("brief.md", 7, "Ship it"))).toEqual({
      ok: true, value: { text: "Ship it", file_name: "brief.md" },
    });
  });

  it("preserves the exact text, including trailing structure", async () => {
    const body = "# Brief\n\n- one\n- two\n";
    const result = await readBriefNotesFile(file("brief.md", body.length, body));
    expect(result.ok && result.value.text).toBe(body);
  });

  it("refuses before reading when the file is too large", async () => {
    let read = false;
    const result = await readBriefNotesFile(file("dump.json", MAX_BRIEF_NOTES_BYTES + 1, async () => {
      read = true;
      return "x";
    }));
    expect(result.ok).toBe(false);
    expect(read).toBe(false);
  });

  it("converts a failed read into an error value", async () => {
    const result = await readBriefNotesFile(file("brief.md", 7, () => Promise.reject(new Error("gone"))));
    expect(result).toEqual({
      ok: false, error: { operation: "read_brief_notes_file", detail: "Could not read brief.md." },
    });
  });
});

describe("selectMissingBriefNotesDetail", () => {
  it("points at the textarea when notes are typed", () => {
    expect(selectMissingBriefNotesDetail({ kind: "typed" })).toBe("Brief notes are required.");
  });

  /**
   * The generic message reads as a broken form to an operator looking at a file
   * picker they have not used yet.
   */
  it("points at the picker when notes come from a file", () => {
    expect(selectMissingBriefNotesDetail({ kind: "file", file_name: "" }))
      .toBe("Choose a file with the brief notes.");
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
