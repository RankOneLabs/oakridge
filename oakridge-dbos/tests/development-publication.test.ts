import { expect, test } from "bun:test";
import { Hono } from "hono";
import { controlTokenMiddleware } from "../src/http/control-auth";
import { installDefinitionApi } from "../src/http/app";
import { createHash } from "node:crypto";
import { withDatabase, unit } from "./effect-fixture";
import { developmentBundle, runtimeFixture, throughAnalysis, repository, brief, revision, build_body, pr_body, launch } from "./development-runtime-fixture";
import { HTTP_ROUTES } from "../src/http/routes";
import type { PublicationRequest, PublicationReceipt } from "../src/http/publication";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import type { CommitRequest } from "../src/storage/commit";
import { validateStorageAuthority } from "../src/storage/storage-validator";
import type { ScopeId } from "../src/storage/schema-records";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { readSnapshot } from "../src/storage/snapshot-reader";

async function operatorEdit(f: Awaited<ReturnType<typeof runtimeFixture>>, db: TransactionalSqlExecutor, scope_id: ScopeId,
  output_key: string, collection_key: string, schema: string, body: unknown, predecessor_id?: string): Promise<Response> {
  const slots = await db.query<{ current_revision_id: string | null; version: string | number }>(
    "SELECT current_revision_id,version FROM authority.output_slot WHERE scope_id=$1 AND output_key=$2 AND collection_key=$3", [scope_id, output_key, collection_key]);
  const request_id = crypto.randomUUID();
  return f.app.request(`/api/runs/${f.run_id}/scopes/${scope_id}/publications`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      request_id, expected_scope_version: Number((await f.scope(scope_id)).version),
      trigger: { id: request_id, key: "operator_edit", payload: await f.checked("unit", {}) },
      output: { scope_id, output_key, collection_key, execution_id: null,
        predecessor_id: predecessor_id ?? slots[0]?.current_revision_id ?? null,
        expected_slot_version: slots[0] ? Number(slots[0].version) : null, body: await f.checked(schema, body) },
    }),
  });
}

test("shipped plan and one planned brief accept operator revisions only after review work finishes", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle("development"), launch);
  try {
    const planning = await throughAnalysis(f, db);
    const plan = { summary: "Plan", cohorts: [{ id: brief.cohort_id, repository_key: brief.repository_key, title: brief.title,
      scope: brief.goal, depends_on: brief.depends_on, description: null, files_in_scope: brief.files_in_scope,
      decisions: [], acceptance_criteria: brief.acceptance_criteria }], dependency_order: [brief.cohort_id],
      scope: { in_scope: [], out_of_scope: [] }, acceptance_criteria: [], risks: [] };
    expect((await f.publish("plan", plan, "author", planning)).status).toBe(201);
    expect((await operatorEdit(f, db, planning, "plan", "", "plan_body", { ...plan, summary: "Reviewed plan" })).status).toBe(422);
    await db.query("UPDATE authority.execution SET status='terminal' WHERE scope_id=$1 AND status='pending'", [planning]);
    const edited_plan = await operatorEdit(f, db, planning, "plan", "", "plan_body", { ...plan, summary: "Reviewed plan" });
    expect(edited_plan.status).toBe(202);
    const plan_revision = (await edited_plan.json()).revision_id;
    expect((await f.command("accept", { revision: revision(plan_revision) }, planning)).status).toBe(202);
    await f.advance(); await f.advance();
    const briefs = await db.query<{ id: ScopeId }>("SELECT id FROM authority.scope_instance WHERE parent_id=$1 AND child_key='briefs'", [f.root_scope_id]);
    const writing = briefs[0]?.id;
    if (!writing) throw new Error("brief writing scope missing");
    expect((await f.publish("briefs", brief, "author", writing, brief.cohort_id)).status).toBe(201);
    await db.query("UPDATE authority.execution SET status='terminal' WHERE scope_id=$1 AND status='pending'", [writing]);
    const before = await db.query("SELECT id FROM authority.operator_event WHERE scope_id=$1", [writing]);
    const invalid_member = await operatorEdit(f, db, writing, "briefs", "unknown", "brief_body", { ...brief, cohort_id: "unknown" });
    expect(invalid_member.status).toBe(422);
    expect(await db.query("SELECT id FROM authority.artifact_revision WHERE scope_id=$1 AND collection_key='unknown'", [writing])).toEqual([]);
    expect(await db.query("SELECT id FROM authority.operator_event WHERE scope_id=$1", [writing])).toEqual(before);
    const edited_brief = await operatorEdit(f, db, writing, "briefs", brief.cohort_id, "brief_body", { ...brief, title: "Reviewed brief" });
    expect(edited_brief.status).toBe(202);
    const event_rows = await db.query("SELECT id FROM authority.operator_event WHERE scope_id=$1", [writing]);
    expect((await f.command("operator_edit", {}, writing)).status).toBe(422);
    expect(await db.query("SELECT id FROM authority.operator_event WHERE scope_id=$1", [writing])).toEqual(event_rows);
    const slot = await db.query<{ current_revision_id: string }>(
      "SELECT current_revision_id FROM authority.output_slot WHERE scope_id=$1 AND output_key='briefs' AND collection_key=$2", [writing, brief.cohort_id]);
    expect(slot[0]?.current_revision_id).toBe((await edited_brief.json()).revision_id);
  } finally { f.core.close(); }
}));

