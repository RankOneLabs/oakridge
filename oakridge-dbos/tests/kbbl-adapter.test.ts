import { expect, test } from "bun:test";

import { KbblExecutorAdapter, selectRemoteWorktreeBase, silentDurationMs } from "../src/adapters/kbbl";
import type { ExecutionRequest } from "../src/domain/execution";
import type { ExecutionId, ExecutorOperationId, StageInstanceId, UnitId } from "../src/domain/primitives";

const attempt = (id: string) => id as ExecutorOperationId;

test("kbbl adapter derives a stable session key from the attempt and function identity", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const adapter = new KbblExecutorAdapter({
    base_url: "http://kbbl.test",
    executor_function_identity: "executor-step-v1",
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ kind: "started", session: { sid: "session-1", status: "live", endReason: null, worktreeBaseRef: "a".repeat(40) } }, { status: 201 });
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
    declared_outputs: [], expected_artifacts: [],
  };
  expect(await adapter.start_or_attach(request, attempt("run:1:stage:build:unit:web"))).toEqual({ kind: "kbbl_session", session_id: "session-1", worktree_base_sha: "a".repeat(40) });
  expect(calls[0]?.url).toEndWith("/sessions/resumable/run%3A1%3Astage%3Abuild%3Aunit%3Aweb%3Aexecutor-step-v1");
  expect(calls[0]?.body).toEqual({ initial_prompt: "Build", workdir: "/repo", name: "builder", runtime: "claude-code",
    worktree: { branch_name: "cohort/stage-1/unit-1", worktree_subdir: "stage-1/unit-1", base_ref: "origin/epic/test" } });
});

test("worktree branch bases select the remote-tracking ref while immutable SHAs stay unchanged", () => {
  expect(selectRemoteWorktreeBase("epic/test")).toBe("origin/epic/test");
  expect(selectRemoteWorktreeBase("origin/epic/test")).toBe("origin/epic/test");
  expect(selectRemoteWorktreeBase("a".repeat(40))).toBe("a".repeat(40));
});

test("kbbl adapter observes terminal mechanism state without completing an Oakridge stage", async () => {
  const adapter = new KbblExecutorAdapter({
    base_url: "http://kbbl.test",
    executor_function_identity: "executor-step-v1",
    fetch: async (input) => String(input).includes("/terminal")
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
    inputs: [], declared_outputs: [], expected_artifacts: [],
  }, attempt("run:1:stage:build:unit:web"));
  expect(await adapter.observe_terminal(executionId, { kind: "kbbl_session", session_id: "session-1" })).toEqual({ kind: "terminal", observation: { kind: "succeeded", metadata: { session_id: "session-1", exit_code: 0 } } });
});

test("kbbl adapter reports a still-running session as pending rather than terminal", async () => {
  const urls: string[] = [];
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl", executor_function_identity: "build", observe_wait_ms: 25_000, fetch: async (input) => {
    urls.push(String(input));
    return Response.json({ pending: true }, { status: 202 });
  } });
  expect(await adapter.observe_terminal("execution-1" as ExecutionId, { kind: "kbbl_session", session_id: "session-1" })).toEqual({ kind: "pending" });
  expect(urls).toEqual(["http://kbbl/sessions/resumable/session-1/terminal?wait_ms=25000"]);
});

test("kbbl adapter fails an ended session whose exit code kbbl cannot report", async () => {
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl", executor_function_identity: "build", fetch: async () =>
    Response.json({ session: { sid: "session-1", status: "ended", endReason: "subprocess_exited" }, exit_code: null }) });
  expect(await adapter.observe_terminal("execution-1" as ExecutionId, { kind: "kbbl_session", session_id: "session-1" }))
    .toEqual({ kind: "terminal", observation: { kind: "failed", code: "exit_unknown", detail: "kbbl session session-1 ended without a recorded exit code" } });
});

