import { expect, test } from "bun:test";

import { GitProjectRepositoryIdentityResolver, githubIdentityFromRemote } from "../src/runtime/project-identity";

test("GitHub identity parser accepts the remote forms supported by Rust v2", () => {
  for (const remote of ["git@github.com:RankOneLabs/oakridge.git", "ssh://git@github.com/RankOneLabs/oakridge.git", "https://github.com/RankOneLabs/oakridge.git"]) {
    expect(githubIdentityFromRemote(remote)).toEqual({ provider: "github", owner: "RankOneLabs", name: "oakridge" });
  }
  expect(githubIdentityFromRemote("git@gitlab.com:RankOneLabs/oakridge.git")).toBeNull();
});

test("git resolver derives forge identity and the origin default branch", async () => {
  const resolver = new GitProjectRepositoryIdentityResolver(async (_repoDir, args) => args[0] === "remote" ? "git@github.com:RankOneLabs/oakridge.git" : "origin/main");
  expect(await resolver.resolve("/code/oakridge")).toEqual({ forge_repository: { provider: "github", owner: "RankOneLabs", name: "oakridge" }, base_branch: "main" });
});

test("git resolver treats unavailable or unsupported identity as absent", async () => {
  expect(await new GitProjectRepositoryIdentityResolver(async () => null).resolve("/missing")).toBeNull();
  expect(await new GitProjectRepositoryIdentityResolver(async () => "git@gitlab.com:acme/api.git").resolve("/code/api")).toBeNull();
});
