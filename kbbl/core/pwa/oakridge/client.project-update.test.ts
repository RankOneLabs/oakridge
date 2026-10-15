import { afterEach, describe, expect, it, vi } from "vitest";

import { updateProject } from "./client";
import type { ProjectId } from "./types";

const projectId = "00000000-0000-4000-8000-000000000001" as ProjectId;
const command = { id: projectId, project: { name: "Scout", repo_dir: "/code/rol/scout" } };

afterEach(() => { vi.unstubAllGlobals(); });

describe("updateProject", () => {
  it("returns the updated project as a typed result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: projectId,
      name: "Scout",
      repo_dir: "/code/rol/scout",
      created_at: "2026-08-15T12:00:00Z",
      forge_repository: { provider: "github", owner: "RankOneLabs", name: "scout" },
      base_branch: "main",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const result = await updateProject(command);

    expect(result).toEqual({ ok: true, value: expect.objectContaining({ id: projectId, repo_dir: "/code/rol/scout" }) });
  });

  it("returns HTTP failures with operation and path context", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "repository not found" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })));

    const result = await updateProject(command);

    expect(result).toEqual({ ok: false, error: { operation: "update project", path: `/projects/${projectId}`, detail: "repository not found" } });
  });

  it("returns malformed successful responses as parsing failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));

    const result = await updateProject(command);

    expect(result).toEqual({ ok: false, error: { operation: "update project", path: `/projects/${projectId}`, detail: expect.any(String) } });
  });
});
