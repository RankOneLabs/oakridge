import { describe, expect, it } from "vitest";

import { buildEpicProfile } from "./launch-config";
import type { RepositoryKey } from "../types";

describe("buildEpicProfile", () => {
  it("builds the durable forge repository contract expected by CreateWorkflowRun", () => {
    expect(buildEpicProfile(" Full parity! ", "guarded", [{
      key: "oakridge" as RepositoryKey,
      path: "/code/oakridge",
      forge_owner: "acme",
      forge_name: "oakridge",
      base_branch: "main",
    }])).toEqual({
      title: "Full parity!",
      slug: "full-parity",
      final_merge_policy: "guarded",
      repositories: [{
        repository_key: "oakridge",
        repository_path: "/code/oakridge",
        base_branch: "main",
        forge_repository: { provider: "github", owner: "acme", name: "oakridge" },
      }],
    });
  });

  it("rejects a title that cannot produce a durable slug", () => {
    expect(buildEpicProfile("!!!", "guarded", [])).toBeNull();
  });

  it("preserves external confirmation as an explicit operator choice", () => {
    const profile = buildEpicProfile("External integration", "external_confirmation", [{
      key: "oakridge" as RepositoryKey,
      path: "/code/oakridge",
      forge_owner: "acme",
      forge_name: "oakridge",
      base_branch: "main",
    }]);
    expect(profile?.final_merge_policy).toBe("external_confirmation");
  });
});
