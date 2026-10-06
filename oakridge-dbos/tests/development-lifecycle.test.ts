import { expect, test } from "bun:test";
import { withDatabase } from "./effect-fixture";
import { developmentBundle, runtimeFixture, launch, brief, throughBriefs } from "./development-runtime-fixture";

test("accepted brief keys materialize children and failure atomically cancels siblings and releases capacity", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle("development"), launch);
  try {
    const children = await throughBriefs(f, [brief, { ...brief, cohort_id: "second" }], db);
    expect(children.map((item) => item.child_key)).toEqual(["first", "second"]);
    await f.fact("abandon", {}, children[0]!.id);
    await f.advance();
    const owners = await db.query<{ is_terminal: boolean }>("SELECT is_terminal FROM authority.scope_instance WHERE run_id=$1", [f.run_id]);
    expect(owners.every((item) => item.is_terminal)).toBe(true);
    const reservations = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM authority.capacity_reservation WHERE is_active", []);
    expect(reservations[0]?.count).toBe("0");
  } finally { f.core.close(); }
}), 30_000);

test("independent policy cancels dependents, continues independent siblings, and aggregates terminal failures", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle("development", true), launch);
  try {
    const children = await throughBriefs(f, [brief, { ...brief, cohort_id: "second", depends_on: ["first"] }, { ...brief, cohort_id: "third" }], db);
    const first = children.find((item) => item.child_key === "first")!;
    const second = children.find((item) => item.child_key === "second")!;
    const third = children.find((item) => item.child_key === "third")!;
    expect((await f.scope(second.id)).local_state.data).toMatchObject({ variant: "ready" });
    await f.fact("abandon", {}, first.id);
    await f.advance(); await f.advance();
    expect((await f.scope(second.id)).is_terminal).toBe(true);
    expect((await f.scope(third.id)).is_terminal).toBe(false);
    expect((await f.scope()).is_terminal).toBe(false);
    await f.fact("abandon", {}, third.id);
    await f.advance(); await f.advance();
    expect((await f.scope()).outcome?.data).toMatchObject({ kind: "variant", variant: "failed" });
  } finally { f.core.close(); }
}), 30_000);

test("shared capacity limits admission and a released slot admits waiting independent work", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle("development", true), launch);
  try {
    const children = await throughBriefs(f, [brief, { ...brief, cohort_id: "second" }, { ...brief, cohort_id: "third" }], db);
    const rows = await db.query<{ scope_id: string }>("SELECT scope_id FROM authority.capacity_reservation WHERE is_active", []);
    expect(rows).toHaveLength(2);
    const waiting = children.find((item) => !rows.some((row) => row.scope_id === item.id))!;
    expect((await f.scope(waiting.id)).local_state.data).toMatchObject({ variant: "ready" });
    await f.fact("abandon", {}, rows[0]!.scope_id as typeof f.root_scope_id);
    await f.advance();
    expect((await f.scope(waiting.id)).local_state.data).toMatchObject({ variant: "working" });
  } finally { f.core.close(); }
}), 30_000);

test("completed implementations create one final integration child per repository", async () => withDatabase(async ({ db }) => {
  const { repository, build_body, pr_body, revision } = await import("./development-runtime-fixture");
  const f = await runtimeFixture(db, await developmentBundle("development"), { ...launch, repositories: [repository, { ...repository, key: "other", preparation: { ...repository.preparation, repository_path: "/tmp/other" } }] });
  try {
    const briefs = [brief, { ...brief, cohort_id: "second" }, { ...brief, cohort_id: "third", repository_key: "other" }];
    const children = await throughBriefs(f, briefs, db);
    for (const child of children) {
      const build = await f.publish("build_result", build_body, "build", child.id);
      if (build.status !== 201) throw new Error(await build.text());
      const pr = await f.publish("pr_summary", pr_body, "build", child.id);
      if (pr.status !== 201) throw new Error(await pr.text());
      await f.observe("open", "head1", child.id);
      const target = { build_result: revision((await build.json()).revision_id), pr_summary: revision((await pr.json()).revision_id), pr_url: pr_body.pr_url, head_sha: "head1" };
      const accepted = await f.command("accept_build", target, child.id);
      if (accepted.status !== 202) throw new Error(await accepted.text());
      const assessment = await f.publish("assessment", { verdict: "pass", findings: [], test_evidence: null, recommended_next_actions: [] }, "assessment", child.id);
      if (assessment.status !== 201) throw new Error(await assessment.text());
      const assessed = await f.command("accept_assessment", { ...target, assessment: revision((await assessment.json()).revision_id) }, child.id);
      if (assessed.status !== 202) throw new Error(await assessed.text());
      await f.observe("merged", "head1", child.id);
      const merged = await f.command("confirm_merged", {}, child.id);
      if (merged.status !== 202) throw new Error(await merged.text());
    }
    await f.advance(); await f.advance();
    const integrations = await db.query<import("./development-runtime-fixture").DevelopmentScope>("SELECT * FROM authority.scope_instance WHERE parent_id=$1 AND scope_key='final_integration' ORDER BY child_key", [f.root_scope_id]);
    expect(integrations.map((item) => item.child_key)).toEqual(["other", "repo"]);
    const counts_by_repository = integrations.map((item) => {
      const completed = item.input.data.kind === "record" ? item.input.data.fields[2]?.value?.data : null;
      return completed?.kind === "list" ? completed.items.length : 0;
    });
    expect(counts_by_repository).toEqual([1, 2]);
    for (const integration of integrations) {
      const published = await f.publish("pr_summary", pr_body, "integrator", integration.id);
      if (published.status !== 201) throw new Error(await published.text());
      await f.observe("open", "head1", integration.id);
      const target = { revision: revision((await published.json()).revision_id), pr_url: pr_body.pr_url, head_sha: "head1" };
      expect((await f.command("review_pr", { ...target, head_sha: "stale" }, integration.id)).status).toBe(422);
      expect((await f.command("review_pr", target, integration.id)).status).toBe(202);
      await f.observe("merged", "head2", integration.id);
      expect((await f.command("confirm_merged", target, integration.id)).status).toBe(422);
      await f.observe("merged", "head1", integration.id);
      expect((await f.command("confirm_merged", target, integration.id)).status).toBe(202);
    }
    await f.advance();
    expect((await f.scope()).outcome?.data).toMatchObject({ variant: "complete" });
  } finally { f.core.close(); }
}), 60_000);