test("shipped build result accepts an operator revision in review after selected executions finish", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    await f.fact("begin");
    expect((await operatorEdit(f, db, f.root_scope_id, "build_result", "", "build_body", build_body)).status).toBe(422);
    expect((await f.publish("build_result", build_body)).status).toBe(201);
    expect((await f.publish("pr_summary", pr_body)).status).toBe(201);
    const view = await f.app.request(`/api/runs/${f.run_id}/scopes/${f.root_scope_id}`);
    expect(((await view.json()) as { commands: { key: string }[] }).commands.map((command) => command.key)).not.toContain("operator_edit");
    expect((await operatorEdit(f, db, f.root_scope_id, "build_result", "", "build_body", { ...build_body, summary: "Reviewed build" })).status).toBe(422);
    await db.query("UPDATE authority.execution SET status='terminal' WHERE scope_id=$1 AND status='pending'", [f.root_scope_id]);
    expect((await operatorEdit(f, db, f.root_scope_id, "wrong_slot", "", "build_body", build_body)).status).toBe(422);
    expect((await operatorEdit(f, db, f.root_scope_id, "build_result", "", "unit", {})).status).toBe(422);
    const edited = await operatorEdit(f, db, f.root_scope_id, "build_result", "", "build_body", { ...build_body, summary: "Reviewed build" });
    expect(edited.status).toBe(202);
    expect((await operatorEdit(f, db, f.root_scope_id, "build_result", "", "build_body", build_body, "reviewed-elsewhere")).status).toBe(409);
  } finally { f.core.close(); }
}));

test("publication trigger mismatches are typed HTTP rejections and storage rejects missing declarations", async () => withDatabase(async ({ db }) => {
  const bundle = await developmentBundle();
  const f = await runtimeFixture(db, bundle, { brief, repository });
  try {
    await f.fact("begin");
    const execution_id = await f.selected("build");
    const owner = await f.scope();
    const publication: PublicationRequest = { request_id: "wrong-trigger", expected_scope_version: Number(owner.version),
      trigger: { id: "wrong-trigger", key: "assessment_submitted", payload: await f.checked("unit", {}) },
      output: { scope_id: f.root_scope_id, output_key: "build_result", collection_key: "", execution_id,
        predecessor_id: null, expected_slot_version: null, body: await f.checked("build_body", build_body) } };
    const response = await f.app.request(`/api/runs/${f.run_id}/scopes/${f.root_scope_id}/publications`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(publication) });
    expect({ status: response.status, body: await response.json() }).toMatchObject({ status: 422,
      body: { error: "invalid_payload", detail: "output does not match pinned definition" } });
    const missing_scope = await f.app.request(`/api/runs/another-run/scopes/${f.root_scope_id}/publications`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(publication) });
    expect({ status: missing_scope.status, body: await missing_scope.json() }).toMatchObject({ status: 404,
      body: { error: "missing_entity", detail: "scope not found in run" } });
    const source = await readSnapshot(db, f.root_scope_id, publication.trigger);
    if (!source) throw new Error("snapshot missing");
    const request: CommitRequest = { identity: { run_id: f.run_id, scope_id: f.root_scope_id, ingress_id: publication.request_id, request_digest: "mismatch" },
      read_set: source.read_set, operator_version: null,
      decision: { kind: "wait" as const, reason: "test", continuations: [], explanation: { bundle_digest: "test", node_id: "test",
        owner: f.root_scope_id, read_set: [], trace: [], trigger_id: publication.request_id } },
      outputs: [publication.output], capacity: [], effects: [] };
    expect(await validateStorageAuthority(db, request, source, bundle)).toMatchObject({ ok: false,
      error: { operation: "validate_storage", detail: "publication trigger does not match output declaration" } });
    const missing: DefinitionBundle = { ...bundle, scopes: bundle.scopes.map((scope) => ({ ...scope,
      outputs: scope.outputs.map((output) => ({ ...output, publication_trigger: null })) })) };
    expect(await validateStorageAuthority(db, request, source, missing)).toMatchObject({ ok: false,
      error: { operation: "validate_storage", detail: "publication trigger does not match output declaration" } });
    expect(await db.query("SELECT id FROM authority.artifact_revision WHERE scope_id=$1", [f.root_scope_id])).toEqual([]);
  } finally { f.core.close(); }
}));

