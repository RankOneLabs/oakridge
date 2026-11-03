/** Replace the run slice only after a real grade verified the exact capture. */
import { canonicalDigest, canonicalJson } from "canonical-json";
import { join, relative, resolve } from "node:path";
import { z } from "zod";
import { decodeSourceEventDelivery } from "../src/ingest/cursor";
import type { LiveReport } from "./jev-live-walkthrough";

// The authority SQL snapshot serializes safe counters as numbers; the publisher
// wire contract uses decimal text. Preserve the value and reject lossy numbers.
const transactionId = z.union([z.string().regex(/^\d+$/),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const rowSchema = z.object({ id: z.string(), commit_txid: transactionId, created_at: z.string(),
  run_id: z.string(), unit_id: z.string().nullable(), payload: z.object({ kind: z.string() }).passthrough() });
export interface RegenerationOptions { readonly capture: string; readonly rows: string; readonly grade: string;
  readonly output: string }
function requireCondition(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}
function same(left: unknown, right: unknown): boolean {
  const a = canonicalJson(left); const b = canonicalJson(right);
  return a.ok && b.ok && a.value === b.value;
}

export async function regenerateLiveFixtures(options: RegenerationOptions): Promise<void> {
  const input: unknown = await Bun.file(options.capture).json();
  requireCondition(Array.isArray(input) && input.length, "missing production capture");
  const deliveries = input.map((value: unknown) => {
    const delivery = decodeSourceEventDelivery(value);
    requireCondition(delivery, "invalid production delivery");
    return delivery;
  });
  const report = await Bun.file(options.grade).json() as LiveReport;
  const digest = canonicalDigest(deliveries);
  requireCondition(digest.ok && digest.value === report.capture_digest, "grade did not verify these exact capture bytes");
  requireCondition(report.question_id === "plan.criterion_traceability" && report.execution_id
    && report.records.execution.status === "completed" && report.raw_answer
    && Object.keys(report.probabilities).length, "missing completed real plan grade report");
  const rows = z.array(rowSchema).parse(await Bun.file(options.rows).json());
  requireCondition(rows.every((row) => row.run_id === report.run_id)
    && deliveries.every((delivery) => delivery.outcome.run_id === report.run_id), "source rows and verified capture must be the same run");
  const launch = deliveries.find(({ outcome }) => outcome.kind === "run_input");
  requireCondition(launch?.outcome.kind === "run_input", "missing captured launch");
  const revisions = ["plan", "brief", "assessment"].map((kind) => {
    const delivery = deliveries.filter(({ outcome }) => outcome.kind === "artifact_revision"
      && outcome.revision.source.artifact_kind === kind).at(-1);
    requireCondition(delivery?.outcome.kind === "artifact_revision", `missing real ${kind} revision; fixtures are unchanged`);
    const row = rows.find((row) => row.id === delivery.outcome.event_id);
    requireCondition(row && row.commit_txid === delivery.cursor.commit_txid
      && same(row.payload.body, delivery.outcome.revision.body), `source row differs from ${kind} capture`);
    return { delivery, row, envelope: delivery.outcome.revision };
  });
  const [plan, brief, assessment] = revisions;
  requireCondition(plan && brief && assessment, "missing run slice");
  const decision = deliveries.find(({ outcome }) => outcome.kind === "human_grade"
    && outcome.review === "plan_review" && outcome.effect === "approve");
  requireCondition(decision?.outcome.kind === "human_grade" && decision.outcome.decision_id, "missing real plan approval metadata");
  const decision_row = rows.find((row) => row.id === decision.outcome.event_id);
  const launch_row = rows.find((row) => row.id === launch.outcome.event_id);
  requireCondition(decision_row && launch_row, "missing authority launch or approval row");
  const old = await Bun.file(join(options.output, "events.json")).json() as { failure_cases: {
    duplicate_item: { id: string }; reordered_criterion_ids: string[]; revision_update: { id: string };
    repeated_delivery: { event_id: string } } };
  const body = z.object({ cohorts: z.array(z.object({ acceptance_criteria: z.array(z.object({ id: z.string() })).min(2) })).min(1) })
    .parse(plan.envelope.body);
  const ids = body.cohorts[0]!.acceptance_criteria.map((criterion) => criterion.id);
  const failures = { ...old.failure_cases,
    duplicate_item: { ...old.failure_cases.duplicate_item, id: ids[0] },
    reordered_criterion_ids: [...ids].reverse(), revision_update: { ...old.failure_cases.revision_update, id: ids[1] },
    repeated_delivery: { event_id: plan.row.id } };
  const selected = [launch_row, plan.row, decision_row, brief.row, assessment.row]
    .sort((a, b) => BigInt(a.commit_txid) < BigInt(b.commit_txid) ? -1 : a.commit_txid === b.commit_txid ? a.id.localeCompare(b.id) : 1);
  const json = async (file: string, value: unknown) => Bun.write(join(options.output, file), JSON.stringify(value, null, 2) + "\n");
  await json("events.json", { run_id: report.run_id, definition_id: launch.outcome.definition_id,
    captures: revisions.map((revision) => revision.envelope), launch: launch.outcome,
    rows: selected, failure_cases: failures });
  for (const revision of revisions) await json(`${revision.envelope.source.artifact_kind}-revision.json`, revision.envelope.body);
  await json("operator-decisions.json", { pre_existing: { ...decision_row,
    decision_id: decision.outcome.decision_id, effect: decision.outcome.effect } });
  const capture_path = relative(resolve(import.meta.dir, "../.."), resolve(options.capture));
  await Bun.write(join(options.output, "PROVENANCE.md"), `# Fixture provenance\n\n`
    + `These files derive from the isolated committed-development run \`${report.run_id}\`,\n`
    + `definition \`${launch.outcome.definition_id}\`. The durable production capture is\n`
    + `\`${capture_path}\`; its adjacent authority-rows.json retains the original event rows.\n\n`
    + `Before regeneration, the exact capture digest \`${report.capture_digest}\` was graded\n`
    + `through the direct TypeSafe adapter using plan.criterion_traceability. Execution\n`
    + `\`${report.execution_id}\` and all admission/result records were read back from\n`
    + `authenticated HTTP response bodies; the adjacent grade.json retains the evidence.\n\n`
    + `The revision files are verbatim published plan, brief and assessment bodies.\n`
    + `events.json selects the actual launch, those revision events and plan approval;\n`
    + `captures retains their original observation.artifact-revision/v2 envelopes,\n`
    + `definition IDs and artifact schema versions. IDs, transaction IDs, timestamps,\n`
    + `writer IDs, predecessors, subjects and decision metadata are unchanged.\n\n`
    + `The source run input and automatic acceptance feedback are authored verification\n`
    + `inputs. The nine-case failure_cases block is hand-written test material, never\n`
    + `an authority.event row: duplicate_item, reordered_criterion_ids, revision_update,\n`
    + `missing_source_ref, conflicting_duplicate, incomplete_evidence, repeated_delivery,\n`
    + `grader_failure, human_correction. Its criterion/event references are re-derived\n`
    + `from the new capture; its adversarial text and simulated failure values remain\n`
    + `hand-written. Companion tests derive mutated copies only for those cases.\n`);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const required = (name: string) => { const index = args.indexOf(name); const value = index < 0 ? undefined : args[index + 1];
    if (!value) throw new Error(`${name} is required`); return value; };
  await regenerateLiveFixtures({ capture: required("--capture"), rows: required("--rows"), grade: required("--grade"),
    output: "observation/fixtures/oakridge/run-slice" });
}
