import { useEffect, useState, type ReactNode } from "react";

import { Badge } from "../atoms/Badge";
import { EmptyMessage } from "../atoms/EmptyMessage";
import type { GraderConfigDraft, GraderSummary, TaskDetail, TaskSummary } from "../../lib/types";
import { TaskDetailSchema, TaskDraftSchema } from "../../lib/types";
import {
  blankTaskDraftForm,
  formatLineList,
  loadTaskDraftForm,
  parseLineList,
  sanitizeTaskDraftForm,
  TASK_DRAFT_STORAGE_KEY,
  taskDraftFormToPayload,
  isBlankTaskDraftForm,
  type TaskDraftFormState,
} from "../../lib/taskDraft";
import {
  taskStateLabels,
  taskSummaryStateLabels,
} from "../../lib/taskSelectors";
import { useTaskDetail } from "../../hooks/useTaskDetail";

function toneForLabel(label: string): "green" | "amber" | "red" | "sky" | "slate" {
  if (label === "Available to launch") return "green";
  if (label === "Grader configured") return "sky";
  if (label === "Invalid grader config") return "red";
  if (label === "No grader") return "amber";
  return "slate";
}

function sectionCardClass(extra = ""): string {
  return `rounded-2xl border border-stone-200 bg-white shadow-sm ${extra}`;
}

function TaskDetailField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-stone-400">
        {label}
      </div>
      <div className="text-sm text-stone-800">{children}</div>
    </div>
  );
}