test("operator edits publish validated revisions atomically and stale concurrent edits leave one complete outbox event", async () => withDatabase(async ({ db }) => {
  const original = await developmentBundle();
  const bundle: DefinitionBundle = { ...original, scopes: original.scopes.map((scope) => ({ ...scope,
    outputs: scope.outputs.map((output) => output.key === "build_result" ? { ...output, operator_edit_trigger: "begin" } : output) })) };
  for (const request_ids of [["edit-first", "edit-second"], ["edit-second", "edit-first"]]) {
    const f = await runtimeFixture(db, bundle, { brief, repository });
    try {
      const owner = await f.scope();
      const send = async (request_id: string) => f.app.request(`/api/runs/${f.run_id}/scopes/${f.root_scope_id}/publications`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          request_id, expected_scope_version: Number(owner.version),
          trigger: { id: request_id, key: "begin", payload: await f.checked("unit", {}) },
          output: { scope_id: f.root_scope_id, output_key: "build_result", collection_key: "", execution_id: null,
            predecessor_id: null, expected_slot_version: null, body: await f.checked("build_body", build_body) },
        }),
      });
      const responses = await Promise.all(request_ids.map(send));
      expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
      expect((await db.query("SELECT id FROM authority.artifact_revision WHERE scope_id=$1 AND output_key='build_result'", [f.root_scope_id])).length).toBe(1);
      const frames = await db.query<{ payload: { kind: string; run_id?: string; scope_id?: string; event?: { scope_key: string } } }>(
        "SELECT payload FROM authority.operator_event WHERE scope_id=$1 ORDER BY id", [f.root_scope_id]);
      expect(frames.map((frame) => frame.payload.kind).sort()).toEqual(["invalidate", "run_event"]);
      expect(frames.find((frame) => frame.payload.kind === "run_event")?.payload.event?.scope_key).toBe("implementation");
      await db.query("DELETE FROM authority.transition WHERE scope_id=$1", [f.root_scope_id]);
      expect(await db.query("SELECT payload FROM authority.operator_event WHERE scope_id=$1 ORDER BY id", [f.root_scope_id])).toEqual(frames);
    } finally { f.core.close(); }
  }
}));

test("operator edit schema and reviewed predecessor rejections leave no revision or outbox rows", async () => withDatabase(async ({ db }) => {
  const original = await developmentBundle();
  const bundle: DefinitionBundle = { ...original, scopes: original.scopes.map((scope) => ({ ...scope,
    outputs: scope.outputs.map((output) => output.key === "build_result" ? { ...output, operator_edit_trigger: "begin" } : output) })) };
  const f = await runtimeFixture(db, bundle, { brief, repository });
  try {
    const owner = await f.scope();
    const request = (request_id: string, body: unknown, predecessor_id: string | null = null) => ({
      request_id, expected_scope_version: Number(owner.version),
      trigger: { id: request_id, key: "begin", payload: unit },
      output: { scope_id: f.root_scope_id, output_key: "build_result", collection_key: "", execution_id: null,
        predecessor_id, expected_slot_version: null, body },
    });
    const wrong_schema = await f.app.request(`/api/runs/${f.run_id}/scopes/${f.root_scope_id}/publications`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request("wrong-schema", await f.checked("unit", {}))),
    });
    expect(wrong_schema.status).toBe(422);
    const stale = await f.app.request(`/api/runs/${f.run_id}/scopes/${f.root_scope_id}/publications`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request("wrong-predecessor", await f.checked("build_body", build_body), "reviewed-elsewhere")),
    });
    expect(stale.status).toBe(409);
    expect(await db.query("SELECT id FROM authority.artifact_revision WHERE scope_id=$1", [f.root_scope_id])).toEqual([]);
    expect(await db.query("SELECT id FROM authority.operator_event WHERE scope_id=$1", [f.root_scope_id])).toEqual([]);
  } finally { f.core.close(); }
}));

