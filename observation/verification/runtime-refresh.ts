/** Publish on a running shadow; inspect its process, new captures and immutable earlier grades. */
import type { PublishedConfiguration } from "../src/grading/configuration";
import { observationSettled, settleObservation } from "./scenarios";
import { z } from "zod";
import { editedGraders, graderPlans, pinChecks, readRunPins } from "./registration";
import { readUntil, settledRun, type GradingSource } from "./grading";
import { NO_EVIDENCE, scenarioStatus, type ProofCheck, type ScenarioReport } from "./proof-contract";
import type { ProofIo } from "./shadow-session";

const runtimeIdentity = z.object({ version: z.number().int().positive(), hash: z.string().min(1) });
const check = (name: string, passed: boolean, detail: string): ProofCheck => ({ name, passed, detail });
async function runtime(io: ProofIo) {
  const read = await io.observationGet("/v1/grading-config/runtime", "configure");
  if (!read.ok) throw new Error(read.error.detail);
  return runtimeIdentity.parse(read.value);
}
/** Raw database bytes, including all pin and grade columns, ordered by their immutable ids. */
async function history(io: ProofIo, run_id: string): Promise<string> {
  if (!/^[\w.:/-]+$/.test(run_id)) throw new Error("invalid run id");
  const read = await io.shadowQuery(io.state.observation.database, `SELECT jsonb_build_object(
    'pins', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.evidence_set_id), '[]') FROM observation.evidence_set e
      JOIN observation.item_occurrence i ON (i.producer, i.namespace, i.occurrence_id) = (e.producer, e.namespace, e.subject_occurrence_id) WHERE i.run_id = '${run_id}'),
    'grades', (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.observation_id), '[]') FROM observation.grade_observation g
      JOIN observation.evaluation_execution x USING (producer, namespace, execution_id) WHERE x.run_id = '${run_id}'))::text`);
  if (!read.ok || !read.value) throw new Error(read.ok ? "no history returned" : read.error.detail);
  return read.value;
}
export async function runtimeRefreshScenario(io: ProofIo, source: Pick<GradingSource, "run">): Promise<ScenarioReport> {
  const checks: ProofCheck[] = [];
  const finish = (): ScenarioReport => ({ id: "runtime-refresh", status: scenarioStatus(checks), checks, evidence: NO_EVIDENCE });
  let original: PublishedConfiguration | null = null;
  const owns_stack = !await io.stackAnswers();
  try {
    if (owns_stack) {
      const started = await io.startStack();
      if (!started.ok) throw new Error(started.error.detail);
    }
    const ready = await settleObservation(io);
    if (!observationSettled(ready.health)) throw new Error(`observation is unavailable: ${ready.health}; ${ready.launcher}`);
    original = await io.readGradingConfiguration();
    const plans = graderPlans(JSON.stringify(original.definitions));
    if (!plans.ok) throw new Error(plans.error.detail);
    const before = await runtime(io);
    const pid = (await io.observationStatus())?.detail;
    if (!pid || !/^pid_\d+$/.test(pid)) throw new Error("no observation process id recorded");
    const first = await source.run("analysis-on", { grading_enabled: true, through: "analysis", capture: "await" });
    if (!first.run || first.report.status !== "passed") throw new Error("the earlier capture did not complete");
    const measured = await readUntil(io, first.run.run_id, "before-refresh", settledRun);
    checks.push(check("the earlier capture has settled grades", settledRun(measured) && measured.some((entry) => entry.state === "answered"), `${measured.length} measurement(s)`));
    if (!checks.at(-1)!.passed) return finish();
    const bytes = await history(io, first.run.run_id);
    await io.publishGradingConfiguration(editedGraders(plans.value.committed));
    const after = await runtime(io);
    checks.push(check("publication changes the runtime-loaded hash", after.hash !== before.hash && after.version > before.version, `${before.version}:${before.hash} -> ${after.version}:${after.hash}`));
    const later = await source.run("analysis-edited", { grading_enabled: true, through: "analysis", capture: "await" });
    if (!later.run || later.report.status !== "passed") throw new Error("the later capture did not complete");
    const pins = await readRunPins(io, later.run.run_id, "after-refresh");
    checks.push(check("a new capture has question pins", pins.pins.length > 0, `${pins.pins.length} pin(s)`),
      ...pinChecks(pins, plans.value.edited_plan, "after-refresh"));
    checks.push(check("earlier pins and grades are byte-identical", bytes === await history(io, first.run.run_id), first.run.run_id));
    checks.push(check("the observation process id is unchanged", (await io.observationStatus())?.detail === pid, pid));
    return finish();
  } catch (cause) {
    checks.push(check("runtime refresh completes", false, cause instanceof Error ? cause.message : String(cause)));
    return finish();
  } finally {
    try { if (original !== null) await io.publishGradingConfiguration(original.definitions); }
    finally { if (owns_stack) await io.stopStack(); }
  }
}
