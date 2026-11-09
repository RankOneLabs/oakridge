import { useState } from "react";
import type { WindowQuery } from "../../client-grading";
import type { DrilldownKey, PageWindow, StageComposite } from "../../grading-types";
import { useTask } from "../../hooks/useTask";
import { selectTaskStage } from "../../lib/grading";
import { StageCompositeColumn } from "../molecules/StageCompositeColumn";

interface Props {
  runId: string;
  taskId: string;
  stage: StageComposite;
  /** The task's stages window, so a stage on a later page is still in its own read. */
  stagesWindow: PageWindow | null;
  isRevealed: boolean;
  onDrill: (key: DrilldownKey, label: string) => void;
}

/**
 * One stage of one task with paging of its own. Until it pages it shows the copy its parent read;
 * once it does, it reads its task with its own windows and shows only its own stage from that read,
 * so no other task's or stage's lists move.
 */
export function PagedStageColumn({ runId, taskId, stage, stagesWindow, isRevealed, onDrill }: Props) {
  const [windows, setWindows] = useState<WindowQuery>({});
  const isPaged = Object.keys(windows).length > 0;
  const read = useTask(isPaged ? { run_id: runId, task_id: taskId, nested: stagesWindow ? { ...windows, stages: stagesWindow } : windows } : null);
  const shown = (isPaged ? selectTaskStage(read.data, stage.stage) : null) ?? stage;
  return <StageCompositeColumn stage={shown} isRevealed={isRevealed} onDrill={onDrill} onWindow={(name, window) => setWindows((current) => ({ ...current, [name]: window }))} />;
}
