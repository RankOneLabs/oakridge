import { afterEach, describe, expect, it, vi } from "vitest";
import sample from "./__fixtures__/v2-adapter-sample.json";
import definitionFixture from "./__fixtures__/v2-definition-detail.json";
import { createRun, invalidateCachedRunUnits } from "./client";
import type { OperatorDefinitionDetail } from "./operator-contracts/projections/definition-view";
import { selectAgentSessionTargets, selectLaunchSessionSettings } from "./lib/agent-session-targets";
import type { RepositoryKey } from "./run-types";
import type { CreateRunRequest } from "./launch-types";

const runId = sample.run.run_id;
const definition = definitionFixture.definition as unknown as OperatorDefinitionDetail;
const sessionTargets = selectAgentSessionTargets(definition.workflow);
const selectedSettings = selectLaunchSessionSettings(sessionTargets, Object.fromEntries(sessionTargets.map((target) =>
  [target.key, { runtime: "claude-code" as const, model: "sonnet" }])));
if (!selectedSettings.ok) throw new Error(selectedSettings.error.detail);
const sessionSettings = selectedSettings.value;
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const calls = (respond: (path: string, init?: RequestInit) => unknown) => vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const body = respond(String(input), init);
  if (body instanceof Response) return body;
  return json(body);
});
afterEach(() => { vi.restoreAllMocks(); invalidateCachedRunUnits(null); });

const createRunRequest = (): CreateRunRequest => ({
  workflow_def_id: sample.run.definition_id, project_id: null,
  context: { brief_notes: "Build it", repositories: [{ key: "api" as RepositoryKey, path: "/repo", integration_branch: "main" }],
    worktree_path: "/repo", base_branch: "epic/x", oakridge_url: "http://oakridge", session_settings: sessionSettings,
    grading_enabled: false },
  epic_profile: { title: "Build it", slug: "build-it", final_merge_policy: "guarded",
    repositories: [{ repository_key: "api" as RepositoryKey, repository_path: "/repo", integration_branch: "main",
      forge_repository: { provider: "github", owner: "acme", name: "api" } }] },
  workflow_input: { kind: "development" },
});

