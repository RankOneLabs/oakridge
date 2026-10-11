import { describe, expect, test } from "vitest";
import { makeDevelopmentRootFields, makeDevelopmentSchemas, makeProject, makeProjectFormValues } from "./__fixtures__/read-models";
import { selectProjectDraft } from "./lib/project-draft";
import { selectProjectLaunchDrafts } from "./lib/project-launch";

describe("repository inputs for pinned launches", () => {
  test("prefills the pinned repository input from a saved project's forge identity", () => {
    const project = makeProject({ name: "PAA dot DEV", repo_dir: "/repos/paa",
      forge_repository: { provider: "github", owner: "RankOneLabs", name: "paa_site" }, integration_branch: "develop" });
    const drafts = selectProjectLaunchDrafts(project, makeDevelopmentRootFields(), makeDevelopmentSchemas());
    expect(JSON.parse(drafts.repositories!)[0]).toMatchObject({
      key: "PAA dot DEV", preparation: { repository_path: "/repos/paa" },
      forge: { owner: "RankOneLabs", name: "paa_site", build_base: "develop", final_base: "develop" },
    });
  });

  test("keeps the operator's explicit forge fields in a project draft", () => {
    const draft = selectProjectDraft(makeProjectFormValues({ owner: "acme", repository: "api", integration_branch: "release" }));
    expect(draft).toMatchObject({ forge_repository: { owner: "acme", name: "api" }, integration_branch: "release" });
  });

  test("trims project and repository text before submission", () => {
    const draft = selectProjectDraft(makeProjectFormValues({ name: " API ", repo_dir: " /repos/api ",
      owner: " acme ", repository: " api ", integration_branch: " main " }));
    expect(draft).toEqual({ name: "API", repo_dir: "/repos/api",
      forge_repository: { provider: "github", owner: "acme", name: "api" }, integration_branch: "main" });
  });
});
