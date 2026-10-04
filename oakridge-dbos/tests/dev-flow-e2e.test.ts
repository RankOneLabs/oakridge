/** Ported v15 acceptance cases. Every worker runs through real kbbl and PostgreSQL;
 * operator decisions use the production versioned cohort-request HTTP handler. */
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createImplementationCohortHarness } from "./support/implementation-cohort-harness";
import type { AgentPublication } from "./support/implementation-agent";
import type { BuildReviewTarget, V15OperatorRequest } from "../src/domain/dev-flow-v15";
import type { CohortId, JsonValue } from "../src/domain/primitives";
import { PostgresRunRecordWriter } from "../src/storage/postgres-run-record";
import { loadRunSnapshot } from "../src/storage/load-run-snapshot";

type Harness = Awaited<ReturnType<typeof createImplementationCohortHarness>>;
const pr = { pr_url: "https://github.com/example/oakridge/pull/1", repository_key: "oakridge",
  branch: "cohort/core", base_branch: "epic/schema", summary: "acceptance" };
const publications: readonly AgentPublication[] = [
  { output_name: "build_result", body: { repository_key: "oakridge", summary: "built", changed_files: [], tests: { passed: 1, failed: 0 }, known_issues: [] } },
  { output_name: "pr_summary", body: pr },
];
const target = async (fixture: Harness): Promise<BuildReviewTarget> => {
  const build = await fixture.build();
  if (!build.build_result || !build.pr_summary || !build.head_sha) throw new Error("build is unready");
  return { outputs: { build_result: build.build_result, pr_summary: build.pr_summary }, head_sha: build.head_sha };
};
const artifactCount = async (fixture: Harness) => (await fixture.sql.query<{ readonly count: number }>(
  "SELECT count(*)::integer AS count FROM oakridge.artifact", []))[0]!.count;
const version = async (fixture: Harness) => Number((await fixture.sql.query<{ readonly version: string }>(
  "SELECT durable_version::text AS version FROM oakridge.cohort WHERE id=$1", [fixture.cohort_id]))[0]!.version);
const request = (fixture: Harness, body: V15OperatorRequest, expected_version: number, id = randomUUID()) =>
  fixture.app.request(`/cohorts/${fixture.cohort_id}/requests`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, expected_version, request: body }) });
const publish = (fixture: Harness, launch: Awaited<ReturnType<Harness["launch"]>>, body: JsonValue, output = "pr_summary") =>
  fixture.app.request(`/work-orders/${launch.attempt_id}/emit/${output}`, { method: "PUT",
    headers: { "content-type": "application/json", "work-order-capability": launch.capability }, body: JSON.stringify(body) });
const buildForReview = async (fixture: Harness) => {
  await fixture.advance();
  const answers = await fixture.execute(0, { kind: "publish", commit_build: true, publications });
  expect(answers.map((answer) => answer.status)).toEqual([201, 201]);
};
const assessForReview = async (fixture: Harness) => {
  await buildForReview(fixture);
  await fixture.advance({ kind: "accept_build", target: await target(fixture) });
  await fixture.execute(1, { kind: "publish", commit_build: false, publications: [{ output_name: "assessment",
    body: { verdict: "fail", findings: [], recommended_next_actions: [] } }] });
};
const awaitMerge = async (fixture: Harness) => {
  await assessForReview(fixture);
  // Acceptance is the operator's decision, including a failing assessment.
  await fixture.advance({ kind: "accept_assessment", target: { assessment: await fixture.assessment(), build: await fixture.accepted() } });
};
const cohortState = async (fixture: Harness) => (await fixture.sql.query<{ readonly state: string }>(
  "SELECT state FROM oakridge.cohort WHERE id=$1", [fixture.cohort_id]))[0]!.state;

for (const field of ["repository_key", "branch", "base_branch", "pr_url"] as const) test(`S2 wrong published ${field} preserves repository authority`, async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await fixture.advance();
    const before = await artifactCount(fixture);
    const response = await publish(fixture, await fixture.launch(0), { ...pr, [field]: field === "pr_url" ? "https://github.com/other/repo/pull/1" : "wrong" });
    expect(response.status).toBe(409);
    expect(await artifactCount(fixture)).toBe(before);
  } finally { await fixture.close(); }
}, 30_000);

for (const field of ["head_branch", "base_branch", "head_sha", "number"] as const) test(`S2 wrong forge ${field} cannot authorize publication`, async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await fixture.advance();
    Object.assign(fixture.forge, { [field]: field === "number" ? 2 : "wrong" });
    const response = await publish(fixture, await fixture.launch(0), pr);
    expect(response.status).toBe(409);
    expect(await fixture.sql.query("SELECT id FROM dev_flow.pull_request_verification", [])).toEqual([]);
  } finally { await fixture.close(); }
}, 30_000);