test("kbbl adapter fails a session that exited non-zero", async () => {
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl", executor_function_identity: "build", fetch: async () =>
    Response.json({ session: { sid: "session-1", status: "ended", endReason: "subprocess_exited" }, exit_code: 1 }) });
  expect(await adapter.observe_terminal("execution-1" as ExecutionId, { kind: "kbbl_session", session_id: "session-1" }))
    .toEqual({ kind: "terminal", observation: { kind: "failed", code: "executor_exit_nonzero", detail: "kbbl runtime exited with code 1" } });
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
    inputs: [], declared_outputs: [], expected_artifacts: [], workspace_source: { execution_id: "build-execution" as ExecutionId,
      external_reference: { kind: "kbbl_session", session_id: "build-session" } },
  }, attempt("run:1:stage:assess:unit:web"));
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
    inputs: [], declared_outputs: [], expected_artifacts: [], workspace_source: { execution_id: "build-execution" as ExecutionId,
      external_reference: { kind: "kbbl_session", session_id: "build-session" } },
  };
  await expect(adapter.start_or_attach(request, attempt("run:1:stage:assess:unit:web"))).rejects.toThrow("mutually exclusive");
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

const recordingAdapter = (urls: string[], status = 204) =>
  new KbblExecutorAdapter({ base_url: "http://kbbl", executor_function_identity: "build", fetch: async (input) => {
    urls.push(String(input));
    return new Response(status === 204 ? null : "held", { status });
  } });

test("kbbl cancellation fences a persisted session reference after process recovery", async () => {
  const urls: string[] = [];
  await recordingAdapter(urls).cancel_or_fence("execution-after-restart" as ExecutionId, { kind: "kbbl_session", session_id: "session-persisted" });
  expect(urls).toEqual(["http://kbbl/sessions/session-persisted?fenced_by=execution-after-restart"]);
});

/**
 * kbbl refuses a close that would abandon a live unit, and a cancelled run
 * stops its agent through exactly this call. Unless the fence names the
 * execution that holds the session, that guard fires on the owner's own
 * teardown and the run deadlocks against itself: it cannot be cancelled while
 * it is active, and it stays active because its session will not close.
 */
test("the fence names the execution holding the session so the hold guard lets it through", async () => {
  const urls: string[] = [];
  await recordingAdapter(urls).cancel_or_fence("012c6027:0" as ExecutionId, { kind: "kbbl_session", session_id: "db26174d" });
  expect(urls[0]).toContain("fenced_by=012c6027%3A0");
});

test("ids are escaped rather than spliced into the query string raw", async () => {
  const urls: string[] = [];
  await recordingAdapter(urls).cancel_or_fence("a b&c:0" as ExecutionId, { kind: "kbbl_session", session_id: "s/1" });
  expect(urls[0]).toBe("http://kbbl/sessions/s%2F1?fenced_by=a%20b%26c%3A0");
});

/** An already-gone session is the outcome the fence wanted. */
test("an unknown session is treated as already fenced", async () => {
  const urls: string[] = [];
  await recordingAdapter(urls, 404).cancel_or_fence("execution-1" as ExecutionId, { kind: "kbbl_session", session_id: "session-1" });
  expect(urls).toHaveLength(1);
});

/** A fence that fails quietly leaves a live agent running against a stopped run. */
test("a refused fence is raised rather than swallowed", async () => {
  await expect(recordingAdapter([], 409).cancel_or_fence("execution-1" as ExecutionId, { kind: "kbbl_session", session_id: "session-1" }))
    .rejects.toThrow("kbbl cancellation failed (409)");
});

const buildRequest: ExecutionRequest = {
  execution_id: "execution-1" as ExecutionId, stage_instance_id: "stage-1" as StageInstanceId, unit_id: "web" as UnitId,
  executor_type: "delegated_session",
  resolved_config: { runtime: "claude-code", rendered_prompt: "Build", workdir: "/repo", session_name: "builder", model: null, effort: null },
  inputs: [], declared_outputs: [], expected_artifacts: [],
};

test("a rerun of the same execution claims a new session instead of the one that already died", async () => {
  const keys: string[] = [];
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl", executor_function_identity: "v1", fetch: async (input) => {
    keys.push(String(input));
    return Response.json({ kind: "started", session: { sid: "session-1", status: "live", endReason: null } }, { status: 201 });
  } });
  // The execution id is shared by every attempt; the workflow running it is not.
  await adapter.start_or_attach(buildRequest, attempt("run:1:stage:build:unit:web"));
  await adapter.start_or_attach(buildRequest, attempt("oakridge-unit-rerun:stage-1:web:rerun-1"));
  expect(new Set(keys).size).toBe(2);
});

