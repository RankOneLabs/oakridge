import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createProductionComposition, type ProductionComposition } from "../src/runtime/compose";
import { decodeWorkflowSource } from "../src/core-client/source-types";
import type { RunId } from "../src/domain/primitives";
import { wakeRun } from "../src/workflows/topology";
import { launch, openAuthority, submitter } from "./authority-fixture";
import { commitTestDefinition } from "./committed-fixture";
import { eventually, startStubKbbl, type StubTurn } from "./stub-kbbl";
import { assessment, expansion, freeze, item, paid, plan, pr, sliceAssessment, sliceBuild, spend,
  studyInput, studyOperations, studySource } from "./study-fixture";

function workerOf(turn: StubTurn): string {
  return /worker `([^`]+)`/.exec(turn.preamble)?.[1] ?? "";
}
function memberOf(turn: StubTurn): string {
  return /on unit `([^`]+)`/.exec(turn.preamble)?.[1]?.split("/").at(-1) ?? "";
}
const reviews: Readonly<Record<string, string>> = {
  plan_review: "accept", spend_request_review: "approve", slice_assessment_review: "approve_assessment",
  slice_report_review: "expand", expansion_review: "accept", freeze_review: "accept", integration_review: "accept",
};
const assessmentReviews = new Set(["slice_assessment_review", "expansion_review", "integration_review"]);

test("study runs from prepare through two expansions, freeze and integration", async () => {
  const authority = await openAuthority();
  let composition: ProductionComposition | undefined;
  let activeRun: RunId | null = null;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => composition?.app.fetch(request) ?? new Response("starting", { status: 503 }) });
  const origin = `http://127.0.0.1:${server.port}`;
  const failures: string[] = [];
  const executionKeys: string[] = [];
  const kbbl = startStubKbbl(async (turn) => {
    const worker = workerOf(turn);
    const member = memberOf(turn);
    const publish = async (artifact: string, body: unknown, subject = turn.subject()) => {
      const result = await turn.publish(artifact, body, { predecessor: turn.predecessor(artifact), subject });
      if (!result.ok) throw new Error(`${artifact} refused: ${await result.text()}`);
    };
    try {
      switch (worker) {
        case "designer": await publish("plan", plan); break;
        case "slice_builder":
          await publish("slice_build", sliceBuild);
          await publish("pr", pr("slice", 1));
          break;
        case "spend_requester": await publish("spend_request", spend); break;
        case "slice_runner": {
          const key = /Execution key: `([^`]+)`/.exec(turn.task)?.[1];
          const claim = /Claim: POST `([^`]+)`/.exec(turn.task)?.[1];
          const evidence = /Evidence: PUT `([^`]+)`/.exec(turn.task)?.[1];
          const secret = /Your publication secret: (\S+)/.exec(turn.preamble)?.[1];
          if (!key || !claim || !evidence || !secret) throw new Error("Runner task is missing its execution endpoints or key");
          const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
          const request_id = () => crypto.randomUUID();
          const claimed = await fetch(new URL(claim, origin), { method: "POST", headers, body: JSON.stringify({ request_id: request_id() }) });
          expect(await claimed.json()).toEqual({ kind: "launch" });
          executionKeys.push(key);
          const saved = await fetch(new URL(evidence, origin), { method: "PUT", headers, body: JSON.stringify({ request_id: request_id(),
            evidence: { external_id: "paid-fake", store_path: "/runs/paid", detail: "Accepted" } }) });
          expect(saved.status).toBe(200);
          await publish("slice_report", paid(key));
          break;
        }
        case "slice_assessor": await publish("slice_assessment", sliceAssessment(executionKeys[0])); break;
        case "expander":
          await publish("expansion", expansion(member, [member]));
          await publish("pr", pr(member, member === "two" ? 2 : 3));
          break;
        case "assessor": await publish("assessment", assessment(member, [item("case", member)])); break;
        case "freezer":
          await publish("freeze", freeze);
          await publish("pr", pr("freeze", 4));
          break;
        case "integrator": {
          await publish("pr", pr("integration", 5));
          const unit = /on unit `([^`]+)`/.exec(turn.preamble)?.[1];
          if (!unit) throw new Error("Missing integration unit");
          const latest = await authority.db.selectFrom("authority.artifact_revision").select("id")
            .where("unit_id", "=", unit).where("artifact", "=", "pr").orderBy("seq", "desc").executeTakeFirstOrThrow();
          await publish("assessment", assessment("integration", [...plan.cases.map(({ id }) => item("case", id)), item("cohort_file", "full")]), latest.id);
          break;
        }
        default: throw new Error(`Unexpected worker ${worker}`);
      }
      return "succeeded";
    } catch (cause) {
      failures.push(`${worker}: ${String(cause)}`);
      return "failed";
    }
  });
  try {
    composition = await createProductionComposition({ database_url: authority.url, host: "127.0.0.1",
      executor: { kbbl_base_url: kbbl.url, publication_key: "study-test", publish_base_url: origin, agent_workdir: tmpdir(), gated_review_url: null },
      operation_runner: studyOperations, timing: { observe_interval_seconds: 0.05, wake_timeout_seconds: 0.5 } });
    const source = decodeWorkflowSource(JSON.parse(JSON.stringify(studySource).replaceAll('"every":"2m"', '"every":"1s"')));
    if (!source) throw new Error("Invalid study test definition");
    const { definition_id } = await commitTestDefinition({ source });
    const { run_id, result } = await launch(authority, { definition_id, request_id: crypto.randomUUID(), input: studyInput });
    expect(result).toMatchObject({ value: { kind: "committed" } });
    activeRun = run_id;
    await wakeRun(run_id);
    const decided = new Set<string>();
    const done = await eventually("study completion", async () => {
      if (failures.length) throw new Error(failures.join("\n"));
      const units = await authority.db.selectFrom("authority.unit").select(["id", "status", "review_prompts"])
        .where("run_id", "=", run_id).execute();
      for (const { id, review_prompts } of units) {
        for (const [review, awaiting] of Object.entries(review_prompts)) {
          const decision = reviews[review];
          if (!decision || !awaiting.decisions.some((entry) => entry.decision === decision && entry.is_available !== false)) continue;
          const target = awaiting.target;
          const identity = `${review}/${target}`;
          if (decided.has(identity)) continue;
          const assessed = assessmentReviews.has(review)
            ? await authority.db.selectFrom("authority.artifact_revision").select("subject").where("id", "=", target).executeTakeFirstOrThrow()
            : null;
          const response = await fetch(`${origin}/api/runs/${run_id}/units/${encodeURIComponent(id)}/reviews/${review}/decide`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request_id: crypto.randomUUID(), decision, target,
              ...(assessed ? { assessed_revision: assessed.subject, dispositions: [] } : { payload: {} }) }),
          });
          if (!response.ok) throw new Error(`${review}: ${await response.text()}`);
          decided.add(identity);
        }
      }
      const root = units.find(({ id }) => id === run_id);
      return root?.status.kind === "done" ? units : false;
    }, 60_000);
    activeRun = null;
    expect(executionKeys).toHaveLength(1);
    expect(executionKeys[0]).toMatch(/^xk_[0-9a-f]{64}$/);
    const completed = done.filter(({ status }) => status.kind === "done").map(({ id }) => id.slice(run_id.length)).sort();
    expect(completed).toEqual(["", "/design", "/expansion/three", "/expansion/two", "/freeze", "/integration", "/prepare/oakridge"]);
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    if (activeRun) await submitter(authority)({ run_id: activeRun, event: { kind: "cancel_requested" } });
    await composition?.close();
    server.stop(true);
    kbbl.stop();
    await authority.close();
  }
});