test("S3 unreadable forge cannot authorize a PR; publication succeeds when it recovers", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await fixture.advance();
    const launch = await fixture.launch(0);
    const before = await artifactCount(fixture);
    fixture.forge.http_status = 503;
    for (let index = 0; index < 2; index++) expect((await publish(fixture, launch, pr)).status).toBe(503);
    expect(await artifactCount(fixture)).toBe(before);
    fixture.forge.http_status = 200;
    expect((await publish(fixture, launch, pr)).status).toBe(201);
  } finally { await fixture.close(); }
}, 30_000);

test("S4 build-review revision receives the exact reviewed outputs and feedback", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await buildForReview(fixture);
    const reviewed = await target(fixture);
    await fixture.advance({ kind: "request_build_changes", feedback: { source: "build_review", target: reviewed, text: "Cover the gap" } });
    const revision = await fixture.launch(1);
    expect(revision.prompt).toContain("Cover the gap");
    expect(revision.prompt).toContain(reviewed.outputs.build_result.id);
    expect((await fixture.execute(1, { kind: "publish", commit_build: true, publications })).map((answer) => answer.status)).toEqual([201, 201]);
    expect((await target(fixture)).outputs.build_result.version).toBe(2);
  } finally { await fixture.close(); }
}, 30_000);

test("S5 assessment feedback revises the builder and requires a fresh assessment", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await assessForReview(fixture);
    const accepted = await fixture.accepted();
    const assessment = await fixture.assessment();
    await fixture.advance({ kind: "request_implementation_changes", feedback: { source: "assessment",
      text: "Revise from assessment", target: { assessment, build: accepted } } });
    expect((await fixture.launch(2)).prompt).toContain("Revise from assessment");
    await fixture.execute(2, { kind: "publish", commit_build: true, publications });
    await fixture.advance({ kind: "accept_build", target: await target(fixture) });
    const fresh = await fixture.accepted();
    expect(fresh.head_sha).not.toBe(accepted.head_sha);
    expect((await fixture.launch(3)).prompt).toContain(fresh.head_sha);
    await fixture.execute(3, { kind: "publish", commit_build: false, publications: [{ output_name: "assessment",
      body: { verdict: "pass", findings: [], recommended_next_actions: [] } }] });
    expect((await fixture.assessment()).version).toBe(2);
  } finally { await fixture.close(); }
}, 30_000);

for (const outcome of ["open", "closed_unmerged", "wrong_head"] as const) test(`S8/S10/S11 ${outcome} does not complete an accepted cohort`, async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await awaitMerge(fixture);
    const accepted = await fixture.accepted();
    fixture.forge.state = outcome === "open" ? "open" : "closed";
    fixture.forge.merged_at = outcome === "wrong_head" ? fixture.now() : null;
    fixture.forge.head_sha = outcome === "wrong_head" ? "wrong" : accepted.head_sha;
    if (outcome === "wrong_head") expect((await fixture.ingress.advance(fixture.cohort_id, null)).ok).toBe(false);
    else await fixture.advance();
    expect(await cohortState(fixture)).toBe("awaiting_merge");
    expect(await fixture.accepted()).toEqual(accepted);
    fixture.forge.state = "closed"; fixture.forge.merged_at = fixture.now(); fixture.forge.head_sha = accepted.head_sha;
    await fixture.advance();
    expect(await cohortState(fixture)).toBe("complete");
  } finally { await fixture.close(); }
}, 30_000);

test("S12 cancellation fences a live execution and refuses later publication", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await fixture.advance();
    const launch = await fixture.launch(0);
    await fixture.advance({ kind: "cancel" });
    expect(await cohortState(fixture)).toBe("cancelled");
    expect((await publish(fixture, launch, publications[0]!.body, "build_result")).status).toBe(409);
    expect((await fixture.sql.query<{ readonly fenced: boolean; readonly stopped: boolean }>(
      `SELECT session.fenced_at IS NOT NULL AS fenced,intent.stop_requested_at IS NOT NULL AS stopped
       FROM oakridge.execution_intent intent JOIN oakridge.session session ON session.id=intent.session_id`, []))[0])
      .toEqual({ fenced: true, stopped: true });
  } finally { await fixture.close(); }
}, 30_000);

test("S15 new content from a reviewed execution is refused without adding a revision", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await buildForReview(fixture);
    const before = await artifactCount(fixture);
    const response = await publish(fixture, await fixture.launch(0), { ...publications[0]!.body as object, summary: "late" }, "build_result");
    expect(response.status).toBe(409);
    expect(await artifactCount(fixture)).toBe(before);
  } finally { await fixture.close(); }
}, 30_000);

