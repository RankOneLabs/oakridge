import { expect, test } from "bun:test";

import { KbblExecutorAdapter } from "../src/adapters/kbbl";
import type { ExecutionRequest } from "../src/domain/execution";
import type { ExecutionId, StageInstanceId, UnitId } from "../src/domain/primitives";

test("kbbl adapter derives a stable session key from execution and function identity", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const adapter = new KbblExecutorAdapter({
    base_url: "http://kbbl.test",
    executor_function_identity: "executor-step-v1",
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ kind: "started", session: { sid: "session-1", status: "live", endReason: null } }, { status: 201 });
    },
  });
  const request: ExecutionRequest = {
    execution_id: "execution-1" as ExecutionId,
    stage_instance_id: "stage-1" as StageInstanceId,
    unit_id: "unit-1" as UnitId,
    executor_type: "delegated_session",
    resolved_config: { runtime: "claude-code", rendered_prompt: "Build", workdir: "/repo", session_name: "builder", model: null, effort: null, artifact_id: null,
      worktree: { branchName: "cohort/stage-1/unit-1", worktreeSubdir: "stage-1/unit-1", baseRef: "epic/test" } },
    inputs: [],
    declared_outputs: [],
  };
  expect(await adapter.start_or_attach(request)).toEqual({ kind: "kbbl_session", session_id: "session-1" });
  expect(calls[0]?.url).toEndWith("/sessions/resumable/execution-1%3Aexecutor-step-v1");
  expect(calls[0]?.body).toEqual({ initial_prompt: "Build", workdir: "/repo", name: "builder", runtime: "claude-code",
    worktree: { branch_name: "cohort/stage-1/unit-1", worktree_subdir: "stage-1/unit-1", base_ref: "epic/test" } });
});

test("kbbl adapter observes terminal mechanism state without completing an Oakridge stage", async () => {
  const adapter = new KbblExecutorAdapter({
    base_url: "http://kbbl.test",
    executor_function_identity: "executor-step-v1",
    fetch: async (input) => String(input).endsWith("/terminal")
      ? Response.json({ session: { sid: "session-1", status: "ended", endReason: "subprocess_exited" }, exit_code: 0 })
      : Response.json({ kind: "attached", session: { sid: "session-1", status: "live", endReason: null } }),
  });
  const executionId = "execution-2" as ExecutionId;
  await adapter.start_or_attach({
    execution_id: executionId,
    stage_instance_id: "stage-1" as StageInstanceId,
    unit_id: "unit-1" as UnitId,
    executor_type: "delegated_session",
    resolved_config: { runtime: "claude-code", rendered_prompt: "Build", workdir: "/repo", session_name: "builder", model: null, effort: null, artifact_id: null },
    inputs: [], declared_outputs: [],
  });
  expect(await adapter.observe_terminal(executionId)).toEqual({ kind: "succeeded", metadata: { session_id: "session-1", exit_code: 0 } });
});

test("kbbl adapter requests a fresh session inheriting the producer workspace", async () => {
  let body: unknown = null;
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl.test", executor_function_identity: "assessor-v1", fetch: async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({ kind: "started", session: { sid: "assessment-session", status: "live", endReason: null } }, { status: 201 });
  } });
  await adapter.start_or_attach({
    execution_id: "assessment-execution" as ExecutionId, stage_instance_id: "assessment-stage" as StageInstanceId, unit_id: "web" as UnitId,
    executor_type: "delegated_session", resolved_config: { runtime: "claude-code", rendered_prompt: "Assess", workdir: "/repo", session_name: "assessor", model: null, effort: null },
    inputs: [], declared_outputs: [], workspace_source: { execution_id: "build-execution" as ExecutionId,
      external_reference: { kind: "kbbl_session", session_id: "build-session" } },
  });
  expect(body).toEqual({ initial_prompt: "Assess", workdir: "/repo", name: "assessor", runtime: "claude-code", inherit_worktree_from: "build-session" });
});

test("kbbl adapter refuses to both cut and inherit a worktree", async () => {
  let called = false;
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl.test", executor_function_identity: "assessor-v1", fetch: async () => {
    called = true;
    return Response.json({ kind: "started", session: { sid: "session-1", status: "live", endReason: null } }, { status: 201 });
  } });
  const request: ExecutionRequest = {
    execution_id: "conflicted-execution" as ExecutionId, stage_instance_id: "assessment-stage" as StageInstanceId, unit_id: "web" as UnitId,
    executor_type: "delegated_session", resolved_config: { runtime: "claude-code", rendered_prompt: "Assess", workdir: "/repo", session_name: "assessor", model: null, effort: null,
      worktree: { branchName: "cohort/web", worktreeSubdir: "web" } },
    inputs: [], declared_outputs: [], workspace_source: { execution_id: "build-execution" as ExecutionId,
      external_reference: { kind: "kbbl_session", session_id: "build-session" } },
  };
  await expect(adapter.start_or_attach(request)).rejects.toThrow("mutually exclusive");
  expect(called).toBe(false);
});

test("kbbl adapter delivers workflow input through a persisted session", async () => {
  const calls: Array<{ url: string; body: BodyInit | null | undefined }> = [];
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl", executor_function_identity: "build", fetch: async (input, init) => {
    calls.push({ url: String(input), body: init?.body });
    return new Response("{}", { status: 200 });
  } });
  await adapter.deliver_input("execution-1" as ExecutionId, "revision-1", "Please address the assessment.", { kind: "kbbl_session", session_id: "session-1" });
  expect(calls).toEqual([{ url: "http://kbbl/sessions/resumable/session-1/input/revision-1", body: JSON.stringify({ text: "Please address the assessment." }) }]);
});

test("kbbl adapter reports generalized input delivery failures", async () => {
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl", executor_function_identity: "build", fetch: async () => new Response("unavailable", { status: 503 }) });
  await expect(adapter.deliver_input("execution-1" as ExecutionId, "input-1", "Please respond.", { kind: "kbbl_session", session_id: "session-1" }))
    .rejects.toThrow("kbbl input delivery failed (503): unavailable");
});

test("kbbl cancellation fences a persisted session reference after process recovery", async () => {
  const urls: string[] = [];
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl", executor_function_identity: "build", fetch: async (input) => {
    urls.push(String(input));
    return new Response(null, { status: 204 });
  } });
  await adapter.cancel_or_fence("execution-after-restart" as ExecutionId, { kind: "kbbl_session", session_id: "session-persisted" });
  expect(urls).toEqual(["http://kbbl/sessions/session-persisted"]);
});
