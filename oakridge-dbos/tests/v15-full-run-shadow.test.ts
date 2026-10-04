import { compileV15WorkflowDefinition } from "../src/compiler/compile-v15";
import { PostgresWorkflowDefinitionRepository } from "../src/storage/postgres-workflow-definitions";
import { PostgresOperatorProjectionRepository } from "../src/storage/postgres-operators";
import { createDevFlowAdapterRegistry } from "../src/adapters/dev-flow";
import { expect, test } from "bun:test";
import { createImplementationCohortHarness, waitFor } from "./support/implementation-cohort-harness";
import { stageInstanceIdFor } from "../src/decision/ids";
import { materializeStageInStorage } from "../src/storage/materialize-stage";
import { loadStageCohortContext } from "../src/storage/load-stage-cohort";
import type { CohortId, JsonValue } from "../src/domain/primitives";
import type { StageKey } from "../src/domain/dev-flow-v15";
import type { PlanBody, BuildBriefBody } from "../src/domain/dev-flow-artifacts";

const json = (body: object): JsonValue => body as JsonValue;
const plan: PlanBody = { summary: "sequential implementation", scope: { in_scope: ["proof"], out_of_scope: [] },
  acceptance_criteria: ["proof"], risks: [], cohorts: ["first", "second"].map((id, index) => ({
    id, repository_key: "oakridge", title: id, scope: "proof", depends_on: index ? ["first"] : [], description: null,
    files_in_scope: [], decisions: [], acceptance_criteria: [id],
  })) };
const brief = (id: string, index: number): BuildBriefBody => ({ cohort_id: id, repository_key: "oakridge", title: id,
  depends_on: index ? ["first"] : [], goal: id, files_in_scope: [], decisions_made: [], approaches_rejected: [], acceptance_criteria: [id], next_action: "build" });

