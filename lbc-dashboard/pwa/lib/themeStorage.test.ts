import { describe, expect, test } from "bun:test";

import { readStoredTheme, writeStoredTheme } from "./themeStorage";

describe("theme storage", () => {
  test("returns a domain error when reading storage throws", () => {
    const result = readStoredTheme({
      getItem: () => { throw new Error("blocked"); },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        operation: "read-theme",
        key: "lbc-dashboard.theme",
        detail: "blocked",
      },
    });
  });

  test("returns a domain error when writing storage throws", () => {
    const result = writeStoredTheme(
      { setItem: () => { throw new Error("quota exceeded"); } },
      "dark",
    );

    expect(result).toEqual({
      ok: false,
      error: {
        operation: "write-theme",
        key: "lbc-dashboard.theme",
        detail: "quota exceeded",
      },
    });
  });
});
