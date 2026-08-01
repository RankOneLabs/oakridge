import { describe, expect, it } from "vitest";
import { validateRepositoryInputs } from "./repository-inputs";

describe("validateRepositoryInputs", () => {
  it("normalizes multiple keyed repositories", () => {
    expect(validateRepositoryInputs([
      { key: " api ", path: " /repos/api " },
      { key: "web", path: "/repos/web" },
    ])).toEqual({
      ok: true,
      repositories: [
        { key: "api", path: "/repos/api" },
        { key: "web", path: "/repos/web" },
      ],
    });
  });

  it("rejects duplicate keys", () => {
    expect(validateRepositoryInputs([
      { key: "api", path: "/repos/one" },
      { key: "api", path: "/repos/two" },
    ])).toEqual({ ok: false, error: "Repository keys must be unique." });
  });

  it("rejects relative paths", () => {
    expect(validateRepositoryInputs([
      { key: "api", path: "repos/api" },
    ])).toEqual({ ok: false, error: "Repository paths must be absolute." });
  });
});
