import { afterEach, describe, expect, it, vi } from "vitest";
import { makeProject, makeProjectDraft } from "./__fixtures__/read-models";
import { updateOperatorProject } from "./client";
import { OakridgeHttpError } from "./lib/client-errors";

afterEach(() => vi.unstubAllGlobals());

describe("updateOperatorProject", () => {
  it("returns the updated project projected by the authority", async () => {
    const project = makeProject();
    const fetch = vi.fn(async (_url: string) => Response.json(project));
    vi.stubGlobal("fetch", fetch);

    expect(await updateOperatorProject(project.id, makeProjectDraft())).toEqual(project);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/oakridge/api/api/projects/${project.id}`);
  });

  it("retains the authority's failure detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "repository not found" }, { status: 400 })));
    await expect(updateOperatorProject("project-1", makeProjectDraft())).rejects.toEqual(
      new OakridgeHttpError(400, "repository not found"));
  });

  it("rejects a malformed successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    await expect(updateOperatorProject("project-1", makeProjectDraft())).rejects.toBeInstanceOf(SyntaxError);
  });
});