test("the core rejects a published output whose checked body does not match its declared schema", async () => withDatabase(async ({ db }) => {
  const bundle = await developmentBundle();
  const f = await runtimeFixture(db, bundle, { brief, repository });
  try {
    await f.fact("begin");
    const execution_id = await f.selected("build");
    const forged = { schema: "build_body", data: { kind: "integer" as const, value: 1 } };
    const decided = await f.mutations.decide({ run_id: f.run_id, scope_id: f.root_scope_id, ingress_id: "forged-output", operator_version: null,
      trigger: { id: "forged-output", key: "build_submitted", payload: await f.checked("unit", {}) },
      outputs: [{ scope_id: f.root_scope_id, output_key: "build_result", collection_key: "", execution_id,
        predecessor_id: null, expected_slot_version: null, body: forged }] });
    expect(decided).toMatchObject({ ok: true, value: { kind: "Rejected", detail: "output schema mismatch" } });
    expect(await db.query("SELECT id FROM authority.artifact_revision WHERE scope_id=$1", [f.root_scope_id])).toEqual([]);
  } finally { f.core.close(); }
}));

const publication_routes = HTTP_ROUTES.filter((route) => route.path.endsWith("/publications")
  || route.path.endsWith("/outputs/:output_key") || route.path.endsWith("/facts/:fact_key"));
for (const route of publication_routes) {
  test(`${route.method} ${route.path} returns the shared receipt on acceptance and replay`, async () => withDatabase(async ({ db }) => {
    const original = await developmentBundle();
    const bundle: DefinitionBundle = { ...original, scopes: original.scopes.map((scope) => ({ ...scope,
      workers: scope.workers.map((worker) => ({ ...worker, actions: worker.actions.map((action) => ({ ...action,
        settings: worker.key === "build" ? [...action.settings.filter((setting) => setting.key !== "evidence_fact"), { key: "evidence_fact", value: "build_submitted" }] : action.settings })) })) })) };
    const f = await runtimeFixture(db, bundle, { brief, repository });
    try {
      await f.fact("begin");
      const execution_id = await f.selected("build");
      const is_operator = route.authority === "operator";
      const is_evidence = route.path.endsWith("/facts/:fact_key");
      const app = new Hono();
      app.use("*", controlTokenMiddleware("operator-only"));
      installDefinitionApi(app, { db, core: f.core, mutations: f.mutations, wake: async () => {} });
      const path = route.path.replace(":run_id", f.run_id).replace(":scope_id", f.root_scope_id)
        .replace(":execution_id", execution_id).replace(":output_key", "build_result").replace(":fact_key", "build_submitted");
      const body = is_operator ? { request_id: "receipt", expected_scope_version: Number((await f.scope()).version),
        trigger: { id: "receipt", key: "build_submitted", payload: await f.checked("unit", {}) },
        output: { scope_id: f.root_scope_id, output_key: "build_result", collection_key: "", execution_id,
          predecessor_id: null, expected_slot_version: null, body: await f.checked("build_body", build_body) } }
        : is_evidence ? { request_id: "receipt", payload: {} }
        : { request_id: "receipt", predecessor_id: null, collection_key: "", body: build_body };
      const token = is_operator ? "operator-only" : await f.publicationSecret(execution_id);
      const publish = () => app.request(path, { method: route.method,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const accepted = await publish();
      expect(accepted.status).toBe(is_operator || is_evidence ? 202 : 201);
      const receipt: PublicationReceipt = await accepted.json();
      expect(Object.keys(receipt).sort()).toEqual(["kind", "request_id", "revision_id", "scope_version", "transition_id"]);
      expect(receipt).toMatchObject({ kind: "accepted_pending", request_id: "receipt", scope_version: expect.any(Number), transition_id: expect.any(String),
        revision_id: is_evidence ? null : expect.any(String) });
      const replay = await publish();
      expect(replay.status).toBe(is_operator || is_evidence ? 202 : 200);
      expect(await replay.json()).toEqual(receipt);
    } finally { f.core.close(); }
  }));
}

async function acceptedBuild(f: Awaited<ReturnType<typeof runtimeFixture>>) {
  await f.fact("begin");
  const build = await f.publish("build_result", build_body);
  if (build.status !== 201) throw new Error(await build.text());
  const build_revision = (await build.json()).revision_id;
  const pr = await f.publish("pr_summary", pr_body);
  if (pr.status !== 201) throw new Error(await pr.text());
  const pr_revision = (await pr.json()).revision_id;
  await f.observe();
  return { build_result: revision(build_revision), pr_summary: revision(pr_revision), pr_url: pr_body.pr_url, head_sha: "head1" };
}

test("partial publication retry retains the named revision and fences the old build", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    await f.fact("begin");
    const old = await f.selected("build");
    const build = await f.publish("build_result", build_body);
    expect(build.status).toBe(201);
    const retained_revision = (await build.json()).revision_id;
    expect((await f.command("retry_build", { build_result: revision("unrelated"), pr_summary: null })).status).toBe(422);
    expect((await f.command("retry_build", { build_result: { brand: "artifact_revision", id: retained_revision }, pr_summary: null })).status).toBe(202);
    expect((await f.publish("pr_summary", pr_body, "build", f.root_scope_id, "", old)).status).toBe(403);
    expect((await f.publish("build_result", build_body)).status).toBe(422);
    expect((await f.publish("pr_summary", pr_body)).status).toBe(201);
    const pointers = await db.query<{ current_revision_id: string }>("SELECT current_revision_id FROM authority.output_slot WHERE scope_id=$1 AND output_key='build_result'", [f.root_scope_id]);
    expect(pointers[0]?.current_revision_id).toBe(retained_revision);
    expect((await f.scope()).local_state.data).toMatchObject({ kind: "variant", variant: "review" });
  } finally { f.core.close(); }
}));

