import { describe, expect, test } from "vitest";
import { makeProjectFormValues, makeRuntimeSelection } from "../__fixtures__/read-models";
import { withRoleSessionInput } from "./launch-role-settings";
import { selectProjectDraft } from "./project-draft";

describe("pinned launch input", () => {
  test("keeps the GitHub repository identity and integration branch in the project draft", () => {
    const draft = selectProjectDraft(makeProjectFormValues({ name: " Full parity! ", repo_dir: "/code/oakridge",
      owner: "acme", repository: "oakridge" }));
    expect(draft).toEqual({ name: "Full parity!", repo_dir: "/code/oakridge",
      forge_repository: { provider: "github", owner: "acme", name: "oakridge" }, integration_branch: "main" });
  });

  test("stores unspecified planner and worker effort as explicit null session settings", () => {
    const input = withRoleSessionInput({ sessions: {} }, {
      planner: makeRuntimeSelection({ model: "opus" }), worker: makeRuntimeSelection({ model: "sonnet" }),
    });
    expect(input).toMatchObject({ sessions: { planner: { effort: null }, worker: { effort: null } } });
  });
});
