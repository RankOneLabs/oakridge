import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createImplementationCohortHarness, waitFor } from "./support/implementation-cohort-harness";
import type { AgentPublication } from "./support/implementation-agent";
import type { BuildReviewTarget } from "../src/domain/dev-flow-v15";
import type { JsonValue, SessionId } from "../src/domain/primitives";
import { requestExecutionStop } from "../src/storage/postgres-run-record";
import { createOakridgeRuntime } from "../src/runtime/compose";
import { BunGitCommandRunner } from "../src/runtime/git-command-runner";
import { prepareCohortRepositoryRecord } from "../src/runtime/cohort-pull-request";
import { PostgresDevFlowPullRequestRepository } from "../src/storage/postgres-dev-flow";
import type { ImplementationCohortInputs } from "../src/domain/dev-flow-v15";

type Harness = Awaited<ReturnType<typeof createImplementationCohortHarness>>;
const prBody = { pr_url: "https://github.com/example/oakridge/pull/1", repository_key: "oakridge",
  branch: "cohort/core", base_branch: "epic/schema", summary: "boundary proof" };
const buildPublications: readonly AgentPublication[] = [
  { output_name: "pr_summary", body: prBody },
  { output_name: "build_result", body: { repository_key: "oakridge", summary: "current implementation", changed_files: [],
    tests: { passed: 1, failed: 0 }, known_issues: [] } },
];
const assessmentBody = { verdict: "fail", findings: [{ criterion: "missing check", status: "not_met", evidence: "check absent" }],
  recommended_next_actions: ["add check"] };
const buildTarget = async (fixture: Harness): Promise<BuildReviewTarget> => {
  const current = await fixture.build();
  if (!current.build_result || !current.pr_summary || !current.head_sha) throw new Error("build is not ready");
  return { outputs: { build_result: current.build_result, pr_summary: current.pr_summary }, head_sha: current.head_sha };
};
const writeCounts = async (fixture: Harness) => (await fixture.sql.query<{ readonly artifacts: string; readonly observations: string; readonly bindings: string }>(
  `SELECT (SELECT count(*)::text FROM oakridge.artifact) AS artifacts,
    (SELECT count(*)::text FROM dev_flow.pull_request_observation) AS observations,
    (SELECT count(*)::text FROM dev_flow.pull_request_verification) AS bindings`, []))[0]!;

test("both workers retry through kbbl after a real agent exits without publishing", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    const observeExit = async (index: number) => {
      const execution = await fixture.execution(index);
      const session = (await fixture.sql.query<{ readonly id: SessionId; readonly kbbl_session_id: string }>(
        `SELECT session.id::text,session.kbbl_session_id FROM oakridge.execution_intent intent
         JOIN oakridge.session session ON session.id=intent.session_id WHERE intent.id=$1`, [execution]))[0]!;
      const terminal = await waitFor("actual kbbl process exit", async () => {
        const observation = await fixture.adapter.observe_terminal(execution, { kind: "kbbl_session", session_id: session.kbbl_session_id });
        return observation.kind === "terminal" ? observation.observation : null;
      });
      expect(terminal.kind).toBe("succeeded");
      if (terminal.kind !== "succeeded") throw new Error(`Unexpected terminal outcome: ${terminal.kind}`);
      const observation = { session_id: session.id,
        health: { kind: "ended_succeeded" as const, metadata: terminal.metadata, observed_at: fixture.now() }, observed_at: fixture.now() };
      if (index === 0) {
        const advance = fixture.ingress.advance_local.bind(fixture.ingress);
        fixture.ingress.advance_local = async () => { throw new Error("crash after terminal commit"); };
        await expect(fixture.records.observe_session(observation)).rejects.toThrow("crash after terminal commit");
        expect((await fixture.sql.query("SELECT status FROM oakridge.session WHERE id=$1", [session.id]))[0])
          .toEqual({ status: "complete" });
        expect((await fixture.sql.query("SELECT state FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker='build'",
          [fixture.cohort_id]))[0]).toEqual({ state: "working" });
        fixture.ingress.advance_local = advance;
        expect(await fixture.records.observe_session(observation)).toMatchObject({ kind: "already_ended" });
        const version = await fixture.sql.query("SELECT durable_version FROM oakridge.cohort WHERE id=$1", [fixture.cohort_id]);
        await fixture.records.observe_session(observation);
        expect(await fixture.sql.query("SELECT durable_version FROM oakridge.cohort WHERE id=$1", [fixture.cohort_id])).toEqual(version);
      } else await fixture.records.observe_session(observation);
    };
    await fixture.advance();
    await fixture.execute(0, { kind: "exit_without_publication" });
    await observeExit(0);
    expect((await fixture.sql.query("SELECT state,response FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker='build'",
      [fixture.cohort_id]))[0]).toEqual({ state: "interrupted", response: null });
    await fixture.advance({ kind: "retry_build" });
    expect((await fixture.launch(1)).prompt).toContain("# Build Agent — Retry After Lost Attempt");
    expect((await fixture.execute(1, { kind: "publish", commit_build: true, publications: buildPublications })).map((delivery) => delivery.status)).toEqual([201, 201]);
    await fixture.advance({ kind: "accept_build", target: await buildTarget(fixture) });
    await fixture.execute(2, { kind: "exit_without_publication" });
    await observeExit(2);
    expect((await fixture.sql.query("SELECT state,response FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker='assessment'",
      [fixture.cohort_id]))[0]).toEqual({ state: "interrupted", response: null });
    await fixture.advance({ kind: "retry_assessment" });
    const retry = await fixture.launch(3);
    expect(retry.prompt).toContain("# Assessor Agent — Retry After Lost Attempt");
    expect(retry.prompt).toContain((await fixture.accepted()).head_sha);
    expect(retry.prompt).not.toContain("{{");
    expect((await fixture.execute(3, { kind: "publish", commit_build: false,
      publications: [{ output_name: "assessment", body: assessmentBody }] })).map((delivery) => delivery.status)).toEqual([201]);
  } finally { await fixture.close(); }
}, 60_000);

