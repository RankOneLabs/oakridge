import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createProductionComposition } from "../src/runtime/compose";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import type { PullRequestObservation } from "../src/domain/pull-request";
import type { PullRequestBranchQuery, PullRequestReader } from "../src/runtime/github-pull-requests";
import type { RunView } from "../src/projections/run-view";
import type { ScopeView } from "../src/projections/scope-view";
import { withDatabase } from "./effect-fixture";

// The shipped development bundle, driven from launch to a complete root through
// the production composition. The operator side submits only what the scope
// view projects (command prefill), exactly as the PWA does; the agent side
// publishes through the selected publication contract its prompt carries.

const binary = resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli");
const cohort = { id: "first", branch: "work", pr_url: "https://github.com/owner/repo/pull/1" };
const final_pr = { branch: "cohort", pr_url: "https://github.com/owner/repo/pull/2" };

function localRepository(): string {
  const path = mkdtempSync(resolve(tmpdir(), "oakridge-end-to-end-"));
  for (const args of [["init"], ["-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"],
    ["remote", "add", "origin", "https://github.com/owner/repo.git"]]) {
    const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: path, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  return path;
}

const brief = { cohort_id: cohort.id, repository_key: "repo", title: "Build feature", depends_on: [], goal: "Feature", files_in_scope: ["src"],
  decisions_made: [], approaches_rejected: [], acceptance_criteria: ["tests pass"], next_action: "Implement" };
/** What an agent publishes for each declared output. */
const OUTPUT_BODIES: { readonly [output_key: string]: (stage: string) => unknown } = {
  analysis: () => ({ summary: "Spec", source_spec_refs: [], findings: [], requirements: [], risks: [] }),
  plan: () => ({ summary: "Plan", cohorts: [{ id: cohort.id, repository_key: "repo", title: brief.title, scope: brief.goal, depends_on: [], description: null,
    files_in_scope: brief.files_in_scope, decisions: [], acceptance_criteria: brief.acceptance_criteria }], dependency_order: [cohort.id],
    scope: { in_scope: [], out_of_scope: [] }, acceptance_criteria: [], risks: [] }),
  briefs: () => brief,
  build_result: () => ({ repository_key: "repo", summary: "Built", changed_files: ["src"], tests: { passed: 1, failed: 0, output: null, summary: null, cargo_test_output: null },
    delegated_session_metadata: { cohort_id: cohort.id, session_id: null, branch: cohort.branch }, known_issues: [] }),
  pr_summary: (stage) => stage === "integration"
    ? { pr_url: final_pr.pr_url, branch: final_pr.branch, summary: "Integrate", review_status: null }
    : { pr_url: cohort.pr_url, branch: cohort.branch, summary: "Feature", review_status: null },
  assessment: () => ({ verdict: "pass", findings: [], test_evidence: null, recommended_next_actions: [] }),
};
/** Commands an operator issues to move work forward, in preference order. */
const FORWARD_COMMANDS = ["begin", "accept", "accept_build", "accept_assessment", "review_pr", "confirm_merged"] as const;

interface SessionStart { readonly secret: string; readonly endpoint: string; readonly outputs: readonly { readonly key: string; readonly collection_key: string | null }[] }
function readSessionStart(prompt: string): SessionStart {
  const secret = prompt.match(/Authorization: Bearer ([A-Za-z0-9_-]+)/)?.[1];
  const endpoint = prompt.match(/PUT (\S+)\/outputs\/<output-key>/)?.[1];
  const outputs = prompt.match(/Publish exactly these outputs: (\[.*?\])\.\n/)?.[1];
  if (!secret || !endpoint || !outputs) throw new Error("session prompt lacks its publication contract");
  return { secret, endpoint: new URL(endpoint).pathname, outputs: JSON.parse(outputs) };
}

test("the shipped development bundle runs from launch to completion with operator evidence from the projection", async () => {
  const repository_path = localRepository();
  const pull_requests = new Map<string, PullRequestObservation>();
  const opened = (query: PullRequestBranchQuery, url: string) => pull_requests.set(query.head_branch, { provider: "github", owner: query.owner, name: query.name,
    number: Number(url.split("/").pop()), url, head_branch: query.head_branch, base_branch: query.base_branch, head_sha: "head1", state: "open",
    source: "poll", observed_at: new Date().toISOString(), merged_at: null });
  const reader: PullRequestReader = {
    read: async () => ({ ok: true, value: null }),
    find_for_branches: async (query) => {
      const branch = query.head_branch === final_pr.branch ? final_pr : cohort;
      if (!pull_requests.has(query.head_branch)) opened(query, branch.pr_url);
      return { ok: true, value: [pull_requests.get(query.head_branch)!] };
    },
  };
  const merge = (branch: string) => {
    const pr = pull_requests.get(branch);
    if (pr && pr.state !== "merged") pull_requests.set(branch, { ...pr, state: "merged", merged_at: new Date().toISOString() });
  };

  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> } | null = null;
  const sessions = new Map<string, { completed: boolean }>();
  const sids = new Map<string, string>();
  const publish = async (start: SessionStart, stage: string, sid: string) => {
    for (const output of start.outputs) {
      const response = await app!.request(`${start.endpoint}/outputs/${output.key}`, { method: "PUT",
        headers: { "content-type": "application/json", authorization: `Bearer ${start.secret}` },
        body: JSON.stringify({ request_id: `${sid}:${output.key}`, predecessor_id: null, collection_key: output.collection_key ? cohort.id : "",
          body: OUTPUT_BODIES[output.key]!(stage) }) });
      if (response.status !== 201) throw new Error(`publish ${output.key}: ${response.status} ${await response.text()}`);
    }
    sessions.set(sid, { completed: true });
  };
  const agent_failures: string[] = [];
  const kbbl = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
    const segments = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const target = segments[0] === "sessions" && segments[1] === "resumable" ? segments[2] ?? "" : segments[1] ?? "";
    if (request.method === "PUT") {
      const known = sids.get(target);
      if (known) return Response.json({ kind: "attached", session: { sid: known, status: "live" } });
      const sid = crypto.randomUUID();
      sids.set(target, sid);
      sessions.set(sid, { completed: false });
      const { initial_prompt } = await request.json() as { initial_prompt: string };
      const stage = initial_prompt.match(/Stage: (\S+)/)?.[1] ?? "";
      void publish(readSessionStart(initial_prompt), stage, sid).catch((cause) => agent_failures.push(String(cause)));
      return Response.json({ kind: "attached", session: { sid, status: "live" } });
    }
    if (request.method === "DELETE") return Response.json({ stopped: true });
    return sessions.get(target)?.completed ? Response.json({ session: { endReason: "subprocess_exited" }, exit_code: 0 })
      : Response.json({ pending: true }, { status: 202 });
  } });

  try {
    await withDatabase(async ({ url }) => {
      const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-config/definitions/development.json")).json();
      const session = { runtime: "codex", workdir: repository_path, session_name: "test" };
      const repository = { key: "repo", preparation: { repository_path, expected_head: null },
        build: session, integration: session, forge: { owner: "owner", name: "repo", build_base: "cohort", final_base: "main" } };
      const composition = await createProductionComposition({ database_url: url, core_binary: binary, host: "127.0.0.1",
        kbbl_base_url: kbbl.url.href, pull_requests: reader,
        provider_capabilities: { probe: async () => ({ ok: true as const, value: true as const }), check_github: async () => ({ ok: true as const, value: true as const }) },
        timing: { observe_interval_seconds: 0.05, wake_timeout_seconds: 1 } });
      app = composition.app;
      try {
        const created = await app.request("/runs", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ bundle, input: { spec: "Feature", repositories: [repository], analysis: session, planning: session, briefs: session, title: "Feature", slug: "feature" } }) });
        expect(created.status).toBe(201);
        const { run_id, root_scope_id }: { run_id: string; root_scope_id: string } = await created.json();
        const read = async <T,>(path: string): Promise<T> => {
          const response = await app!.request(path);
          if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
          return response.json() as Promise<T>;
        };
        const issued: string[] = [];
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          if (agent_failures.length) throw new Error(agent_failures.join("; "));
          const root = await read<ScopeView>(`/api/runs/${run_id}/scopes/${root_scope_id}`);
          if (root.is_terminal) break;
          const run = await read<RunView>(`/api/runs/${run_id}`);
          for (const summary of run.scopes) {
            const scope = await read<ScopeView>(`/api/runs/${run_id}/scopes/${summary.scope_id}`);
            if (scope.is_terminal) continue;
            const state = scope.state.data.kind === "variant" ? scope.state.data.variant : null;
            // The forge merges once the operator has accepted the work it is waiting on.
            if (scope.scope_key === "implementation" && state === "awaiting_merge") merge(cohort.branch);
            if (scope.scope_key === "final_integration" && state === "review") merge(final_pr.branch);
            // Like the PWA, a command waits until every prefilled field has been observed.
            const command = FORWARD_COMMANDS.map((key) => scope.commands.find((item) => item.key === key))
              .find((item) => item !== undefined && (item.prefill ?? []).every((entry) => entry.key in (scope.command_prefill[item.key] ?? {})));
            if (!command) continue;
            const response = await app.request(`/api/runs/${run_id}/scopes/${scope.scope_id}/commands`, { method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ command_key: command.key, payload: scope.command_prefill[command.key] ?? {}, request_id: crypto.randomUUID(),
                scope_id: scope.scope_id, expected_scope_version: scope.cursor.scope_version, targets: scope.command_targets[command.key] ?? [] }) });
            if (response.status === 202) { issued.push(`${scope.scope_key}.${command.key}`); continue; }
            // A merge confirmation waits on a fresh PR observation; anything else is a defect.
            const detail = await response.text();
            if (command.key === "confirm_merged" && response.status === 422 && scope.commands.some((item) => item.key === "refresh_pr")) {
              await app.request(`/api/runs/${run_id}/scopes/${scope.scope_id}/commands`, { method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ command_key: "refresh_pr", payload: {}, request_id: crypto.randomUUID(), scope_id: scope.scope_id,
                  expected_scope_version: scope.cursor.scope_version, targets: [] }) });
              continue;
            }
            if (response.status !== 409) throw new Error(`${scope.scope_key}.${command.key}: ${response.status} ${detail}; prefill=${JSON.stringify(scope.command_prefill[command.key])}; resources=${JSON.stringify(scope.resources)}`);
          }
          await Bun.sleep(50);
        }
        const root = await read<ScopeView>(`/api/runs/${run_id}/scopes/${root_scope_id}`);
        expect({ is_terminal: root.is_terminal, outcome: root.outcome?.data, reviews: issued.filter((item) => !item.endsWith(".begin")) }).toMatchObject({
          is_terminal: true, outcome: { kind: "variant", variant: "complete" },
          reviews: ["spec_analysis.accept", "planning.accept", "brief_writing.accept", "implementation.accept_build", "implementation.accept_assessment",
            "implementation.confirm_merged", "final_integration.review_pr", "final_integration.confirm_merged"] });
      } finally { await composition.close(); }
    });
  } finally { kbbl.stop(true); rmSync(repository_path, { recursive: true, force: true }); }
}, 120_000);
