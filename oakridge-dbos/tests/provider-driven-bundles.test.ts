/**
 * The end-to-end evidence for this PR: every shipped bundle driven fully
 * provider-driven through the PRODUCTION composition, plus the five run-shape
 * cases the plan requires.
 *
 * There is no fixture harness and no `result_schema` override here — a fixture
 * override is exactly what hid the original session defect behind a green
 * suite, so nothing in this file substitutes an effect provider. The only
 * injected seams are the two outside-world edges: the kbbl HTTP endpoint
 * (`kbbl-stub`, which keeps kbbl's real wire contract) and the GitHub
 * pull-request reader.
 */
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { withDatabase } from "./effect-fixture";
import { eventually, revisionOf, SHIPPED_BUNDLES, startHarness, type Harness, type ShippedBundle } from "./bundle-harness";
import {
  analysisBody, driveAnalysis, driveBriefWriting, driveImplementation, driveIntegration,
  drivePlanning, drivePreparations, type CohortBrief,
} from "./bundle-drive";

const ONE_COHORT: CohortBrief[] = [{ cohort_id: "first", repository_key: "repo", depends_on: [] }];

/**
 * `development-verification`'s root input schema is `run_input_verification`,
 * which declares `verification_note`. An optional member still has to be
 * present, so every harness for that bundle supplies it.
 */
function inputFor(bundle: ShippedBundle): Record<string, unknown> | undefined {
  return bundle === "development-verification" ? { verification_note: "verify" } : undefined;
}

async function cleanup(h: Harness): Promise<void> {
  await h.close();
  for (const path of h.repository_paths.values()) rmSync(path, { recursive: true, force: true });
}

async function implementationChildren(h: Harness, count: number) {
  return eventually(async () => {
    const children = await h.children("implementation");
    return children.length === count ? children : null;
  }, `${count} implementation children`);
}

/**
 * The headline criterion, once per shipped bundle: every session worker in the
 * bundle reaches a committed terminal state in one provider-driven run.
 */
for (const bundle of SHIPPED_BUNDLES) {
  test(`${bundle}: every session worker reaches a committed terminal state`, async () => {
    await withDatabase(async ({ url, db }) => {
      const h = await startHarness({ bundle, database_url: url, db, label: `full-${bundle}`,
        input_extra: inputFor(bundle) });
      try {
        await drivePreparations(h);
        await driveAnalysis(h);
        await drivePlanning(h, ONE_COHORT);
        await driveBriefWriting(h, ONE_COHORT);
        for (const child of await implementationChildren(h, ONE_COHORT.length)) {
          await driveImplementation(h, child, ONE_COHORT.find((brief) => brief.cohort_id === child.child_key)!);
        }
        for (const child of await eventually(async () => {
          const found = await h.children("final_integration");
          return found.length > 0 ? found : null;
        }, "final integration children")) await driveIntegration(h, child);

        const root = await h.awaitTerminalScope(h.root_scope_id);
        expect((root.outcome?.data as { variant?: string }).variant).toBe("complete");

        // Every session the run started ended through the provider, and every
        // execution row that carried one is committed terminal.
        const sessions = h.kbbl.all();
        expect(sessions.map((session) => session.worker).sort())
          .toEqual(["assessment", "author", "author", "author", "build", "integrator"]);
        expect(sessions.every((session) => session.outcome.kind === "succeeded")).toBe(true);
        expect(sessions.every((session) => session.observations > 0)).toBe(true);
        // Scoped to the session workers, which is what the criterion is about.
        // A pull-request observer execution left over by a scope that reached
        // its outcome first is not a session worker and is not asserted here.
        const session_workers = h.bundle.scopes.flatMap((scope) => scope.workers
          .filter((worker) => worker.actions.some((action) => action.operation === "session.run"))
          .map((worker) => `${scope.key}:${worker.key}`));
        await eventually(async () => {
          const rows = await db.query<{ scope_key: string; worker_key: string; status: string }>(
            `SELECT s.scope_key, e.worker_key, e.status FROM authority.execution e
             JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=$1`, [h.run_id]);
          const sessions_run = rows.filter((row) => session_workers.includes(`${row.scope_key}:${row.worker_key}`));
          return sessions_run.length > 0 && sessions_run.every((row) => row.status === "terminal") ? true : null;
        }, "every session-worker execution committed terminal", 60_000);
      } finally { await cleanup(h); }
    });
  }, 600_000);
}

/**
 * PR 1's session evidence fact through PR 2's recovery mapping, and the
 * independent-sibling failure policy the bundle declares: the failed cohort
 * fails, its independent sibling still completes.
 */
