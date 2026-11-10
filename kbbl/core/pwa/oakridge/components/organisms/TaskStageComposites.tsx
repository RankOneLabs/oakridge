import { useState } from "react";
import type { ObservationCompositeDrilldownKey, ObservationPageRequest, ObservationPaged } from "../../grading-contracts/grading/composite";
import type { ObservationStageCompositeRead } from "../../grading-contracts/grading/item-reads";
import { useTask } from "../../hooks/useTask";
import { useLastSuccessfulData } from "../../hooks/useLastSuccessfulData";
import { ListPager } from "../molecules/ListPager";
import { PagingReadError } from "../molecules/PagingReadError";
import { PagedStageColumn } from "./PagedStageColumn";

interface Props {
  runId: string;
  taskId: string;
  stages: ObservationPaged<ObservationStageCompositeRead>;
  isRevealed: boolean;
  onDrill: (key: ObservationCompositeDrilldownKey, label: string) => void;
}

/** One task's stages side by side. Paging them reads this task alone, so other tasks keep their own pages. */
export function TaskStageComposites({ runId, taskId, stages, isRevealed, onDrill }: Props) {
  const [stagesWindow, setStagesWindow] = useState<ObservationPageRequest | null>(null);
  const read = useTask(stagesWindow ? { run_id: runId, task_id: taskId, nested: { stages: stagesWindow } } : null);
  const belongsToTask = read.data?.run_id === runId && read.data.producer_local_id === taskId;
  const previous = useLastSuccessfulData(stagesWindow && belongsToTask ? read.data?.stages : undefined, JSON.stringify([runId, taskId]));
  const shown = previous ?? stages;
  return (
    <>
      {stagesWindow && read.isError && <PagingReadError error={read.error} isRetrying={read.isFetching} onRetry={() => void read.refetch()} />}
      <div className="grid gap-2 md:grid-cols-3" data-testid="or-task-stages">
        {shown.items.map((stage) => (
          <PagedStageColumn key={stage.stage} runId={runId} taskId={taskId} stage={stage} stagesWindow={stagesWindow} isRevealed={isRevealed} onDrill={onDrill} />
        ))}
      </div>
      <ListPager name="stages" page={shown} onWindow={setStagesWindow} />
    </>
  );
}
