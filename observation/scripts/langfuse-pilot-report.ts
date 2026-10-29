/** Render a reproducible Phase C measurement report from a pinned run snapshot. */
import { makeComparisonReport, type ComparisonMeasurement, type ComparisonReport } from "../src/langfuse/comparison-report";
import type { PilotRunOutput } from "./langfuse-pilot-run";

function hydrated(measurement: ComparisonMeasurement): ComparisonMeasurement {
  if (!measurement.execution) return measurement;
  return { ...measurement, execution: { ...measurement.execution,
    started_at: new Date(measurement.execution.started_at),
    ended_at: measurement.execution.ended_at ? new Date(measurement.execution.ended_at) : null } };
}
function measured(count: number, total: number, unit: string): string {
  return count === 0 ? "not measured" : `${(total / count).toFixed(3)} ${unit} across ${count} measured runs`;
}
export function renderPilotReport(run: PilotRunOutput, report: ComparisonReport): string {
  const groups = report.groups;
  const total = groups.reduce((sum, group) => sum + group.denominator, 0);
  const answered = groups.reduce((sum, group) => sum + group.answered, 0);
  const missing = groups.reduce((sum, group) => sum + group.missing, 0);
  const failed = groups.reduce((sum, group) => sum + group.failed, 0);
  const compared = groups.reduce((sum, group) => sum + group.label_agreement.compared, 0);
  const agreed = groups.reduce((sum, group) => sum + group.label_agreement.agreed, 0);
  const latency_count = groups.reduce((sum, group) => sum + group.latency_ms.count, 0);
  const latency_total = groups.reduce((sum, group) => sum + group.latency_ms.total, 0);
  const cost_count = groups.reduce((sum, group) => sum + group.cost.count, 0);
  const cost_total = groups.reduce((sum, group) => sum + group.cost.total, 0);
  const included = run.population.membership.filter((member) => member.disposition === "included").length;
  const lines = ["# Langfuse pilot measurement", "",
    `Population: ${run.population.manifest_id} (${included} included item-level cases).`,
    `Population digest: ${run.population.membership_digest}.`,
    `Shared item/evidence digest: ${run.population.shared_item_evidence_digest}.`,
    `Assay manifest: ${run.assay_manifest?.manifest_id ?? "not produced"}.`, "",
    `Measurements: ${total}; answered ${answered}; missing ${missing}; failed ${failed}.`,
    `Label agreement: ${compared === 0 ? "not measured" : `${agreed}/${compared}`}.`,
    `Latency: ${measured(latency_count, latency_total, "ms")}.`,
    `Cost: ${measured(cost_count, cost_total, "recorded currency units")}.`, "",
    "| Question/version | Evidence digest | Evaluator version | Split | N | Answered | Missing | Failed | Label agreement |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...groups.map((group) => `| ${group.key.question_id}@${group.key.question_version} | ${group.key.evidence_set_digest} | ${group.key.evaluator_version} | ${group.key.split} | ${group.denominator} | ${group.answered} | ${group.missing} | ${group.failed} | ${group.label_agreement.compared === 0 ? "not measured" : `${group.label_agreement.agreed}/${group.label_agreement.compared}`} |`),
    "", "Per-label disagreements are counted only where a machine answer and human label were both recorded.",
    ...groups.flatMap((group) => group.per_label_disagreement.map((label) =>
      `- ${group.key.question_id}@${group.key.question_version}, ${group.key.evaluator_version}, ${group.key.split}, ${label.label}: ${label.disagreements}/${label.compared} disagreements.`)),
    "", "Disagreement causes:",
    ...(["machine_disagreement", "evidence_insufficiency", "ambiguous_rubric", "inconsistent_human_review", "unclassified"] as const)
      .map((cause) => `- ${cause}: ${groups.reduce((sum, group) => sum + group.rows.filter((row) => row.disagreement_cause === cause).length, 0)}`),
    "", "Operations:",
    ...run.operations.map((operation) => `- ${operation.operation} ${operation.entity_id}: HTTP ${operation.status} (${operation.detail}).`),
    "", "Evidence-backed examples:",
    ...run.examples.map((example) => `- ${example.occurrence_id}: ${example.finding} (refs: ${example.evidence_refs.join(", ")}).`),
    "", "Raw probabilities and confidence remain in the run snapshot. A probability is not a calibrated correctness rate; a normalized score is reported only with its recorded policy id and version.",
    "Exploratory and held-out rows remain separate. This convenience sample supports no grader superiority claim.", ""];
  return lines.join("\n");
}

if (import.meta.main) {
  const [run_path, output_path] = Bun.argv.slice(2);
  if (!run_path || !output_path) throw new Error("usage: bun langfuse-pilot-report.ts <run.json> <report.md>");
  const run = await Bun.file(run_path).json() as PilotRunOutput;
  if (run.format_version !== "langfuse-pilot-run/v1") throw new Error("unexpected pilot run format");
  const report = makeComparisonReport(run.population, run.measurements.map(hydrated));
  if (!report.ok) throw new Error(report.error.detail);
  await Bun.write(output_path, renderPilotReport(run, report.value));
}
