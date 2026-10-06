import { expect, test } from "bun:test";
import { Hono } from "hono";
import { controlTokenMiddleware } from "../src/http/control-auth";
import { installDefinitionApi } from "../src/http/app";
import { createHash } from "node:crypto";
import { withDatabase } from "./effect-fixture";
import { developmentBundle, runtimeFixture, repository, brief, revision, build_body, pr_body } from "./development-runtime-fixture";

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
    expect(await diagnostics.text()).not.toContain(stored!.publication_secret_hash);
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
