import { useQueries, useQuery } from "@tanstack/react-query";
import { useOperatorUnits } from "./useOperatorUnits";
import { useRunStages } from "./useRunStages";
import { useRunTasks } from "./useRunTasks";
import { oakridgeGet, unitPath } from "../client-http";
import { readItemStatus, readRunFindings } from "../client-grading";
import type { OperatorArtifactDetail } from "../operator-contracts/projections/artifact-view";
import type { ObservationGradeableItemRow } from "../grading-contracts/grading/item-reads";
import { selectStageEvaluation, selectStageExecution, selectStageInputs, selectUnitFindings, type StageOverviewSource, type StageRead } from "../lib/stage-overview";
import { parseArtifactDetail } from "../adapters/parse";
import { unwrap } from "../adapters/core";
const PAGE = { limit: 200, offset: 0 };
export const selectStageRead = <Value,>(query: { readonly data: Value | undefined; readonly isError: boolean }): StageRead<Value> =>
  query.data !== undefined ? { state: "loaded", value: query.data } : { state: query.isError ? "unavailable" : "pending" };

export function useStageOverview(run_id: string, unit_id: string) {
  const units = useOperatorUnits(run_id);
  const stages = useRunStages(run_id);
  const tasks = useRunTasks({ run_id, page: PAGE, nested: { stages: PAGE, results: PAGE } });
  const artifacts = useQuery({ queryKey: ["oakridge", "run", run_id, "overview-artifacts", units.data], enabled: units.data !== undefined,
    queryFn: async () => Promise.all((units.data ?? []).flatMap((unit) => unit.artifacts.map(async (artifact) => {
      const path = `${unitPath(run_id, unit.unit_id)}/artifacts/${encodeURIComponent(artifact.artifact_key)}`;
      return unwrap(path, parseArtifactDetail(await oakridgeGet<unknown>(path)));
    }))), refetchInterval: 10_000 });
  const findings = useQuery({ queryKey: ["oakridge", "grading", "stage-overview-findings", run_id, stages.data], enabled: stages.data !== undefined,
    queryFn: async () => {
      const rows: ObservationGradeableItemRow[] = [];
      for (const stage of stages.data ?? []) {
        for (let offset = 0; ; offset += PAGE.limit) {
          const page = await readRunFindings(run_id, { stage: stage.stage, is_current_only: false, page: { ...PAGE, offset }, links: PAGE });
          rows.push(...page.items);
          if (offset + page.items.length >= page.total || page.items.length === 0) break;
        }
      }
      return rows;
    }, refetchInterval: 10_000 });
  const unit = units.data?.find((candidate) => candidate.unit_id === unit_id);
  const source: StageOverviewSource | null = unit ? { unit, artifacts: artifacts.data ?? [],
    index: { run_id, units: units.data ?? [], revisions: (artifacts.data ?? []).flatMap((artifact: OperatorArtifactDetail) => artifact.revisions) } } : null;
  const selectedFindings = source ? selectUnitFindings(source, findings.data ?? []) : [];
  const statuses = useQueries({ queries: selectedFindings.map(({ item }) => ({
    queryKey: ["oakridge", "grading", "stage-overview-status", item.occurrence_id],
    queryFn: () => readItemStatus({ occurrence_id: item.occurrence_id, top: PAGE, nested: { links: PAGE, references: PAGE, machine: PAGE, answers: PAGE, attempts: PAGE, superseded_answers: PAGE } }),
    retry: false, refetchInterval: 10_000,
  })) });
  return { units, artifacts, source, inputs: source ? selectStageInputs(source) : null, execution: source ? selectStageExecution(source) : null,
    evaluation: source ? selectStageEvaluation({ source, stages: selectStageRead(stages), findings: artifacts.data ? selectStageRead(findings) : { state: artifacts.isError ? "unavailable" : "pending" },
      tasks: !artifacts.data || !findings.data ? { state: artifacts.isError || findings.isError ? "unavailable" : "pending" } : tasks.data ? { state: "loaded", value: tasks.data.items, is_partial: tasks.data.items.length < tasks.data.total } : { state: tasks.isError ? "unavailable" : "pending" },
      statuses: statuses.map(selectStageRead) }) : null };
}