test("retrying the same attempt resolves to the one session it already owns", async () => {
  const keys: string[] = [];
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl", executor_function_identity: "v1", fetch: async (input) => {
    keys.push(String(input));
    return Response.json({ kind: "attached", session: { sid: "session-1", status: "live", endReason: null } });
  } });
  await adapter.start_or_attach(buildRequest, attempt("run:1:stage:build:unit:web"));
  await adapter.start_or_attach(buildRequest, attempt("run:1:stage:build:unit:web"));
  expect(new Set(keys).size).toBe(1);
});

test("recovering one v2 work order reuses its external operation for free", async () => {
  const keys: string[] = [];
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl", executor_function_identity: "v2-build", fetch: async (input) => {
    keys.push(String(input));
    return Response.json({ kind: keys.length === 1 ? "started" : "attached", session: { sid: "session-work-1", status: "live", endReason: null } });
  } });
  const workOrderId = attempt("11111111-1111-4111-8111-111111111111");
  await adapter.start_or_attach(buildRequest, workOrderId);
  // This is the call DBOS repeats after a worker/process failure. No domain
  // attempt is replaced; the external idempotency identity is unchanged.
  await adapter.start_or_attach(buildRequest, workOrderId);
  expect(new Set(keys).size).toBe(1);
});

test("fencing an execution that never reached an executor is a no-op, not a lost session", async () => {
  let called = false;
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl", executor_function_identity: "v1", fetch: async () => { called = true; return new Response(null, { status: 204 }); } });
  await adapter.cancel_or_fence("execution-1" as ExecutionId, { kind: "none" });
  expect(called).toBe(false);
});

test("an operation handed a reference for another executor fails loudly rather than silently", async () => {
  const adapter = new KbblExecutorAdapter({ base_url: "http://kbbl", executor_function_identity: "v1", fetch: async () => new Response(null, { status: 204 }) });
  await expect(adapter.cancel_or_fence("execution-1" as ExecutionId, { kind: "headless_run", run_ref: "elsewhere" }))
    .rejects.toThrow("has no kbbl session reference");
});

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const pendingSince = (lastActivityTs: string) =>
  Response.json({ pending: true, session: { sid: "session-1", status: "live", lastActivityTs } }, { status: 202 });

const silenceAdapter = (body: () => Response, maxSilentMs: number) => new KbblExecutorAdapter({
  base_url: "http://kbbl", executor_function_identity: "v1", max_silent_ms: maxSilentMs, now: () => NOW, fetch: async () => body(),
});
const observe = (adapter: KbblExecutorAdapter) =>
  adapter.observe_terminal("execution-1" as ExecutionId, { kind: "kbbl_session", session_id: "session-1" });

test("silent duration is measured from the activity kbbl last reported", () => {
  expect(silentDurationMs({ session: { lastActivityTs: "2026-08-19T11:59:00.000Z" } }, NOW)).toBe(60_000);
});

test("silent duration is unknown, not zero, when kbbl reports no activity", () => {
  // Distinct from a session that has genuinely been silent for 0ms: an older
  // kbbl omits the field, and reading that as "silent forever" would fail every
  // one of its sessions on the first poll.
  expect(silentDurationMs({ pending: true }, NOW)).toBeNull();
  expect(silentDurationMs({ session: { lastActivityTs: "not a date" } }, NOW)).toBeNull();
});

test("a session still doing work keeps being polled", async () => {
  const attempt = await observe(silenceAdapter(() => pendingSince("2026-08-19T11:59:00.000Z"), 5 * 60_000));
  expect(attempt.kind).toBe("pending");
});

test("a session silent past the bound fails instead of being polled forever", async () => {
  // The stall this exists for: kbbl answers "not terminal" truthfully and
  // indefinitely for a session that never took its first turn.
  const attempt = await observe(silenceAdapter(() => pendingSince("2026-08-19T11:00:00.000Z"), 5 * 60_000));
  expect(attempt).toEqual({ kind: "terminal", observation: { kind: "failed", code: "executor_silent_timeout",
    detail: "kbbl session session-1 reported no activity for 3600s (limit 300s)" } });
});

test("a kbbl that reports no activity at all is polled, not failed", async () => {
  const attempt = await observe(silenceAdapter(() => Response.json({ pending: true }, { status: 202 }), 5 * 60_000));
  expect(attempt.kind).toBe("pending");
});