test("B3 runs both revision routes, discussion, fresh assessment, PR replacement and merge through kbbl", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await fixture.advance();
    expect((await fixture.execute(0, { kind: "publish", commit_build: true, publications: buildPublications })).map((delivery) => delivery.status)).toEqual([201, 201]);
    await fixture.advance({ kind: "request_build_changes", feedback: { source: "build_review", text: "Add coverage", target: await buildTarget(fixture) } });
    const reviewRevision = await fixture.launch(1);
    expect(reviewRevision.prompt).toContain("# Build revision");
    expect(reviewRevision.prompt).toContain("current implementation");
    expect(reviewRevision.prompt).toContain("Add coverage");
    expect((await fixture.execute(1, { kind: "publish", commit_build: true, publications: buildPublications })).map((delivery) => delivery.status)).toEqual([201, 201]);
    await fixture.advance({ kind: "accept_build", target: await buildTarget(fixture) });
    const accepted = await fixture.accepted();
    expect((await fixture.launch(2)).prompt).toContain(accepted.head_sha);
    expect((await fixture.execute(2, { kind: "publish", commit_build: false,
      publications: [{ output_name: "assessment", body: assessmentBody }] })).map((delivery) => delivery.status)).toEqual([201]);
    const assessment = await fixture.assessment();
    await fixture.advance({ kind: "discuss_assessment", feedback: { text: "Recheck the finding", target: { assessment, build: accepted } } });
    const discussion = await fixture.launch(3);
    expect(discussion.prompt).toContain("Recheck the finding");
    expect(discussion.prompt).toContain("assessment_unchanged");
    expect(discussion.prompt.match(/"summary": "current implementation"/g)).toHaveLength(1);
    const before = await writeCounts(fixture);
    expect((await fixture.execute(3, { kind: "publish", commit_build: false, publications: [{ output_name: "assessment_unchanged",
      body: { assessment, build: accepted, explanation: "The evidence still shows the missing check." } as unknown as JsonValue }] })).map((delivery) => delivery.status)).toEqual([201]);
    expect(await writeCounts(fixture)).toEqual(before);
    expect(await fixture.accepted()).toEqual(accepted);
    await fixture.advance({ kind: "request_implementation_changes", feedback: { source: "assessment", text: "Fix the finding",
      target: { assessment, build: accepted } } });
    const assessmentRevision = await fixture.launch(4);
    expect(assessmentRevision.prompt).toContain("# Build revision");
    expect(assessmentRevision.prompt).toContain("open_findings");
    expect(assessmentRevision.prompt).toContain("missing check");
    expect(assessmentRevision.prompt).toContain("add check");
    expect(assessmentRevision.prompt).toContain("Fix the finding");
    expect(assessmentRevision.prompt.match(/"summary": "current implementation"/g)).toHaveLength(1);
    expect((await fixture.execute(4, { kind: "publish", commit_build: true, publications: buildPublications })).map((delivery) => delivery.status)).toEqual([201, 201]);
    await fixture.advance({ kind: "accept_build", target: await buildTarget(fixture) });
    const freshBuild = await fixture.accepted();
    expect(freshBuild.head_sha).not.toBe(accepted.head_sha);
    expect((await fixture.execute(5, { kind: "publish", commit_build: false, publications: [{ output_name: "assessment",
      body: { verdict: "pass", findings: [], recommended_next_actions: [] } }] })).map((delivery) => delivery.status)).toEqual([201]);
    await fixture.advance({ kind: "accept_assessment", target: { assessment: await fixture.assessment(), build: freshBuild } });
    fixture.forge.state = "closed";
    await fixture.advance({ kind: "replace_pr", target: await buildTarget(fixture) });
    const replacement = await fixture.launch(6);
    expect(replacement.prompt).toContain("# Build Agent — Replacement Pull Request");
    expect(replacement.prompt).not.toContain("{{");
    const beforeReplacement = await writeCounts(fixture);
    for (const candidate of [{ number: 1, state: "closed" }, { number: 1, state: "open" }, { number: 2, state: "closed" }] as const) {
      fixture.forge.number = candidate.number; fixture.forge.state = candidate.state;
      const response = await fixture.app.request(`/work-orders/${replacement.attempt_id}/emit/pr_summary`, {
        method: "PUT", headers: { "content-type": "application/json", "work-order-capability": replacement.capability },
        body: JSON.stringify({ ...prBody, pr_url: `https://github.com/example/oakridge/pull/${candidate.number}` }) });
      expect([response.status, (await response.json() as { code: string }).code]).toEqual([409, "pr_verification_failed"]);
      expect(await writeCounts(fixture)).toEqual(beforeReplacement);
    }
    fixture.forge.number = 2; fixture.forge.state = "open";
    expect((await fixture.execute(6, { kind: "publish", commit_build: true, publications: [
      { output_name: "pr_summary", body: { ...prBody, pr_url: "https://github.com/example/oakridge/pull/2" } },
      buildPublications[1]!,
    ] })).map((delivery) => delivery.status)).toEqual([201, 201]);
    expect((await fixture.sql.query<{ readonly number: number }>(
      `SELECT pr.forge_pull_request_id::integer AS number FROM oakridge.cohort cohort
       JOIN dev_flow.pull_request_verification verification ON verification.id=cohort.current_verified_pull_request_id
       JOIN dev_flow.pull_request pr ON pr.id=verification.pull_request_id WHERE cohort.id=$1`,
      [fixture.cohort_id]))[0]?.number).toBe(2);
    await fixture.advance({ kind: "accept_build", target: await buildTarget(fixture) });
    const replacementBuild = await fixture.accepted();
    expect((await fixture.execute(7, { kind: "publish", commit_build: false, publications: [{ output_name: "assessment",
      body: { verdict: "pass", findings: [], recommended_next_actions: [] } }] })).map((delivery) => delivery.status)).toEqual([201]);
    await fixture.advance({ kind: "accept_assessment", target: { assessment: await fixture.assessment(), build: replacementBuild } });
    fixture.forge.state = "closed"; fixture.forge.merged_at = fixture.now();
    await fixture.advance();
    expect((await fixture.sql.query<{ readonly state: string }>("SELECT state FROM oakridge.cohort WHERE id=$1", [fixture.cohort_id]))[0]?.state).toBe("complete");
    expect(fixture.launches.every((launch) => !launch.prompt.includes("{{"))).toBe(true);
    expect(new Set(fixture.launches.map((launch) => launch.prompt.match(/^Worktree: (.+)$/m)?.[1])).size).toBe(1);
  } finally { await fixture.close(); }
}, 60_000);

