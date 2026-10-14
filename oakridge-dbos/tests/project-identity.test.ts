import { expect, test } from "bun:test";

import { githubIdentityFromRemote } from "../src/runtime/project-identity";

test("GitHub identity parser accepts the supported remote forms", () => {
  for (const remote of ["git@github.com:RankOneLabs/oakridge.git", "ssh://git@github.com/RankOneLabs/oakridge.git", "https://github.com/RankOneLabs/oakridge.git"]) {
    expect(githubIdentityFromRemote(remote)).toEqual({ provider: "github", owner: "RankOneLabs", name: "oakridge" });
  }
  expect(githubIdentityFromRemote("git@gitlab.com:RankOneLabs/oakridge.git")).toBeNull();
});