function TaskDetailPanel({
  detail,
  graders,
  graderConfigs,
  onDelete,
}: {
  detail: TaskDetail;
  graders: GraderSummary[];
  graderConfigs: GraderConfigDraft[];
  onDelete: (taskName: string) => Promise<void>;
}) {
  const stateLabels = taskStateLabels(detail, graders, graderConfigs);
  const canDelete = detail.source === "local";
  const graderKey =
    detail.source === "local"
      ? detail.grader.kind === "registered"
        ? detail.grader.key
        : null
      : detail.grader_key;

  return (
    <div className={sectionCardClass("p-5")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {stateLabels.map((label) => (
              <Badge key={label} label={label} tone={toneForLabel(label)} />
            ))}
          </div>
          <div>
            <h3 className="text-xl font-semibold text-stone-900">{detail.name}</h3>
            <p className="text-sm text-stone-500">
              {detail.artifact_type} · {detail.artifact_filename}
            </p>
          </div>
        </div>
        {canDelete ? (
          <button
            type="button"
            className="rounded-full border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
            onClick={() => void onDelete(detail.name)}
          >
            Delete task
          </button>
        ) : (
          <Badge label="Read only" tone="slate" />
        )}
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <TaskDetailField label="Seed content">
          <pre className="whitespace-pre-wrap rounded-xl bg-stone-950 px-4 py-3 text-xs leading-5 text-stone-100">
            {detail.seed_content.length > 0 ? detail.seed_content : "Empty seed"}
          </pre>
        </TaskDetailField>
        <TaskDetailField label="Model pool">
          <div className="flex flex-wrap gap-2">
            {detail.model_pool.map((model) => (
              <Badge key={model} label={model} />
            ))}
          </div>
        </TaskDetailField>
        <TaskDetailField label="Frame pool">
          <div className="flex flex-wrap gap-2">
            {detail.frame_pool.length > 0 ? (
              detail.frame_pool.map((frame) => (
                <Badge key={frame ?? "null"} label={frame ?? "null"} />
              ))
            ) : (
              <span className="text-stone-500">No frame pool.</span>
            )}
          </div>
        </TaskDetailField>
        <TaskDetailField label="Grader">
          {graderKey === null ? (
            <span className="text-stone-500">No grader wired.</span>
          ) : (
            <div className="space-y-2">
              <div className="font-medium text-stone-900">{graderKey}</div>
              <div className="text-stone-500">Registered grader ref</div>
            </div>
          )}
        </TaskDetailField>
      </div>

      <div className="mt-5 space-y-4">
        <TaskDetailField label="Task brief">
          <div className="rounded-xl bg-stone-50 p-4 text-sm leading-6 text-stone-800">
            {detail.brief.target_spec}
          </div>
        </TaskDetailField>
        <div className="grid gap-4 md:grid-cols-2">
          <TaskDetailField label="Success criteria">
            <ul className="space-y-2">
              {detail.brief.success_criteria.map((entry) => (
                <li key={entry} className="rounded-xl bg-stone-50 px-3 py-2">
                  {entry}
                </li>
              ))}
            </ul>
          </TaskDetailField>
          <TaskDetailField label="Constraints">
            {detail.brief.constraints.length > 0 ? (
              <ul className="space-y-2">
                {detail.brief.constraints.map((entry) => (
                  <li key={entry} className="rounded-xl bg-stone-50 px-3 py-2">
                    {entry}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-stone-500">No constraints.</span>
            )}
          </TaskDetailField>
        </div>
      </div>
    </div>
  );
}

function TaskCreateForm({
  graders,
  onCreate,
}: {
  graders: GraderSummary[];
  onCreate: (payload: TaskDraftFormState) => Promise<string>;
}) {
  const [form, setForm] = useState<TaskDraftFormState>(() => blankTaskDraftForm());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = loadTaskDraftForm(window.localStorage.getItem(TASK_DRAFT_STORAGE_KEY));
    if (stored !== null) {
      setForm(stored);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isBlankTaskDraftForm(form)) {
      window.localStorage.removeItem(TASK_DRAFT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(TASK_DRAFT_STORAGE_KEY, JSON.stringify(form));
  }, [form]);

  const modelPoolLabel =
    form.model_pool.length > 0
      ? `${form.model_pool.length} model entries`
      : "defaults will be used";

  function updateBriefField(
    key: keyof TaskDraftFormState["brief"],
    value: string | string[],
  ) {
    setForm((current) => ({
      ...current,
      brief: {
        ...current.brief,
        [key]: value,
      },
    }));
  }

  function updateArtifactType(nextType: TaskDraftFormState["artifact_type"]) {
    setForm((current) => {
      const nextFilename =
        current.artifact_filename.trim().length === 0 ||
        current.artifact_filename === "draft.md" ||
        current.artifact_filename === "solution.py"
          ? nextType === "code"
            ? "solution.py"
            : "draft.md"
          : current.artifact_filename;
      return {
        ...current,
        artifact_type: nextType,
        artifact_filename: nextFilename,
      };
    });
  }

  function resetForm() {
    const next = blankTaskDraftForm();
    setForm(next);
    setError(null);
    setStatus(null);
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(TASK_DRAFT_STORAGE_KEY);
    }
  }

  async function handleSubmit() {
    setError(null);
    setStatus(null);
    const sanitized = sanitizeTaskDraftForm(form);
    const payload = taskDraftFormToPayload(sanitized);
    if ("error" in payload) {
      setError(payload.error);
      return;
    }
    try {
      const name = await onCreate(form);
      setStatus(`Saved ${name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const hasRegisteredGrader = form.grader.kind === "registered";

  return (
    <div className={sectionCardClass("p-5")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-stone-900">Create local task</h3>
          <p className="text-sm text-stone-500">
            Draft a local task, save it to dashboard storage, then launch it from the Launch section.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-full border border-stone-200 px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
            onClick={resetForm}
          >
            Reset draft
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <label className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
            Name
          </div>
          <input
            className="w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
            value={form.name}
            onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))}
            placeholder="dashboard_local_note"
          />
        </label>
        <label className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
            Artifact type
          </div>
          <select
            className="w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
            value={form.artifact_type}
            onChange={(e) =>
              updateArtifactType(e.target.value === "code" ? "code" : "prose")
            }
          >
            <option value="prose">prose</option>
            <option value="code">code</option>
          </select>
        </label>
        <label className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
            Artifact filename
          </div>
          <input
            className="w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
            value={form.artifact_filename}
            onChange={(e) =>
              setForm((current) => ({ ...current, artifact_filename: e.target.value }))
            }
            placeholder="draft.md"
          />
        </label>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <label className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
            Seed content
          </div>
          <textarea
            className="min-h-40 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
            value={form.seed_content}
            onChange={(e) =>
              setForm((current) => ({ ...current, seed_content: e.target.value }))
            }
            placeholder="Initial file content"
          />
        </label>
        <div className="grid gap-4">
          <label className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
              Task brief
            </div>
            <textarea
              className="min-h-28 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
              value={form.brief.target_spec}
              onChange={(e) => updateBriefField("target_spec", e.target.value)}
              placeholder="Describe the task"
            />
          </label>
          <label className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
              Success criteria
            </div>
            <textarea
              className="min-h-28 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
              value={formatLineList(form.brief.success_criteria)}
              onChange={(e) => updateBriefField("success_criteria", parseLineList(e.target.value))}
              placeholder="One criterion per line"
            />
          </label>
          <label className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
              Constraints
            </div>
            <textarea
              className="min-h-28 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
              value={formatLineList(form.brief.constraints)}
              onChange={(e) => updateBriefField("constraints", parseLineList(e.target.value))}
              placeholder="Optional constraints, one per line"
            />
          </label>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <label className="space-y-1">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
            <span>Model pool</span>
            <span className="normal-case tracking-normal text-stone-400">{modelPoolLabel}</span>
          </div>
          <textarea
            className="min-h-32 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
            value={formatLineList(form.model_pool)}
            onChange={(e) =>
              setForm((current) => ({ ...current, model_pool: parseLineList(e.target.value) }))
            }
            placeholder="Leave blank to use the default pool"
          />
        </label>
        <label className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
            Frame pool
          </div>
          <textarea
            className="min-h-32 w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
            value={formatLineList(form.frame_pool)}
            onChange={(e) =>
              setForm((current) => ({ ...current, frame_pool: parseLineList(e.target.value) }))
            }
            placeholder="Optional, one frame per line"
          />
        </label>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
        <label className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
            Grader ref
          </div>
          <select
            className="w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
            value={form.grader.kind}
            onChange={(e) =>
              setForm((current) => ({
                ...current,
                grader:
                  e.target.value === "registered"
                    ? {
                        kind: "registered",
                        key: current.grader.kind === "registered" ? current.grader.key : graders[0]?.key ?? "",
                      }
                    : { kind: "none" },
              }))
            }
          >
            <option value="none">none</option>
            <option value="registered">registered</option>
          </select>
        </label>
        {hasRegisteredGrader ? (
          <label className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
              Registered grader key
            </div>
            <select
              className="w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
              value={form.grader.kind === "registered" ? form.grader.key : ""}
              onChange={(e) =>
                setForm((current) => ({
                  ...current,
                  grader:
                    current.grader.kind === "registered"
                      ? { kind: "registered", key: e.target.value }
                      : current.grader,
                }))
              }
            >
              <option value="">pick a grader</option>
              {graders.map((grader) => (
                <option key={grader.key} value={grader.key}>
                  {grader.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="rounded-xl border border-dashed border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-500">
            Leave the grader unset to save a task without a grader.
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="rounded-full bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800"
          onClick={() => void handleSubmit()}
        >
          Save task
        </button>
        {error ? <p className="text-sm text-rose-600">{error}</p> : null}
        {status ? <p className="text-sm text-emerald-700">{status}</p> : null}
      </div>
    </div>
  );
}

export function TasksSection({
  tasks,
  selectedTaskName,
  onSelectTask,
  onCreateTask,
  onRefreshTasks,
  graders,
  graderConfigs,
}: {
  tasks: TaskSummary[];
  selectedTaskName: string | null;
  onSelectTask: (name: string | null) => void;
  onCreateTask: (name: string) => void;
  onRefreshTasks: () => Promise<void>;
  graders: GraderSummary[];
  graderConfigs: GraderConfigDraft[];
}) {
  const detail = useTaskDetail(selectedTaskName);
  async function handleDelete(taskName: string) {
    if (typeof window !== "undefined" && !window.confirm(`Delete ${taskName}?`)) {
      return;
    }
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskName)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        return;
      }
      await onRefreshTasks();
      if (selectedTaskName === taskName) {
        onSelectTask(null);
      }
    } catch {
      // ignore delete failures; the task list will refresh on the next poll
    }
  }

  async function handleCreate(form: TaskDraftFormState): Promise<string> {
    const sanitized = sanitizeTaskDraftForm(form);
    const payload = taskDraftFormToPayload(sanitized);
    if ("error" in payload) {
      throw new Error(payload.error);
    }
    const parsed = TaskDraftSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(parsed.error.issues[0]?.message ?? "invalid task draft");
    }
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        const json = JSON.parse(text) as { error?: unknown; details?: unknown };
        if (typeof json.error === "string") {
          message = json.error;
        }
        if (json.details !== undefined) {
          message = `${message}: ${JSON.stringify(json.details)}`;
        }
      } catch {
        // leave raw response text in place
      }
      throw new Error(`Task creation failed (${response.status}): ${message}`);
    }
    const created = TaskDetailSchema.parse(await response.json());
    await onRefreshTasks();
    onSelectTask(created.name);
    onCreateTask(created.name);
    return created.name;
  }

  return (
    <section className="space-y-6 p-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-stone-950">Tasks</h2>
          <p className="text-sm text-stone-500">
            Inspect built-in and local tasks, then save new local tasks directly from the dashboard.
          </p>
        </div>
        <Badge label={`${tasks.length} tasks`} tone="slate" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <div className={sectionCardClass("p-4")}>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-stone-400">
              Catalog
            </h3>
            <Badge label="Live" tone="green" />
          </div>
          <div className="space-y-2">
            {tasks.map((task) => {
              const selected = task.name === selectedTaskName;
              return (
                <button
                  key={task.name}
                  type="button"
                  onClick={() => onSelectTask(task.name)}
                  className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                    selected
                      ? "border-sky-300 bg-sky-50"
                      : "border-stone-200 bg-white hover:border-stone-300 hover:bg-stone-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-stone-900">
                        {task.name}
                      </div>
                      <div className="text-xs text-stone-500">
                        {task.artifact_type} · {task.artifact_filename}
                      </div>
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                      {taskSummaryStateLabels(task, graders, graderConfigs).map((label) => (
                        <Badge key={label} label={label} tone={toneForLabel(label)} />
                      ))}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-6">
          {detail === null ? (
            <EmptyMessage>Select a task to inspect its brief and launchability.</EmptyMessage>
          ) : (
            <TaskDetailPanel
              detail={detail}
              graders={graders}
              graderConfigs={graderConfigs}
              onDelete={handleDelete}
            />
          )}
        </div>
      </div>

      <TaskCreateForm graders={graders} onCreate={handleCreate} />
    </section>
  );
}