test("publish rejects repository, URL, branch, base and forge head mismatches without artifact or PR writes", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await fixture.advance();
    const launch = await fixture.launch(0);
    const publish = (body: JsonValue) => fixture.app.request(`/work-orders/${launch.attempt_id}/emit/pr_summary`, {
      method: "PUT", headers: { "content-type": "application/json", "work-order-capability": launch.capability }, body: JSON.stringify(body) });
    const before = await writeCounts(fixture);
    for (const body of [
      { ...prBody, repository_key: "wrong" }, { ...prBody, pr_url: "https://github.com/wrong/oakridge/pull/1" },
      { ...prBody, branch: "wrong" }, { ...prBody, base_branch: "wrong" },
    ]) {
      const response = await publish(body);
      expect([response.status, (await response.json() as { code: string }).code]).toEqual([409, "pr_verification_failed"]);
      expect(await writeCounts(fixture)).toEqual(before);
    }
    for (const mismatch of ["head_branch", "base_branch", "head_sha", "number"] as const) {
      const prior = fixture.forge[mismatch];
      Object.assign(fixture.forge, { [mismatch]: mismatch === "number" ? 2 : "wrong" });
      const response = await publish(prBody);
      expect([response.status, (await response.json() as { code: string }).code]).toEqual([409, "pr_verification_failed"]);
      expect(await writeCounts(fixture)).toEqual(before);
      Object.assign(fixture.forge, { [mismatch]: prior });
    }
  } finally { await fixture.close(); }
}, 30_000);