test("a failed session delivers evidence and the run follows the declared failure branch", async () => {
  const briefs: CohortBrief[] = [
    { cohort_id: "first", repository_key: "repo", depends_on: [] },
    { cohort_id: "second", repository_key: "repo", depends_on: [] },
  ];
  await withDatabase(async ({ url, db }) => {
    const h = await startHarness({ bundle: "development-independent-siblings", database_url: url, db, label: "failure",
      // Keyed on the start body, so a retried attempt fails too and the action
      // exhausts its budget instead of stalling on a fresh pending session.
      policy: (body) => body.workflow.unit_id === "first" && body.workflow.operator_role === "build"
        ? { kind: "failed", code: "kbbl_restart", detail: "runtime died" }
        : { kind: "pending" } });
    try {
      await drivePreparations(h);
      await driveAnalysis(h);
      await drivePlanning(h, briefs);
      await driveBriefWriting(h, briefs);
      const children = await implementationChildren(h, briefs.length);
      const failing = children.find((child) => child.child_key === "first")!;
      const healthy = children.find((child) => child.child_key === "second")!;

      // The build session fails in the provider, not in a fixture.
      await h.awaitSession(failing.id, "build");

      const failed = await h.awaitTerminalScope(failing.id);
      expect((failed.outcome?.data as { variant?: string }).variant).toBe("failed");

      // The declared recovery mapping turned the provider failure into the
      // scope's `session_failed` fact, and that fact is what was committed.
      // The delivery flag is written after the decision commits, so the scope
      // can be terminal a moment before the intent is marked delivered.
      const evidence = await eventually(async () => {
        const rows = await db.query<{ key: string; delivered: boolean }>(
          `SELECT payload->'evidence'->>'key' AS key,
                  coalesce((payload->>'evidence_delivered')::boolean,false) AS delivered
           FROM authority.effect_intent WHERE scope_id=$1 AND payload ? 'evidence'`, [failing.id]);
        return rows.some((row) => row.key === "session_failed" && row.delivered) ? rows : null;
      }, "delivered session_failed evidence");
      expect(evidence).toContainEqual({ key: "session_failed", delivered: true });

      // The independent sibling is unaffected and still completes: this is the
      // declared branch, not a generic teardown.
      await driveImplementation(h, healthy, briefs[1]!);
      expect((await h.scope(healthy.id)).is_terminal).toBe(true);
      expect(((await h.scope(healthy.id)).outcome?.data as { variant?: string }).variant).toBe("complete");

      // The surviving cohort still seeds integration, which the root waits on.
      for (const child of await eventually(async () => {
        const found = await h.children("final_integration");
        return found.length > 0 ? found : null;
      }, "final integration children")) await driveIntegration(h, child);

      // The run aggregates the one failed cohort rather than reporting success.
      const root = await h.awaitTerminalScope(h.root_scope_id);
      expect((root.outcome?.data as { variant?: string }).variant).toBe("failed");
    } finally { await cleanup(h); }
  });
}, 600_000);

/** Operator cancellation goes through the one cancellation pipeline and reaches the agent. */
test("operator cancellation terminates a run and fences its live session", async () => {
  await withDatabase(async ({ url, db }) => {
    const h = await startHarness({ bundle: "development", database_url: url, db, label: "cancel" });
    try {
      await drivePreparations(h);
      const analysis = await h.awaitChild("spec_analysis");
      const session = await h.awaitSession(analysis.id, "author");

      const cancelled = await h.composition.app.request(`/runs/${h.run_id}/cancel`,
        { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "cancel_run", reason: "operator stopped the run" }) });
      expect(cancelled.status).toBe(200);

      const root = await h.awaitTerminalScope(h.root_scope_id);
      expect((root.outcome?.data as { variant?: string }).variant).toBe("cancelled");
      // The agent was actually stopped: cancellation reached kbbl, not just the ledger.
      await eventually(async () => (session.fenced ? true : null), "live session fenced");
      // Nothing is left owing the provider: a cancelled start is revoked and
      // its stop is confirmed, so no intent stays pending or acknowledged.
      await eventually(async () => {
        const owing = await db.query<{ status: string }>(
          `SELECT e.status FROM authority.effect_intent e JOIN authority.scope_instance s ON s.id=e.scope_id
           WHERE s.run_id=$1 AND e.status IN ('pending','acknowledged','cleanup_pending')`, [h.run_id]);
        return owing.length === 0 ? true : null;
      }, "every effect obligation settled", 60_000);
    } finally { await cleanup(h); }
  });
}, 600_000);

