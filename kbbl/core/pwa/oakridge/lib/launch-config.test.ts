import { describe, expect, test } from "vitest";
import { makeProjectFormValues } from "../__fixtures__/read-models";
import { selectProjectDraft } from "./project-draft";

describe("project draft", () => {
  test("keeps the GitHub repository identity and integration branch in the project draft", () => {
    const draft = selectProjectDraft(makeProjectFormValues({ name: " Full parity! ", repo_dir: "/code/oakridge",
      owner: "acme", repository: "oakridge" }));
    expect(draft).toEqual({ name: "Full parity!", repo_dir: "/code/oakridge",
      forge_repository: { provider: "github", owner: "acme", name: "oakridge" }, integration_branch: "main" });
  });
});