test("application composition skips implementation preparation for other stages", async () => {
  const fixture = await createImplementationCohortHarness();
  let runtime: Awaited<ReturnType<typeof createOakridgeRuntime>> | null = null;
  try {
    runtime = await createOakridgeRuntime({ database_url: fixture.database_url, application_version: "b3-stage-guard-test",
      executor_adapters: [], prompt_template_directory: "workflow-config/prompts",
      git_commands: { async run() { throw new Error("other stages must not prepare implementation repositories"); } },
      pull_request_reader: { async read() { throw new Error("other stages must not read a PR"); } } });
    for (const stage_key of ["spec_analysis", "planning", "brief_writing", "final_integration"]) {
      await fixture.sql.query("UPDATE oakridge.stage_instance SET stage_key=$2,stage_contract='{}'::jsonb WHERE id=$1",
        [fixture.stage_id, stage_key]);
      await fixture.sql.query("UPDATE oakridge.cohort SET frozen_inputs=$2::jsonb WHERE id=$1", [fixture.cohort_id,
        JSON.stringify(stage_key === "final_integration" ? { repository: { refs: [] } } : { original: "other stage input" })]);
      const response = await runtime.app.request(`/cohorts/${fixture.cohort_id}/requests`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ id: crypto.randomUUID(), expected_version: 0,
          request: { kind: "retry_build" } }) });
      expect([response.status, (await response.json() as { error: { kind: string } }).error.kind]).toEqual([409, "stage_not_supported"]);
    }
    expect(await fixture.sql.query("SELECT id FROM oakridge.execution_intent", [])).toEqual([]);
  } finally { await runtime?.close(); await fixture.close(); }
}, 30_000);

test("preparation recovers after a push with a new repository instance and its committed PostgreSQL state", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    const frozen = (await fixture.sql.query<{ readonly frozen_inputs: ImplementationCohortInputs }>(
      "SELECT frozen_inputs FROM oakridge.cohort WHERE id=$1", [fixture.cohort_id]))[0]!.frozen_inputs;
    await fixture.sql.query(`UPDATE oakridge.cohort SET repository_head_sha=NULL,
      frozen_inputs=jsonb_set(frozen_inputs,'{repository,canonical_branch}',to_jsonb($2::text)) WHERE id=$1`,
      [fixture.cohort_id, `cohort/${fixture.stage_id}/core`]);
    const git = new BunGitCommandRunner();
    const input = { cohort_id: fixture.cohort_id, stage_instance_id: fixture.stage_id, cohort_key: "core",
      repository: frozen.repository.refs, prepared_at: fixture.now() };
    const crashing = { async run(path: string, args: readonly string[]) {
      const result = await git.run(path, args);
      if (args[0] === "push") {
        expect(result.exit_code).toBe(0);
        throw new Error("process died after origin accepted the push");
      }
      return result;
    } };
    await expect(prepareCohortRepositoryRecord({ git: crashing,
      pull_requests: new PostgresDevFlowPullRequestRepository(fixture.sql) }, input)).rejects.toThrow("process died");
    const recovered = await prepareCohortRepositoryRecord({ git,
      pull_requests: new PostgresDevFlowPullRequestRepository(fixture.sql) }, input);
    expect(recovered).toMatchObject({ ok: true, value: { worktree_base_sha: frozen.repository.worktree_base_sha,
      cohort: { canonical_ref: `cohort/${fixture.stage_id}/core` } } });
    expect((await fixture.sql.query("SELECT count(*)::integer AS count FROM oakridge.cohort WHERE repository_head_sha IS NOT NULL", []))[0]).toEqual({ count: 1 });
    expect(fixture.launches).toEqual([]);
  } finally { await fixture.close(); }
}, 30_000);