test("operator accepts a fail verdict only against the accepted build and current PR head", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    const target = await acceptedBuild(f);
    expect((await f.command("accept_build", { ...target, head_sha: "stale" })).status).toBe(422);
    const build_execution = await f.selected("build");
    expect((await f.command("accept_build", target)).status).toBe(202);
    expect((await f.publish("build_result", build_body, "build", f.root_scope_id, "", build_execution)).status).toBe(403);
    const assessment = await f.publish("assessment", { verdict: "fail", findings: [], test_evidence: null, recommended_next_actions: ["Review"] }, "assessment");
    if (assessment.status !== 201) throw new Error(await assessment.text());
    const assessment_target = { ...target, assessment: revision((await assessment.json()).revision_id) };
    expect((await f.command("accept_assessment", { ...assessment_target, assessment: revision("unrelated") })).status).toBe(422);
    expect((await f.command("accept_assessment", assessment_target)).status).toBe(202);
    await f.observe("merged", "head2");
    expect((await f.command("confirm_merged")).status).toBe(422);
    await f.observe("merged", "head1");
    expect((await f.command("confirm_merged")).status).toBe(202);
    expect((await f.scope()).is_terminal).toBe(true);
  } finally { f.core.close(); }
}));

test("discussion can retain an assessment with explicit unchanged evidence or publish a new revision", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    const target = await acceptedBuild(f);
    expect((await f.command("accept_build", target)).status).toBe(202);
    const result = await f.publish("assessment", { verdict: "pass", findings: [], test_evidence: null, recommended_next_actions: [] }, "assessment");
    if (result.status !== 201) throw new Error(await result.text());
    const first = (await result.json()).revision_id;
    const assessment_target = { ...target, assessment: revision(first) };
    expect((await f.command("discuss_assessment", { ...assessment_target, text: "Explain test coverage" })).status).toBe(202);
    const execution = await f.selected("assessment");
    const response = await f.app.request(`http://localhost/api/runs/${f.run_id}/scopes/${f.root_scope_id}/executions/${execution}/facts/assessment_unchanged`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${await f.publicationSecret(execution)}` }, body: JSON.stringify({ request_id: "unchanged", payload: { ...assessment_target, explanation: "Coverage is complete" } }) });
    if (response.status !== 202) throw new Error(await response.text());
    expect((await f.scope()).local_state.data).toMatchObject({ kind: "variant", variant: "assessment_review" });
    expect((await f.command("discuss_assessment", { ...assessment_target, text: "Revise findings" })).status).toBe(202);
    const revised = await f.publish("assessment", { verdict: "pass_with_notes", findings: [], test_evidence: null, recommended_next_actions: ["Note coverage"] }, "assessment");
    if (revised.status !== 201) throw new Error(await revised.text());
    const revised_id = (await revised.json()).revision_id;
    expect(revised_id).not.toBe(first);
    expect((await f.command("accept_assessment", assessment_target)).status).toBe(422);
    const assessor = await f.selected("assessment");
    expect((await f.command("request_implementation_changes", { ...assessment_target, assessment: revision(revised_id), text: "Implement the requested coverage changes" })).status).toBe(202);
    expect((await f.scope()).local_state.data).toMatchObject({ variant: "working" });
    const builder = await f.selected("build");
    const evidence = (key: string) => f.app.request(`http://localhost/api/runs/${f.run_id}/scopes/${f.root_scope_id}/executions/${builder}/facts/${key}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${builder_secret}` },
      body: JSON.stringify({ request_id: `revision-${key}`, payload: {} }) });
    const builder_secret = await f.publicationSecret(builder);
    expect((await evidence("assessment_submitted")).status).toBe(422);
    expect((await evidence("build_submitted")).status).toBe(202);

    const pointers = await db.query<{ current_revision_id: string | null }>("SELECT current_revision_id FROM authority.output_slot WHERE scope_id=$1", [f.root_scope_id]);
    expect(pointers.every((pointer) => pointer.current_revision_id === null)).toBe(true);
    expect((await f.publish("assessment", { verdict: "pass", findings: [], test_evidence: null, recommended_next_actions: [] }, "assessment", f.root_scope_id, "", assessor)).status).toBe(403);
  } finally { f.core.close(); }
}));