test("S16 repeated versioned requests produce one receipt, action occurrence and assessor session", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await buildForReview(fixture);
    const expected = await version(fixture);
    const body: V15OperatorRequest = { kind: "accept_build", target: await target(fixture) };
    const id = randomUUID();
    expect((await request(fixture, body, expected, id)).status).toBe(202);
    expect((await request(fixture, body, expected, id)).status).toBe(202);
    expect((await request(fixture, body, expected)).status).toBe(409);
    await fixture.launch(1);
    expect(fixture.launches).toHaveLength(2);
    expect((await fixture.sql.query<{ readonly count: number }>("SELECT count(*)::integer AS count FROM oakridge.cohort_request_receipt WHERE request_id=$1", [id]))[0]?.count).toBe(1);
    for (let index = 0; index < 3; index++) await fixture.advance();
    expect(fixture.launches).toHaveLength(2);
  } finally { await fixture.close(); }
}, 30_000);

test("S17 failure wins over cancellation, fences unfinished siblings, and retains completed output", async () => {
  const fixture = await createImplementationCohortHarness();
  try {
    await buildForReview(fixture);
    const completed = randomUUID() as CohortId;
    const cancelled = randomUUID() as CohortId;
    const unfinished = randomUUID() as CohortId;
    for (const [id, state] of [[completed, "complete"], [cancelled, "cancelled"], [unfinished, "pending"]] as const) {
      await fixture.sql.query(`INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,status,state,frozen_inputs,ended_at)
        SELECT $1::uuid,run_id,stage_instance_id,$1::text,$2::text::oakridge.core_status,$2::text,frozen_inputs,CASE WHEN $2::text IN ('complete','cancelled','failed') THEN now() ELSE NULL END FROM oakridge.cohort WHERE id=$3`,
        [id, state, fixture.cohort_id]);
      await fixture.sql.query("INSERT INTO oakridge.cohort_worker (cohort_id,worker) VALUES ($1,'build'),($1,'assessment')", [id]);
    }
    await fixture.advanceCohort(unfinished);
    const sibling = await fixture.launch(1);
    // Completed sibling output is independently owned; it cannot share the
    // still-unreviewed current artifact of another cohort.
    await fixture.sql.transaction(async (tx) => {
      const outputs = await tx.query<{ readonly worker: string; readonly output_name: string; readonly artifact_type: string; readonly body: JsonValue }>(
        `SELECT output.worker,output.output_name,artifact.artifact_type,artifact.body FROM oakridge.worker_output output
         JOIN oakridge.artifact artifact ON artifact.id=output.artifact_id WHERE output.cohort_id=$1`, [fixture.cohort_id]);
      for (const output of outputs) {
        const artifact_id = randomUUID();
        await tx.query(`INSERT INTO oakridge.artifact (id,chain_id,revision,artifact_type,body,acceptance_state)
          VALUES ($1,$1,1,$2,$3::jsonb,'accepted')`, [artifact_id, output.artifact_type, JSON.stringify(output.body)]);
        await tx.query("INSERT INTO oakridge.artifact_owner (artifact_id,run_id,stage_instance_id,cohort_id) VALUES ($1,$2,$3,$4)",
          [artifact_id, fixture.run_id, fixture.stage_id, completed]);
        await tx.query(`INSERT INTO oakridge.worker_output (cohort_id,worker,output_name,artifact_id,acceptance_state,reviewed_target)
          VALUES ($1,$2,$3,$4,'accepted','{}'::jsonb)`, [completed, output.worker, output.output_name, artifact_id]);
      }
    });
    const results = await fixture.sql.query("SELECT artifact_id,acceptance_state FROM oakridge.worker_output WHERE cohort_id=$1 ORDER BY artifact_id", [completed]);
    await fixture.advance({ kind: "abandon", reason: "Cannot finish" });
    const writer = new PostgresRunRecordWriter(fixture.sql);
    for (let index = 0; index < 2; index++) {
      const result = await writer.decide({ load_snapshot: (tx) => loadRunSnapshot(tx, fixture.run_id), launch_reason: "recovery", actor: "test", decided_at: fixture.now() });
      expect(result.ok).toBe(true);
    }
    expect((await fixture.sql.query<{ readonly status: string }>("SELECT status FROM oakridge.stage_instance WHERE id=$1", [fixture.stage_id]))[0]?.status).toBe("failed");
    expect((await fixture.sql.query<{ readonly status: string }>("SELECT status FROM oakridge.workflow_run WHERE id=$1", [fixture.run_id]))[0]?.status).toBe("failed");
    expect((await publish(fixture, sibling, publications[0]!.body, "build_result")).status).toBe(409);
    expect(await fixture.sql.query("SELECT artifact_id,acceptance_state FROM oakridge.worker_output WHERE cohort_id=$1 ORDER BY artifact_id", [completed])).toEqual(results);
    expect((await fixture.sql.query<{ readonly state: string }>("SELECT state FROM oakridge.cohort WHERE id=$1", [unfinished]))[0]?.state).toBe("cancelled");
  } finally { await fixture.close(); }
}, 30_000);