/**
 * Capacity contention on `development-verification`'s distinct pool limit of
 * three (`implementation_slots`), sourced from that bundle rather than from
 * `development-independent-siblings` staying divergent.
 */
test("sibling scopes contending a pool respect its limit and all eventually complete", async () => {
  const briefs: CohortBrief[] = ["first", "second", "third", "fourth"].map((cohort_id) =>
    ({ cohort_id, repository_key: "repo", depends_on: [] }));
  await withDatabase(async ({ url, db }) => {
    const h = await startHarness({ bundle: "development-verification", database_url: url, db, label: "capacity",
      input_extra: inputFor("development-verification") });
    try {
      const limit = h.bundle.scopes.find((scope) => scope.key === "implementation")
        ?.pools.find((pool) => pool.key === "implementation_slots")?.limit;
      expect(limit).toBe(3);

      await drivePreparations(h);
      await driveAnalysis(h);
      await drivePlanning(h, briefs);
      await driveBriefWriting(h, briefs);
      const children = await implementationChildren(h, briefs.length);

      // Four cohorts contend three slots: admission is capped and one waits.
      const active = () => db.query<{ scope_id: string }>(
        `SELECT r.scope_id FROM authority.capacity_reservation r
         JOIN authority.scope_instance s ON s.id=r.scope_id WHERE r.is_active AND s.run_id=$1`, [h.run_id]);
      await eventually(async () => (await active()).length === 3 ? true : null, "three admitted cohorts");
      const admitted = (await active()).map((row) => row.scope_id);
      const waiting = children.find((child) => !admitted.includes(child.id))!;
      expect(waiting).toBeDefined();
      await h.awaitState(waiting.id, "ready");

      // Draining the admitted work admits the one that waited; all four finish.
      for (const child of children.filter((item) => admitted.includes(item.id))) {
        await driveImplementation(h, child, briefs.find((brief) => brief.cohort_id === child.child_key)!);
        expect((await active()).length).toBeLessThanOrEqual(3);
      }
      await driveImplementation(h, waiting, briefs.find((brief) => brief.cohort_id === waiting.child_key)!);
      for (const child of children) expect((await h.scope(child.id)).is_terminal).toBe(true);

      const released = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM authority.capacity_reservation r
         JOIN authority.scope_instance s ON s.id=r.scope_id WHERE r.is_active AND s.run_id=$1`, [h.run_id]);
      expect(released[0]?.count).toBe("0");
    } finally { await cleanup(h); }
  });
}, 900_000);

/** A mid-run revision: feedback clears the output, the revise action reruns, the stage converges. */
test("a revision applied mid-run reruns the action and converges", async () => {
  await withDatabase(async ({ url, db }) => {
    const h = await startHarness({ bundle: "development", database_url: url, db, label: "revision" });
    try {
      await drivePreparations(h);
      const analysis = await h.awaitChild("spec_analysis");
      await h.awaitSession(analysis.id, "author");
      const first_revision = await h.publish(analysis.id, "author", "analysis", analysisBody);
      await h.awaitState(analysis.id, "review");
      h.settle(analysis.id, "author");
      await h.awaitTerminalExecution(analysis.id);

      await h.requireCommand(analysis.id, "request_changes",
        { revision: revisionOf(first_revision), text: "Add the risk section" });

      // The revision dispatches a second session for the same worker, and the
      // feedback it was started with is the operator's text.
      const revised = await eventually(async () => {
        const found = h.kbbl.sessions_for({ scope_id: analysis.id, worker: "author" });
        return found.length === 2 ? found[1]! : null;
      }, "revise session");
      expect(revised.start_body.initial_prompt).toContain("Add the risk section");
      await h.awaitState(analysis.id, "working");

      const second_revision = await h.publish(analysis.id, "author", "analysis",
        { ...analysisBody, risks: [{ description: "schedule", mitigation: "stage the work" }] });
      expect(second_revision).not.toBe(first_revision);
      await h.awaitState(analysis.id, "review");
      h.settle(analysis.id, "author");

      // Converged: the stale revision is refused, the current one is accepted.
      const stale = await h.command(analysis.id, "accept", { revision: revisionOf(first_revision) });
      expect(stale.status).toBe(422);
      await h.requireCommand(analysis.id, "accept", { revision: revisionOf(second_revision) });
      const done = await h.awaitTerminalScope(analysis.id);
      expect((done.outcome?.data as { variant?: string }).variant).toBe("complete");
    } finally { await cleanup(h); }
  });
}, 600_000);