test("revocation refuses the pinned publication secret", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    await f.fact("begin");
    const execution = await f.selected("build");
    const endpoint = `http://localhost/api/runs/${f.run_id}/scopes/${f.root_scope_id}/executions/${execution}/outputs/build_result`;
    const payload = { request_id: "stable-publication", predecessor_id: null, collection_key: "", body: build_body };
    const secret = await f.publicationSecret(execution);
    const stored = (await db.query<{ publication_secret_hash: string }>("SELECT publication_secret_hash FROM authority.execution WHERE id=$1", [execution]))[0];
    expect(stored?.publication_secret_hash).toBe(createHash("sha256").update(secret).digest("hex"));
    const publish = (body: typeof payload) => f.app.request(endpoint, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
    const first = await publish(payload);
    expect(first.status).toBe(201);
    const first_revision = (await first.json()).revision_id;
    expect((await f.command("retry_build", { build_result: revision(first_revision), pr_summary: null })).status).toBe(202);
    expect((await publish(payload)).status).toBe(403);
    expect((await publish({ ...payload, body: { ...build_body, summary: "Changed" } })).status).toBe(403);
    const rows = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.artifact_revision WHERE scope_id=$1", [f.root_scope_id]);
    expect(rows[0]?.count).toBe("1");
  } finally { f.core.close(); }
}));

test("agent secret publishes while the same scope read requires operator authority", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    await f.fact("begin");
    const execution = await f.selected("build");
    const secret = await f.publicationSecret(execution);
    const stored = (await db.query<{ publication_secret_hash: string }>("SELECT publication_secret_hash FROM authority.execution WHERE id=$1", [execution]))[0];
    const app = new Hono();
    app.use("*", controlTokenMiddleware("operator-only"));
    installDefinitionApi(app, { db, core: f.core, mutations: f.mutations, wake: async () => {} });
    const scope_path = `/api/runs/${f.run_id}/scopes/${f.root_scope_id}`;
    expect((await app.request(scope_path)).status).toBe(401);
    expect((await app.request(scope_path, { headers: { authorization: "Bearer operator-only" } })).status).toBe(200);
    const diagnostics = await app.request(`${scope_path}/diagnostics`, { headers: { authorization: "Bearer operator-only" } });
    const diagnostics_text = await diagnostics.text();
    expect(diagnostics_text).not.toContain("publication_secret_hash");
    expect(diagnostics_text).not.toContain(stored!.publication_secret_hash);
    expect(diagnostics_text).not.toContain(secret);
    const contract = await app.request(`${scope_path}/executions/${execution}/contract`, { headers: { authorization: `Bearer ${secret}` } });
    expect(contract.status).toBe(200);
    expect((await contract.json()).remaining_frame_bytes).toBeGreaterThan(0);
    const publication = await app.request(`${scope_path}/executions/${execution}/outputs/build_result`, {
      method: "PUT", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ request_id: "agent-only", predecessor_id: null, collection_key: "", body: build_body }),
    });
    expect(publication.status).toBe(201);
    expect((await publication.json()).kind).toBe("accepted_pending");
    expect((await f.command("retry_build", { build_result: revision((await db.query<{ current_revision_id: string }>(
      "SELECT current_revision_id FROM authority.output_slot WHERE scope_id=$1 AND output_key='build_result'", [f.root_scope_id]))[0]!.current_revision_id), pr_summary: null })).status).toBe(202);
    expect((await app.request(`${scope_path}/executions/${execution}/contract`, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(403);
  } finally { f.core.close(); }
}));