describe("v2 Oakridge client launch", () => {
  it("launches with a separate setting for each declared agent worker, then reads back", async () => {
    const fetch = calls((path) => path.includes("/api/definitions/") ? definition
      : path.endsWith("/api/runs") ? { kind: "committed", run_id: runId, event_id: "event-2" }
      : path.includes("/units") ? sample.units : sample.run);
    const request = createRunRequest();
    const result = await createRun({ ...request, context: { ...request.context,
      session_settings: { ...sessionSettings, cohort: { ...sessionSettings.cohort,
        builder: { harness: "codex", model: "gpt-6-sol", effort: null } } } } }, "launch-1");
    const launch = fetch.mock.calls.find(([path]) => String(path).endsWith("/api/runs"));
    const body = JSON.parse(String(launch?.[1]?.body));
    expect([result.id, body.request_id, body.definition_id, Object.hasOwn(body.input, "admission"), Object.keys(body.config.sessions).sort(),
      body.config.sessions.cohort.assessor, body.config.sessions.cohort.builder]).toEqual([
      runId, "launch-1", sample.run.definition_id, false,
      ["analysis", "brief", "cohort", "integration", "planning"],
      { harness: "claude-code", model: "sonnet", effort: null },
      { harness: "codex", model: "gpt-6-sol", effort: null },
    ]);
  });

  it.each([true, false])("launches with the run's automatic grading choice %s in its config", async (grading_enabled) => {
    const fetch = calls((path) => path.includes("/api/definitions/") ? definition
      : path.endsWith("/api/runs") ? { kind: "committed", run_id: runId, event_id: "event-grading" }
      : path.includes("/units") ? sample.units : sample.run);
    const request = createRunRequest();
    await createRun({ ...request, context: { ...request.context, grading_enabled } }, `launch-grading-${grading_enabled}`);
    const launch = fetch.mock.calls.find(([path]) => String(path).endsWith("/api/runs"));
    expect(JSON.parse(String(launch?.[1]?.body)).config.grading_enabled).toBe(grading_enabled);
  });

  it("launches every selected repository with the first as primary", async () => {
    const fetch = calls((path) => path.includes("/api/definitions/") ? definition
      : path.endsWith("/api/runs") ? { kind: "committed", run_id: runId, event_id: "event-multi" }
      : path.includes("/units") ? sample.units : sample.run);
    const request = createRunRequest();
    await createRun({ ...request,
      context: { ...request.context, repositories: [...request.context.repositories,
        { key: "web" as RepositoryKey, path: "/web", integration_branch: "develop" }] },
      epic_profile: { ...request.epic_profile, repositories: [...request.epic_profile.repositories,
        { repository_key: "web" as RepositoryKey, repository_path: "/web", integration_branch: "develop",
          forge_repository: { provider: "github", owner: "acme", name: "web" } }] } }, "launch-multi");
    const launch = fetch.mock.calls.find(([path]) => String(path).endsWith("/api/runs"));
    const input = JSON.parse(String(launch?.[1]?.body)).input;
    expect([input.primary_repository_key, input.repositories]).toEqual(["api", [
      { key: "api", preparation: { repository_path: "/repo", expected_head: null },
        forge: { owner: "acme", name: "api", build_base: "epic/x", final_base: "main" } },
      { key: "web", preparation: { repository_path: "/web", expected_head: null },
        forge: { owner: "acme", name: "web", build_base: "epic/x", final_base: "develop" } },
    ]]);
  });

  it("refuses a launch with no repository", async () => {
    calls((path) => path.includes("/api/definitions/") ? definition : sample.run);
    const request = createRunRequest();
    await expect(createRun({ ...request, context: { ...request.context, repositories: [] } }, "launch-none"))
      .rejects.toThrow("A run requires at least one repository");
  });

  it("refuses a launch whose input is for another workflow than the pinned one", async () => {
    const study = { ...definition, bundle: { ...definition.bundle, key: "study" } };
    const fetch = calls((path) => path.includes("/api/definitions/") ? study : sample.run);
    await expect(createRun(createRunRequest(), "launch-study")).rejects.toThrow("the study workflow cannot launch with development input");
    expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("launches a study with its slice limits and no approved plan", async () => {
    const study = { ...definition, bundle: { ...definition.bundle, key: "study" } };
    const fetch = calls((path) => path.includes("/api/definitions/") ? study
      : path.endsWith("/api/runs") ? { kind: "committed", run_id: runId, event_id: "event-study" }
      : path.includes("/units") ? sample.units : sample.run);
    await createRun({ ...createRunRequest(), workflow_input: { kind: "study", slice: { slice_case_limit: 6, slice_cap_cents: 1000 } } }, "launch-study");
    const launch = fetch.mock.calls.find(([path]) => String(path).endsWith("/api/runs"));
    expect(JSON.parse(String(launch?.[1]?.body)).input).toEqual({ title: "Build it", spec: "Build it", primary_repository_key: "api", final_merge_policy: "require_merge",
      repositories: [expect.objectContaining({ key: "api" })],
      slice_case_limit: 6, slice_cap_cents: 1000, approved_plan: null });
  });

  it("accepts settings for an agent declared through a worker template", async () => {
    const templated = {
      ...definition,
      workflow: {
        ...definitionFixture.definition.workflow,
        workers: { author_template: { kind: "agent" }, watch_template: { kind: "code" } },
        stages: { ...definitionFixture.definition.workflow.stages,
          analysis: { workers: { author: { template: "author_template" }, spec_editor: { template: "author_template" }, watch: { template: "watch_template" } } } },
      },
    } as unknown as OperatorDefinitionDetail;
    const fetch = calls((path) => path.includes("/api/definitions/") ? templated
      : path.endsWith("/api/runs") ? { kind: "committed", run_id: runId, event_id: "event-template" }
      : path.includes("/units") ? sample.units : sample.run);
    await createRun(createRunRequest(), "launch-template");
    const launch = fetch.mock.calls.find(([path]) => String(path).endsWith("/api/runs"));
    expect(JSON.parse(String(launch?.[1]?.body)).config.sessions.analysis.author)
      .toEqual(sessionSettings.analysis.author);
  });
});