test("fencing during forge verification refuses publication and leaves PR bindings and artifacts untouched", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await fixture.advance();
    const launch = await fixture.launch(0);
    const execution = await fixture.execution(0);
    const before = await writeCounts(fixture);
    // Read real forge/origin evidence, then stop before the authorized storage commit.
    const evidence = await fixture.enrich({ attempt_id: launch.attempt_id as never, output_name: "pr_summary", body: prBody });
    expect(evidence.ok).toBe(true);
    expect(await writeCounts(fixture)).toEqual(before);
    await requestExecutionStop(fixture.sql, execution, fixture.now());
    if (!evidence.ok) throw new Error(evidence.error.detail);
    expect(await fixture.records.publish_artifact({ artifact_id: crypto.randomUUID() as never,
      attempt_id: launch.attempt_id as never, capability_hash: createHash("sha256").update(launch.capability).digest("hex"),
      output_name: "pr_summary", collection_key: null, body: prBody, enrichment: evidence.value,
      idempotency_key: "fenced", payload_hash: "fenced", published_at: fixture.now() })).toMatchObject({ kind: "refused", code: "publication_fenced" });
    expect(await writeCounts(fixture)).toEqual(before);
    const response = await fixture.app.request(`/work-orders/${launch.attempt_id}/emit/pr_summary`, {
      method: "PUT", headers: { "content-type": "application/json", "work-order-capability": launch.capability }, body: JSON.stringify(prBody) });
    expect([response.status, (await response.json() as { code: string }).code]).toEqual([409, "publication_fenced"]);
    expect(await writeCounts(fixture)).toEqual(before);
  } finally { await fixture.close(); }
}, 30_000);

test("an unauthorized replacement PR rolls back its artifact and every binding write", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await fixture.advance();
    await fixture.execute(0, { kind: "publish", commit_build: true, publications: buildPublications });
    await fixture.advance({ kind: "request_build_changes", feedback: { source: "build_review", text: "Revise",
      target: await buildTarget(fixture) } });
    const launch = await fixture.launch(1);
    const before = await writeCounts(fixture);
    fixture.forge.number = 2;
    const response = await fixture.app.request(`/work-orders/${launch.attempt_id}/emit/pr_summary`, {
      method: "PUT", headers: { "content-type": "application/json", "work-order-capability": launch.capability },
      body: JSON.stringify({ ...prBody, pr_url: "https://github.com/example/oakridge/pull/2" }) });
    expect([response.status, (await response.json() as { code: string }).code]).toEqual([409, "pr_verification_failed"]);
    expect(await writeCounts(fixture)).toEqual(before);
    expect((await fixture.sql.query<{ readonly lifecycle: string }>(
      "SELECT lifecycle FROM oakridge.artifact WHERE artifact_type='dev.pr_summary'", []))[0]?.lifecycle).toBe("current");
    fixture.forge.number = 1;
    expect((await fixture.execute(1, { kind: "publish", commit_build: true, publications: buildPublications })).map((delivery) => delivery.status)).toEqual([201, 201]);
  } finally { await fixture.close(); }
}, 30_000);

test("cohort activation refuses a missing prepared base without launching kbbl", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await fixture.sql.query("UPDATE oakridge.cohort SET frozen_inputs=jsonb_set(frozen_inputs,'{repository,worktree_base_sha}','null'::jsonb) WHERE id=$1", [fixture.cohort_id]);
    expect(await fixture.ingress.advance(fixture.cohort_id, null)).toMatchObject({ ok: false,
      error: { detail: expect.stringContaining("unavailable input inputs.repository") } });
    expect(await fixture.sql.query("SELECT id FROM oakridge.execution_intent", [])).toEqual([]);
    expect(fixture.launches).toEqual([]);
  } finally { await fixture.close(); }
}, 30_000);
