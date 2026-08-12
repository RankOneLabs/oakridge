import { describe, expect, it } from "vitest";
import { repositoryDraftFromProject, validateRepositoryInputs } from "./repository-inputs";

describe("repositoryDraftFromProject", () => {
  it("prefills forge identity derived from the local repository", () => {
    expect(repositoryDraftFromProject({
      id: "project-1", name: "PAA dot DEV", repo_dir: "/repos/paa", created_at: "2026-08-12T00:00:00Z",
      forge_repository: { provider: "github", owner: "RankOneLabs", name: "paa_site" }, base_branch: "develop",
    }, { key: "repo", path: "", forge_owner: "", forge_name: "", base_branch: "main" })).toEqual({
      key: "paa-dot-dev", path: "/repos/paa", forge_owner: "RankOneLabs", forge_name: "paa_site", base_branch: "develop",
    });
  });

  it("keeps explicit overrides when identity cannot be derived", () => {
    expect(repositoryDraftFromProject({
      id: "project-1", name: "API", repo_dir: "/repos/api", created_at: "2026-08-12T00:00:00Z",
    }, { key: "old", path: "/old", forge_owner: "acme", forge_name: "api", base_branch: "release" })).toMatchObject({
      forge_owner: "acme", forge_name: "api", base_branch: "release",
    });
  });
});

describe("validateRepositoryInputs", () => {
  it("normalizes multiple keyed repositories", () => {
    expect(validateRepositoryInputs([
      { key: " api ", path: " /repos/api ", forge_owner: " acme ", forge_name: " api ", base_branch: " main " },
      { key: "web", path: "/repos/web", forge_owner: "acme", forge_name: "web", base_branch: "main" },
    ])).toEqual({
      ok: true,
      repositories: [
        { key: "api", path: "/repos/api", forge_owner: "acme", forge_name: "api", base_branch: "main" },
        { key: "web", path: "/repos/web", forge_owner: "acme", forge_name: "web", base_branch: "main" },
      ],
    });
  });

  it("rejects duplicate keys", () => {
    expect(validateRepositoryInputs([
      { key: "api", path: "/repos/one", forge_owner: "acme", forge_name: "one", base_branch: "main" },
      { key: "api", path: "/repos/two", forge_owner: "acme", forge_name: "two", base_branch: "main" },
    ])).toEqual({
      ok: false,
      error: {
        operation: "validate_repository_inputs",
        repository: "api",
        detail: "Repository keys must be unique.",
      },
    });
  });

  it("rejects relative paths", () => {
    expect(validateRepositoryInputs([
      { key: "api", path: "repos/api", forge_owner: "acme", forge_name: "api", base_branch: "main" },
    ])).toEqual({
      ok: false,
      error: {
        operation: "validate_repository_inputs",
        repository: 0,
        detail: "Repository paths must be absolute.",
      },
    });
  });

  it("requires durable GitHub identity and base branch", () => {
    expect(validateRepositoryInputs([{
      key: "api",
      path: "/repos/api",
      forge_owner: "",
      forge_name: "api",
      base_branch: "main",
    }])).toEqual({
      ok: false,
      error: {
        operation: "validate_repository_inputs",
        repository: 0,
        detail: "Every repository needs a key, local path, GitHub owner/name, and base branch.",
      },
    });
  });
});
