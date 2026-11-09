import { Button } from "../../../components/atoms/Button";

interface Props {
  task_id: string;
  /** The task's text, shown on hover. */
  text: string;
  /** Opens the task by its run-scoped id. Without it the id is shown and opens nothing. */
  onOpenTask?: (task_id: string) => void;
}

/** One task id wherever an artifact lists tasks: the plan's cohorts and a cohort's brief open the same task. */
export function TaskIdLink({ task_id, text, onOpenTask }: Props) {
  if (!onOpenTask) return <code className="or-code" title={text} data-testid="or-task-link" data-task-id={task_id}>{task_id}</code>;
  return (
    <Button variant="secondary" size="xsmall" className="font-mono! text-xs!" title={text} aria-label={`Open task ${task_id}`} data-testid="or-task-link" data-task-id={task_id}
      onClick={() => onOpenTask(task_id)}>{task_id}</Button>
  );
}