test("the six-stage workflow uses real shadow kbbl agents, frozen cohorts, independent reviews and explicit final merge confirmation", async () => {
  const fixture = await createImplementationCohortHarness({ full_run: true, full_runtime: true });
  const projections = new PostgresOperatorProjectionRepository(fixture.sql, "shadow", createDevFlowAdapterRegistry());
  let launch_index = 0;
  try {
    const fingerprint = async () => ({
      cohorts: await fixture.sql.query("SELECT id,state,durable_version,accepted_build FROM oakridge.cohort ORDER BY id", []),
      workers: await fixture.sql.query("SELECT cohort_id,worker,state,active_execution_id,work,response FROM oakridge.cohort_worker ORDER BY cohort_id,worker", []),
      outputs: await fixture.sql.query("SELECT cohort_id,worker,output_name,artifact_id,acceptance_state,reviewed_target FROM oakridge.worker_output ORDER BY cohort_id,worker,output_name,collection_key", []),
      executions: await fixture.sql.query("SELECT id,worker,action_point,resolved_input,prompt,settings,session_id FROM oakridge.execution_intent ORDER BY id", []),
      artifacts: await fixture.sql.query("SELECT id,chain_id,revision,body,lifecycle FROM oakridge.artifact ORDER BY id", []),
    });
    const restartAt = async (state: "working" | "reviewing" | "awaiting_merge") => {
      const current = await fixture.sql.query<{ readonly state: string }>("SELECT state FROM oakridge.cohort WHERE stage_instance_id=$1 ORDER BY materialization_position", [stageInstanceIdFor(fixture.run_id, "implementation")]);
      expect(current[0]?.state).toBe(state === "reviewing" ? "working" : state);
      if (state === "reviewing") expect((await fixture.sql.query<{ readonly state: string }>(
        "SELECT worker.state FROM oakridge.cohort_worker worker JOIN oakridge.cohort cohort ON cohort.id=worker.cohort_id WHERE cohort.stage_instance_id=$1 AND worker.worker='build' ORDER BY cohort.materialization_position",
        [stageInstanceIdFor(fixture.run_id, "implementation")]))[0]?.state).toBe("awaiting_review");
      const before = await fingerprint();
      const launches = fixture.launches.length;
      await fixture.restart();
      expect(await fingerprint()).toEqual(before);
      expect(fixture.launches.length).toBe(launches);

    };
    const open = async (key: StageKey): Promise<readonly CohortId[]> => {
      const stage_id = stageInstanceIdFor(fixture.run_id, key);
      const ids = await waitFor(`materialized ${key}`, async () => {
        const rows = await fixture.sql.query<{ readonly id: CohortId }>(
          "SELECT id::text FROM oakridge.cohort WHERE stage_instance_id=$1 ORDER BY materialization_position", [stage_id]);
        return rows.length ? rows.map((row) => row.id) : null;
      });
      const replay = await materializeStageInStorage(fixture.sql, { stage_instance_id: stage_id, at: fixture.now() });
      if (replay.ok && replay.value.kind === "opened") expect(replay.value.cohort_ids).toEqual(ids);
      return ids;
    };
    const publish = async (publications: readonly import("./support/implementation-agent").AgentPublication[], commit_build = false) => {
      const answers = await fixture.execute(launch_index++, { kind: "publish", commit_build, publications });
      expect(answers.map((answer) => answer.status), JSON.stringify(answers)).toEqual(publications.map(() => 201));
    };
    const provision = (await open("repository_preparation"))[0]!;
    await waitFor("provision completion", async () => (await fixture.sql.query<{ readonly state: string }>("SELECT state FROM oakridge.cohort WHERE id=$1", [provision]))[0]?.state === "complete" ? true : null);
    expect(await fixture.sql.query("SELECT id FROM oakridge.session WHERE attempt_id IN (SELECT id FROM oakridge.attempt WHERE cohort_id=$1)", [provision])).toEqual([]);
    const pin = await fixture.sql.query("SELECT workflow_definition_id,bundle_pin FROM oakridge.workflow_run WHERE id=$1", [fixture.run_id]);
    const newer = structuredClone(fixture.workflow);
    newer.version = (Number(newer.version) + 1) as typeof newer.version;
    const compiled = await compileV15WorkflowDefinition(newer, { load: async (path) =>
      `${await Bun.file(new URL(`../../${path}`, import.meta.url)).text()}\nNewDefinitionMarker` });
    if (!compiled.ok) throw new Error(compiled.error.detail);
    await new PostgresWorkflowDefinitionRepository(fixture.sql).insert_v15_immutable(newer, compiled.value.prompts);
    expect(await fixture.sql.query("SELECT workflow_definition_id,bundle_pin FROM oakridge.workflow_run WHERE id=$1", [fixture.run_id])).toEqual(pin);
    const spec = (await open("spec_analysis"))[0]!;
    await publish([{ output_name: "spec_analysis", body: { summary: "spec", source_spec_refs: [], findings: [], requirements: [], risks: [] } }]);
    const analysis = await loadStageCohortContext(fixture.sql, spec, "spec_analysis");
    if (!analysis.ok || analysis.value.stage !== "spec_analysis" || !analysis.value.cohort.spec.response?.current) throw new Error("analysis missing");
    expect(analysis.value.cohort.spec.state).toBe("awaiting_review");
    const diagnosis = await projections.get_run_diagnosis(fixture.run_id);
    expect(diagnosis?.sessions_awaiting_action.map((session) => session.worker)).toEqual(["spec"]);
    expect((await projections.get_review_inbox()).items.map((item) => item.stage_name)).toEqual(["spec_analysis"]);
    await fixture.advanceCohort(spec, { kind: "accept_analysis", target: analysis.value.cohort.spec.response.current });
    const planning = (await open("planning"))[0]!;
    // S18/S19 reject malformed dependency graphs at the actual publication
    // boundary before they can create implementation membership.
    const planLaunch = await fixture.launch(launch_index);
    for (const invalid of [
      { ...plan, cohorts: plan.cohorts.map((cohort, index) => ({ ...cohort, depends_on: [index ? "first" : "second"] })) },
      { ...plan, cohorts: plan.cohorts.map((cohort) => ({ ...cohort, depends_on: ["missing"] })) },
    ]) {
      const refusal = await fixture.request(`/work-orders/${planLaunch.attempt_id}/emit/plan`, { method: "PUT",
        headers: { "content-type": "application/json", "work-order-capability": planLaunch.capability }, body: JSON.stringify(invalid) });
      expect(refusal.status).toBe(409);
      expect(await fixture.sql.query("SELECT id FROM oakridge.artifact WHERE artifact_type='dev.plan'", [])).toEqual([]);
      expect(await fixture.sql.query("SELECT id FROM oakridge.cohort WHERE stage_instance_id=$1", [stageInstanceIdFor(fixture.run_id, "implementation")])).toEqual([]);
    }
    await publish([{ output_name: "plan", body: json(plan) }]);
    let planned = await loadStageCohortContext(fixture.sql, planning, "planning");
    if (!planned.ok || planned.value.stage !== "planning" || !planned.value.cohort.plan.response?.current) throw new Error("plan missing");
    await fixture.advanceCohort(planning, { kind: "revise_plan", feedback: { text: "Clarify the scope", target: planned.value.cohort.plan.response.current } });
    expect((await fixture.launch(launch_index)).prompt).toContain("Clarify the scope");
    await publish([{ output_name: "plan", body: json(plan) }]);
    planned = await loadStageCohortContext(fixture.sql, planning, "planning");
    if (!planned.ok || planned.value.stage !== "planning" || !planned.value.cohort.plan.response?.current) throw new Error("revised plan missing");
    expect(planned.value.cohort.plan.response.current.version).toBe(2);
    await fixture.advanceCohort(planning, { kind: "accept_plan", target: planned.value.cohort.plan.response.current });
    const briefing = (await open("brief_writing"))[0]!;
    const briefLaunch = await fixture.launch(launch_index);
    for (const depends_on of [["second"], ["missing"]]) {
      const refusal = await fixture.request(`/work-orders/${briefLaunch.attempt_id}/emit/briefs`, { method: "PUT",
        headers: { "content-type": "application/json", "work-order-capability": briefLaunch.capability, "output-collection-key": "first" },
        body: JSON.stringify({ ...brief("first", 0), depends_on }) });
      expect(refusal.status).toBe(409);
      expect(await fixture.sql.query("SELECT id FROM oakridge.artifact WHERE artifact_type='dev.build_brief'", [])).toEqual([]);
    }
    await publish(plan.cohorts.map((cohort, index) => ({ output_name: "briefs", collection_key: cohort.id, body: json(brief(cohort.id, index)) })));
    let briefed = await loadStageCohortContext(fixture.sql, briefing, "brief_writing");
    if (!briefed.ok || briefed.value.stage !== "brief_writing" || !briefed.value.cohort.brief.response?.current) throw new Error("brief collection missing");
    expect(briefed.value.cohort.brief.state).toBe("awaiting_review");
    expect((await projections.get_review_inbox()).items[0]?.artifact_revision_ids).toHaveLength(2);
    await fixture.advanceCohort(briefing, { kind: "revise_briefs", feedback: { text: "Clarify all briefs", target: briefed.value.cohort.brief.response.current } });
    expect((await fixture.sql.query<{ readonly acceptance_state: string }>("SELECT acceptance_state FROM oakridge.worker_output WHERE cohort_id=$1", [briefing])).map((output) => output.acceptance_state))
      .toEqual(["changes_requested", "changes_requested"]);
    await publish(plan.cohorts.map((cohort, index) => ({ output_name: "briefs", collection_key: cohort.id, body: json(brief(cohort.id, index)) })));
    briefed = await loadStageCohortContext(fixture.sql, briefing, "brief_writing");
    if (!briefed.ok || briefed.value.stage !== "brief_writing" || !briefed.value.cohort.brief.response?.current) throw new Error("revised briefs missing");
    expect(briefed.value.cohort.brief.response.current.members.map((member) => member.ref.version)).toEqual([2, 2]);
    await fixture.advanceCohort(briefing, { kind: "accept_briefs", target: briefed.value.cohort.brief.response.current });
    const implementations = await open("implementation");
    expect(implementations).toHaveLength(2);
    expect((await fixture.sql.query<{ readonly state: string }>("SELECT state FROM oakridge.cohort_worker WHERE cohort_id=$1 AND worker='build'", [implementations[1]!]))[0]?.state).toBe("pending");
    for (const [index, cohort_id] of implementations.entries()) {
      const loaded = await loadStageCohortContext(fixture.sql, cohort_id, "implementation");
      if (!loaded.ok || loaded.value.stage !== "implementation") throw new Error("implementation missing");
      fixture.forge.head_branch = loaded.value.cohort.inputs.repository.canonical_branch;
      fixture.forge.base_branch = "epic/schema";
      fixture.forge.state = "open"; fixture.forge.merged_at = null; fixture.forge.head_sha = null; fixture.forge.number = index + 1;
      const launch = await fixture.launch(launch_index);
      if (index === 1) {
        const base = await fixture.runGit(fixture.origin, ["rev-parse", "refs/heads/epic/schema"]);
        const worktree = launch.prompt.match(/^Worktree: (.+)$/m)?.[1];
        if (!worktree) throw new Error("builder worktree missing");
        // The second cohort's base must include the first cohort's merged work.
        expect(await fixture.runGit(worktree, ["merge-base", base, "HEAD"])).toBe(base);
      }
      if (index === 0) await restartAt("working");
      await publish([{ output_name: "build_result", body: { repository_key: "oakridge", summary: "built", changed_files: [], tests: { passed: 1, failed: 0 }, known_issues: [] } },
        { output_name: "pr_summary", body: { repository_key: "oakridge", branch: fixture.forge.head_branch, base_branch: "epic/schema",
          pr_url: `https://github.com/example/oakridge/pull/${index + 1}`, summary: "built" } }], true);
      const built = await loadStageCohortContext(fixture.sql, cohort_id, "implementation");
      if (!built.ok || built.value.stage !== "implementation") throw new Error("build missing");
      const response = built.value.cohort.build.response;
      if (!response?.build_result || !response.pr_summary || !response.head_sha) throw new Error("build response incomplete");
      if (index === 0) await restartAt("reviewing");
      await fixture.advanceCohort(cohort_id, { kind: "accept_build", target: { outputs: { build_result: response.build_result,
        pr_summary: response.pr_summary }, head_sha: response.head_sha } });
      await publish([{ output_name: "assessment", body: { verdict: "pass", findings: [], recommended_next_actions: [] } }]);
      const assessed = await loadStageCohortContext(fixture.sql, cohort_id, "implementation");
      if (!assessed.ok || assessed.value.stage !== "implementation" || !assessed.value.cohort.accepted_build
        || !assessed.value.cohort.assessment.outputs.assessment) throw new Error("assessment missing");
      const assessment = assessed.value.cohort.assessment.outputs.assessment;
      await fixture.advanceCohort(cohort_id, { kind: "accept_assessment", target: { assessment: { id: assessment.id, version: assessment.version },
        build: assessed.value.cohort.accepted_build } });
      if (index === 0) await restartAt("awaiting_merge");
      await fixture.runGit(fixture.origin, ["update-ref", "refs/heads/epic/schema", response.head_sha]);
      fixture.forge.state = "closed"; fixture.forge.merged_at = fixture.now();
      await waitFor("implementation merged", async () => (await fixture.sql.query<{ readonly state: string }>("SELECT state FROM oakridge.cohort WHERE id=$1", [cohort_id]))[0]?.state === "complete" ? true : null);
    }
    const final = (await open("final_integration"))[0]!;
    fixture.forge.head_branch = "epic/schema"; fixture.forge.base_branch = "main"; fixture.forge.state = "open";
    fixture.forge.merged_at = null; fixture.forge.number = 3;
    await publish([{ output_name: "pr_summary", body: { repository_key: "oakridge", branch: "epic/schema", base_branch: "main",
      pr_url: "https://github.com/example/oakridge/pull/3", summary: "complete" } }]);
    fixture.forge.state = "closed"; fixture.forge.merged_at = fixture.now();
    await fixture.pollPullRequests();
    const waiting = await loadStageCohortContext(fixture.sql, final, "final_integration");
    if (!waiting.ok || waiting.value.stage !== "final_integration" || !waiting.value.cohort.final_integration.outputs.pr_summary) throw new Error("final missing");
    expect(waiting.value.cohort.state).toBe("working");
    const summary = waiting.value.cohort.final_integration.outputs.pr_summary;
    const head = (await fixture.runGit(fixture.repo, ["ls-remote", "origin", "refs/heads/epic/schema"])).split(/\s+/)[0]!;
    await fixture.advanceCohort(final, { kind: "confirm_merged", target: { pr_summary: { id: summary.id, version: summary.version },
      pr_url: summary.body.pr_url, head_sha: head as never } });
    const status = await waitFor("DBOS root completed", async () => {
      const rows = await fixture.sql.query<{ readonly status: string }>("SELECT status FROM oakridge.workflow_run WHERE id=$1", [fixture.run_id]);
      return rows[0]?.status === "complete" ? rows[0].status : null;
    });
    expect(status).toBe("complete");
    const stages = await fixture.sql.query<{ readonly stage_key: string; readonly status: string }>("SELECT stage_key,status FROM oakridge.stage_instance WHERE run_id=$1", [fixture.run_id]);
    expect(stages).toHaveLength(6);
    expect(stages.every((stage) => stage.status === "complete")).toBe(true);
    expect(fixture.launches).toHaveLength(10);
    expect(fixture.launches.every((launch) => !launch.prompt.includes("NewDefinitionMarker"))).toBe(true);
    expect(await fixture.sql.query("SELECT workflow_definition_id,bundle_pin FROM oakridge.workflow_run WHERE id=$1", [fixture.run_id])).toEqual(pin);
  } finally { await fixture.close(); }
}, 180_000);