test("selected contract budgets ignore historical fact payloads and hide unrelated output slots", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    await f.fact("begin");
    const execution = await f.selected("build");
    const path = `/api/runs/${f.run_id}/scopes/${f.root_scope_id}/executions/${execution}/contract`;
    const headers = { authorization: `Bearer ${await f.publicationSecret(execution)}` };
    const before = await f.app.request(path, { headers });
    const budget = (await before.json()).remaining_frame_bytes;
    expect(budget).toBeGreaterThan(0);
    await db.query("INSERT INTO authority.fact (id,run_id,scope_id,fact_key,payload) VALUES ($1,$2,$3,$4,$5)",
      ["zzzz-large-historical-fact", f.run_id, f.root_scope_id, "historical", { schema: "text", data: { kind: "string", value: "x".repeat(2_000_000) } }]);
    for (const output_key of ["build_result", "assessment"]) {
      await db.query("INSERT INTO authority.output_slot (id,run_id,scope_id,output_key,collection_key) VALUES ($1,$2,$3,$4,$5)",
        [crypto.randomUUID(), f.run_id, f.root_scope_id, output_key, output_key === "assessment" ? "private-member" : ""]);
    }
    const response = await f.app.request(path, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ remaining_frame_bytes: budget,
      outputs: [{ output_key: "build_result", collection_key: "", predecessor_id: null, slot_version: 0 }] });
    const publication = await f.app.request(path.replace(/contract$/, "outputs/build_result"), { method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ request_id: "after-historical-fact", predecessor_id: null, collection_key: "", body: build_body }) });
    expect(publication.status).toBe(201);
  } finally { f.core.close(); }
}));

test("an analysis review is accepted with the evidence the scope projects", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle("development"), launch);
  try {
    await f.fact("begin"); await f.advance();
    const preparations = await db.query<{ id: ScopeId }>("SELECT id FROM authority.scope_instance WHERE parent_id=$1 AND scope_key='repository_preparation'", [f.root_scope_id]);
    for (const preparation of preparations) await f.fact("prepared", { repository_path: "/tmp", head: "head1", push_remote_owner: repository.forge.owner }, preparation.id);
    await f.advance(); await f.advance();
    const analysis = (await db.query<{ id: ScopeId }>("SELECT id FROM authority.scope_instance WHERE parent_id=$1 AND child_key='analysis'", [f.root_scope_id]))[0]!.id;
    const published = await f.publish("analysis", { summary: "Spec", source_spec_refs: [], findings: [], requirements: [], risks: [] }, "author", analysis);
    if (published.status !== 201) throw new Error(await published.text());
    const prefill = await f.prefill("accept", analysis);
    expect(prefill).toEqual({ revision: revision((await published.json()).revision_id) });
    expect((await f.command("accept", prefill, analysis)).status).toBe(202);
  } finally { f.core.close(); }
}));

test("build and assessment reviews are accepted with the evidence the scope projects", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  try {
    const target = await acceptedBuild(f);
    expect(await f.prefill("accept_build")).toEqual(target);
    expect((await f.command("accept_build", await f.prefill("accept_build"))).status).toBe(202);
    const assessment = await f.publish("assessment", { verdict: "pass", findings: [], test_evidence: null, recommended_next_actions: [] }, "assessment");
    if (assessment.status !== 201) throw new Error(await assessment.text());
    expect(await f.prefill("accept_assessment")).toEqual({ ...target, assessment: revision((await assessment.json()).revision_id) });
    expect((await f.command("discuss_assessment", { ...await f.prefill("discuss_assessment"), text: "Explain coverage" })).status).toBe(202);
  } finally { f.core.close(); }
}));
