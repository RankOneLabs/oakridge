/**
 * Operator form for launching a new study run.
 *
 * The task selector is backed by GET /api/tasks and shows the selected
 * task's artifact + grader metadata next to the chooser. The selected
 * task name is controlled by the top-level app so later task-creation
 * flows can hand off directly into Launch with a preselected task.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { useLaunch } from "../../hooks/useLaunch";
import { useHashSelection } from "../../hooks/useHashSelection";
import { useTasks } from "../../hooks/useTasks";
import type { TaskSummary } from "../../lib/types";
import {
  buildRunSpec,
  coerceFormStateForSelectedTask,
  KNOWN_MODELS,
  createInitialFormState,
  formatTaskGraderState,
  formatTaskSource,
  minNFor,
  resolveSelectedTask,
  type FormState,
} from "./launchFormModel";
import { CONDITION_KINDS } from "../../lib/types";

export interface LaunchFormProps {
  selectedTaskName: string | null;
  onSelectedTaskNameChange: (taskName: string | null) => void;
}

function taskOptionLabel(task: TaskSummary): string {
  return `${task.name} · ${formatTaskSource(task)}`;
}

export function LaunchForm({
  selectedTaskName,
  onSelectedTaskNameChange,
}: LaunchFormProps) {
  const [, select] = useHashSelection();
  const { launch, is_pending, error: launchError } = useLaunch();
  const { tasks, refresh, error: taskError } = useTasks();
  const [warning, setWarning] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const [state, setState] = useState<FormState>(() =>
    createInitialFormState(null),
  );
  const gradeInitialized = useRef(false);

  const selectedTaskResolution = useMemo(() => {
    if (selectedTaskName === null) {
      return { task: null, error: null };
    }
    return resolveSelectedTask(tasks, selectedTaskName);
  }, [tasks, selectedTaskName]);

  const selectedTask = selectedTaskResolution.task;
  const selectedTaskLoadError =
    taskError ??
    (selectedTaskName !== null && selectedTask === null
      ? selectedTaskResolution.error
      : null);

  useEffect(() => {
    if (selectedTaskName === null) return;
    setState((s) => {
      if (s.selectedTaskName === selectedTaskName) return s;
      return { ...s, selectedTaskName };
    });
  }, [selectedTaskName]);

  useEffect(() => {
    if (tasks.length === 0) return;
    if (selectedTaskName !== null) return;
    const firstTask = tasks[0];
    if (firstTask === undefined) return;
    onSelectedTaskNameChange(firstTask.name);
    setState((s) => coerceFormStateForSelectedTask(s, firstTask));
  }, [tasks, selectedTaskName, onSelectedTaskNameChange]);

  useEffect(() => {
    if (selectedTask === null) return;
    setState((s) => {
      const next = coerceFormStateForSelectedTask(s, selectedTask);
      if (!gradeInitialized.current) {
        gradeInitialized.current = true;
        return {
          ...next,
          should_grade: selectedTask.has_grader,
        };
      }
      return next;
    });
  }, [selectedTask]);

  const result = useMemo(() => buildRunSpec(state), [state]);

  function toggleModel(model: string) {
    setState((s) => {
      const next = new Set(s.checkedModels);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return { ...s, checkedModels: next };
    });
  }

  function addFreeTextModel() {
    const trimmed = freeText.trim();
    if (!trimmed || state.extraModels.includes(trimmed)) {
      setFreeText("");
      return;
    }
    setState((s) => ({ ...s, extraModels: [...s.extraModels, trimmed] }));
    setFreeText("");
  }

  function removeExtraModel(model: string) {
    setState((s) => ({
      ...s,
      extraModels: s.extraModels.filter((entry) => entry !== model),
    }));
  }

  function setKind(kind: FormState["conditionKind"]) {
    setState((s) => {
      let n = s.n;
      if (kind === "single_agent") {
        n = 1;
      } else if (n < minNFor(kind)) {
        n = minNFor(kind);
      }
      return { ...s, conditionKind: kind, n };
    });
  }

  function setN(raw: number) {
    const min = minNFor(state.conditionKind);
    setState((s) => ({ ...s, n: Math.max(min, Math.min(16, raw)) }));
  }

  function onTaskChange(taskName: string) {
    onSelectedTaskNameChange(taskName);
    const task = tasks.find((entry) => entry.name === taskName) ?? null;
    if (task === null) return;
    setState((s) => coerceFormStateForSelectedTask({ ...s, selectedTaskName: taskName }, task));
  }

  async function handleLaunch() {
    if (selectedTaskLoadError !== null || selectedTask === null || !result.ok) {
      return;
    }
    setWarning(null);
    const response = await launch(result.spec);
    if (response) {
      if (response.warning) setWarning(response.warning);
      select(response.cell_id);
    }
  }

  const minN = minNFor(state.conditionKind);
  const gradeDisabled = selectedTask === null || !selectedTask.has_grader;

  return (
    <div className="flex flex-wrap gap-6 px-4 pb-4 pt-2">
      {/* Task */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Task
        </label>
        <select
          className="rounded border border-stone-300 px-2 py-1 text-sm"
          value={selectedTaskName ?? ""}
          onChange={(e) => onTaskChange(e.target.value)}
          disabled={tasks.length === 0 && taskError !== null}
        >
          <option value="">— pick task —</option>
          {tasks.map((task) => (
            <option key={task.name} value={task.name}>
              {taskOptionLabel(task)}
            </option>
          ))}
        </select>
        <div className="mt-1 rounded border border-stone-200 bg-stone-50 px-2 py-2 text-xs text-stone-600">
          {selectedTask === null ? (
            <p>
              {taskError !== null
                ? "Task list could not be loaded."
                : "Select a task to see details."}
            </p>
          ) : (
            <dl className="grid grid-cols-[auto,1fr] gap-x-2 gap-y-1">
              <dt className="font-semibold uppercase tracking-wide text-stone-400">
                Artifact
              </dt>
              <dd>
                {selectedTask.artifact_filename} · {selectedTask.artifact_type}
              </dd>
              <dt className="font-semibold uppercase tracking-wide text-stone-400">
                Source
              </dt>
              <dd>{formatTaskSource(selectedTask)}</dd>
              <dt className="font-semibold uppercase tracking-wide text-stone-400">
                Grader
              </dt>
              <dd>{formatTaskGraderState(selectedTask)}</dd>
            </dl>
          )}
        </div>
        {selectedTaskLoadError !== null && (
          <div className="mt-1 flex items-center gap-2 text-xs text-red-500">
            <span>{selectedTaskLoadError}</span>
            <button
              type="button"
              className="rounded bg-stone-100 px-2 py-1 text-stone-700 hover:bg-stone-200"
              onClick={() => void refresh()}
            >
              Retry
            </button>
          </div>
        )}
      </div>

      {/* Models */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Models
        </label>
        <div className="flex flex-col gap-0.5">
          {KNOWN_MODELS.map((model) => (
            <label key={model} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={state.checkedModels.has(model)}
                onChange={() => toggleModel(model)}
              />
              {model}
            </label>
          ))}
        </div>
        {state.extraModels.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            {state.extraModels.map((model) => (
              <div key={model} className="flex items-center gap-1 text-sm">
                <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700">
                  {model}
                </span>
                <button
                  type="button"
                  aria-label={`Remove model ${model}`}
                  className="text-stone-400 hover:text-red-500"
                  onClick={() => removeExtraModel(model)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-1 flex gap-1">
          <input
            className="w-44 rounded border border-stone-300 px-2 py-1 text-sm"
            placeholder="other model id…"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addFreeTextModel();
              }
            }}
          />
          <button
            type="button"
            className="rounded bg-stone-100 px-2 py-1 text-xs hover:bg-stone-200"
            onClick={addFreeTextModel}
          >
            Add
          </button>
        </div>
      </div>

      {/* Condition */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Condition
        </label>
        <div className="flex flex-col gap-0.5">
          {CONDITION_KINDS.map((kind) => (
              <label key={kind} className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="conditionKind"
                  checked={state.conditionKind === kind}
                  onChange={() => setKind(kind as FormState["conditionKind"])}
                />
                {kind}
              </label>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            n
          </label>
          <input
            type="number"
            min={minN}
            max={16}
            value={state.n}
            disabled={state.conditionKind === "single_agent"}
            onChange={(e) => setN(Number(e.target.value))}
            className="w-16 rounded border border-stone-300 px-2 py-1 text-sm disabled:bg-stone-100 disabled:text-stone-400"
          />
        </div>
      </div>

      {/* Grade */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Grade
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={state.should_grade}
            disabled={gradeDisabled}
            onChange={(e) =>
              setState((s) => ({ ...s, should_grade: e.target.checked }))
            }
          />
          Run grader
        </label>
        {gradeDisabled && selectedTask !== null && (
          <p className="text-xs text-stone-500">No valid grader for this task.</p>
        )}
      </div>

      {/* Launch */}
      <div className="flex flex-col justify-end gap-1.5">
        {!result.ok && state.selectedTaskName !== "" && (
          <p className="text-xs text-red-500">{result.error}</p>
        )}
        {warning !== null && <p className="text-xs text-amber-600">⚠ {warning}</p>}
        {launchError !== null && <p className="text-xs text-red-500">{launchError}</p>}
        <button
          className="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={
            is_pending ||
            selectedTask === null ||
            selectedTaskLoadError !== null ||
            !result.ok ||
            (state.should_grade && !selectedTask.has_grader)
          }
          onClick={() => void handleLaunch()}
        >
          {is_pending ? "Launching…" : "Launch"}
        </button>
      </div>
    </div>
  );
}
