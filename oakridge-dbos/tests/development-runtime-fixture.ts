import { Hono } from "hono";
import { resolve } from "node:path";
import { CoreClient } from "../src/core-client/client";
import type { CheckedValue, DefinitionBundle } from "../src/core-client/generated-contracts";
import { installDefinitionApi } from "../src/http/app";
import type { ScopeView } from "../src/projections/scope-view";
import { createMutationService } from "../src/storage/mutation-service";
import type { ScopeId, ScopeInstanceRecord } from "../src/storage/schema-records";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import { advanceChildren } from "../src/runtime/advance-children";
import { unsealEffectPayload } from "../src/storage/effect-secret";
import type { EffectPayload } from "../src/effects/intents";
export const revision = (id: string) => ({ brand: "artifact_revision", id });
export const session = { runtime: "codex", workdir: "/tmp", session_name: "development" };
export const repository = { key: "repo", preparation: { repository_path: "/tmp", expected_head: null }, build: session, integration: session,
  forge: { owner: "owner", name: "repo", build_base: "cohort", final_base: "main" } };
export interface DevelopmentScope extends ScopeInstanceRecord { readonly id: ScopeId }
export const brief = { cohort_id: "first", repository_key: "repo", title: "Build feature", depends_on: [] as string[], goal: "Feature", files_in_scope: ["src"], decisions_made: [], approaches_rejected: [], acceptance_criteria: ["tests pass"], next_action: "Implement" };
export const build_body = { repository_key: "repo", summary: "Built", changed_files: ["src"], tests: { passed: 1, failed: 0, output: null, summary: null, cargo_test_output: null }, delegated_session_metadata: { cohort_id: "first", session_id: null, branch: "work" }, known_issues: [] };
export const pr_body = { pr_url: "https://github.com/owner/repo/pull/1", branch: "work", summary: "Feature", review_status: null };
export const forge = { provider: "github", owner: "owner", name: "repo", number: 1, url: pr_body.pr_url, head_branch: "work", base_branch: "cohort", head_sha: "head1", state: "open", source: "forge", observed_at: "2026-10-05", merged_at: null };
export const launch = { spec: "Feature", repositories: [repository], analysis: session, planning: session, briefs: session };
export async function developmentBundle(root = "implementation", independent = false): Promise<DefinitionBundle> {
  const source: DefinitionBundle = await Bun.file(resolve(import.meta.dir, `../../workflow-config/definitions/development${independent ? "-independent-siblings" : ""}.json`)).json();
  return { ...source, root, scopes: root === source.root ? source.scopes : source.scopes.filter((scope) => scope.key === root) };
}
export async function runtimeFixture(db: TransactionalSqlExecutor, bundle: DefinitionBundle, input: unknown) {
  const started = CoreClient.start({ binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), deadlineMs: 10_000 });
  if (!started.ok) throw new Error(started.error.detail.detail);
  const core = started.value;
  const mutations = createMutationService(db, core, { check_github: async () => ({ ok: true, value: true }) });
  const scoped_input = bundle.root === "implementation" && input && typeof input === "object" && !Array.isArray(input)
    ? { ...input, push_remote_owner: repository.forge.owner } : input;
  const run = await mutations.startRun({ bundle, input: scoped_input });
  if (!run.ok) { core.close(); throw new Error(JSON.stringify(run.error)); }
  const app = new Hono();
  installDefinitionApi(app, { db, core, mutations, wake: async () => {} });
  const { run_id, root_scope_id } = run.value;
  const checked = async (schema: string, payload: unknown): Promise<CheckedValue> => {
    const response = await core.request("validate_payload", { bundle, schema, payload });
    if (!response.ok || response.value.kind !== "validated") throw new Error(JSON.stringify(response));
    return response.value.value;
  };
  const scope = async (id = root_scope_id): Promise<DevelopmentScope> => {
    const rows = await db.query<DevelopmentScope>("SELECT * FROM authority.scope_instance WHERE id=$1", [id]);
    if (!rows[0]) throw new Error("scope missing");
    return rows[0];
  };
  const fact = async (key: string, payload: unknown = {}, id = root_scope_id) => {
    const owner = await scope(id); const definition = bundle.scopes.find((s) => s.key === owner.scope_key);
    const schema = definition?.facts.find((f) => f.key === key)?.payload_schema ?? definition?.commands.find((c) => c.key === key)?.payload_schema;
    if (!schema) throw new Error(`trigger missing: ${key}`);
    const ingress_id = crypto.randomUUID();
    const result = await mutations.decide({ run_id, scope_id: id, ingress_id, trigger: { id: ingress_id, key, payload: await checked(schema, payload) }, operator_version: null });
    if (!result.ok || result.value.kind !== "Committed") throw new Error(JSON.stringify(result));
  };
  const command = async (key: string, payload: unknown = {}, id = root_scope_id) => {
    const projected = await app.request(`http://localhost/api/runs/${run_id}/scopes/${id}`);
    if (!projected.ok) throw new Error(await projected.text());
    const view: ScopeView = await projected.json();
    const targets = view.command_targets[key] ?? [];
    return app.request(`http://localhost/api/runs/${run_id}/scopes/${id}/commands`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command_key: key, payload, request_id: crypto.randomUUID(), scope_id: id, expected_scope_version: view.cursor.scope_version, targets }) });
  };
  const prefill = async (key: string, id = root_scope_id): Promise<ScopeView["command_prefill"][string] | undefined> => {
    const projected = await app.request(`http://localhost/api/runs/${run_id}/scopes/${id}`);
    if (!projected.ok) throw new Error(await projected.text());
    return ((await projected.json()) as ScopeView).command_prefill[key];
  };
  const selected = async (worker: string, id = root_scope_id): Promise<string> => {
    const rows = await db.query<{ execution_id: string | null }>("SELECT execution_id FROM authority.execution_selection WHERE scope_id=$1 AND worker_key=$2", [id, worker]);
    if (!rows[0]?.execution_id) throw new Error(`worker not selected: ${worker}`);
    return rows[0].execution_id;
  };
  const publicationSecret = async (execution_id: string): Promise<string> => {
    const rows = await db.query<{ payload: EffectPayload }>(
      "SELECT payload FROM authority.effect_intent WHERE execution_id=$1 AND payload->>'action'='start'", [execution_id]);
    const secret = rows[0] ? unsealEffectPayload(rows[0].payload).invocation.bytes.match(/Authorization: Bearer ([A-Za-z0-9_-]+)/)?.[1] : undefined;
    if (!secret) throw new Error("pinned publication secret missing");
    return secret;
  };
  const publish = async (output: string, body: unknown, worker = "build", id = root_scope_id, member = "", execution?: string) => {
    const rows = await db.query<{ current_revision_id: string | null }>("SELECT current_revision_id FROM authority.output_slot WHERE scope_id=$1 AND output_key=$2 AND collection_key=$3", [id, output, member]);
    const chosen = execution ?? await selected(worker, id);
    return app.request(`http://localhost/api/runs/${run_id}/scopes/${id}/executions/${chosen}/outputs/${output}`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${await publicationSecret(chosen)}` },
      body: JSON.stringify({ request_id: crypto.randomUUID(), predecessor_id: rows[0]?.current_revision_id ?? null, collection_key: member, body }) });
  };
  const observe = (state = "open", head_sha = "head1", id = root_scope_id) => fact("pr_observed", { observations: [{ ...forge, state, head_sha }] }, id);
  const advance = () => advanceChildren({ db, core, mutations, run_ids: [run_id] });
  return { app, core, mutations, run_id, root_scope_id, checked, scope, fact, command, prefill, selected, publicationSecret, publish, observe, advance };
}
async function rootChild(f: Awaited<ReturnType<typeof runtimeFixture>>, db: TransactionalSqlExecutor, key: string): Promise<ScopeId> {
  const rows = await db.query<DevelopmentScope>("SELECT * FROM authority.scope_instance WHERE parent_id=$1 AND child_key=$2", [f.root_scope_id, key]);
  if (!rows[0]) throw new Error(`child missing: ${key}`);
  return rows[0].id;
}
/** Begin, prepare and accept the analysis; returns the planning scope awaiting its plan. */
export async function throughAnalysis(f: Awaited<ReturnType<typeof runtimeFixture>>, db: TransactionalSqlExecutor): Promise<ScopeId> {
  const child = (key: string) => rootChild(f, db, key);
  await f.fact("begin"); await f.advance();
  const preparations = await db.query<DevelopmentScope>("SELECT * FROM authority.scope_instance WHERE parent_id=$1 AND scope_key='repository_preparation'", [f.root_scope_id]);
  for (const preparation of preparations) await f.fact("prepared", { repository_path: preparation.child_key === "other" ? "/tmp/other" : "/tmp", head: "head1", push_remote_owner: repository.forge.owner }, preparation.id);
  await f.advance(); await f.advance();
  const analysis = await child("analysis");
  const publication = await f.publish("analysis", { summary: "Spec", source_spec_refs: [], findings: [], requirements: [], risks: [] }, "author", analysis);
  if (publication.status !== 201) throw new Error(await publication.text());
  const accepted_analysis = await f.command("accept", { revision: revision((await publication.json()).revision_id) }, analysis);
  if (accepted_analysis.status !== 202) throw new Error(await accepted_analysis.text());
  await f.advance(); await f.advance();
  return child("plan");
}
export async function throughBriefs(f: Awaited<ReturnType<typeof runtimeFixture>>, briefs: readonly (typeof brief)[], db: TransactionalSqlExecutor): Promise<readonly DevelopmentScope[]> {
  const child = (key: string) => rootChild(f, db, key);
  const planning = await throughAnalysis(f, db);
  const plan = { summary: "Plan", cohorts: briefs.map((item) => ({ id: item.cohort_id, repository_key: item.repository_key, title: item.title, scope: item.goal, depends_on: item.depends_on,
    description: null, files_in_scope: item.files_in_scope, decisions: [], acceptance_criteria: item.acceptance_criteria })), dependency_order: briefs.map((item) => item.cohort_id), scope: { in_scope: [], out_of_scope: [] }, acceptance_criteria: [], risks: [] };
  const planned = await f.publish("plan", plan, "author", planning);
  if (planned.status !== 201) throw new Error(await planned.text());
  const accepted_plan = await f.command("accept", { revision: revision((await planned.json()).revision_id) }, planning);
  if (accepted_plan.status !== 202) throw new Error(await accepted_plan.text());
  await f.advance(); await f.advance();
  const writing = await child("briefs");
  const revisions: ReturnType<typeof revision>[] = [];
  for (const item of [...briefs].sort((a,b) => a.cohort_id.localeCompare(b.cohort_id))) {
    const published = await f.publish("briefs", item, "author", writing, item.cohort_id);
    if (published.status !== 201) throw new Error(await published.text());
    revisions.push(revision((await published.json()).revision_id));
  }
  const accepted = await f.command("accept", { revisions, briefs: [...briefs].sort((a,b) => a.cohort_id.localeCompare(b.cohort_id)) }, writing);
  if (accepted.status !== 202) throw new Error(await accepted.text());
  await f.advance(); await f.advance();
  return db.query<DevelopmentScope>("SELECT * FROM authority.scope_instance WHERE parent_id=$1 AND scope_key='implementation' ORDER BY child_key", [f.root_scope_id]);
}
