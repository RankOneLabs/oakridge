import { useEffect, useMemo, useState } from "react";

import { Badge } from "../atoms/Badge";
import { EmptyMessage } from "../atoms/EmptyMessage";
import type {
  GraderConfigDraft,
  GraderSummary,
  TaskDetail,
  TaskSummary,
} from "../../lib/types";
import { graderConfigRequirementLabel } from "../../lib/taskSelectors";
import { useTaskDetail } from "../../hooks/useTaskDetail";

function sectionCardClass(extra = ""): string {
  return `rounded-2xl border border-stone-200 bg-white shadow-sm ${extra}`;
}

function parseConfigJson(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "config must be a JSON object" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: "config must be valid JSON" };
  }
}

function ConfigCard({
  grader,
}: {
  grader: GraderSummary;
}) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-stone-900">{grader.label}</div>
          <div className="text-sm text-stone-500">{grader.key}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge label="Built-in" tone="slate" />
          <Badge
            label={graderConfigRequirementLabel(grader)}
            tone={grader.config_required ? "amber" : "green"}
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {grader.supported_artifact_types.map((type) => (
          <Badge key={type} label={type} tone="sky" />
        ))}
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {grader.capabilities.map((capability) => (
          <li key={capability}>
            <Badge label={capability} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function LocalConfigRow({
  config,
  onDelete,
}: {
  config: GraderConfigDraft;
  onDelete: (taskName: string) => Promise<void>;
}) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-stone-900">{config.task_name}</div>
          <div className="text-sm text-stone-500">{config.grader_key}</div>
        </div>
        <button
          type="button"
          className="rounded-full border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
          onClick={() => void onDelete(config.task_name)}
        >
          Delete
        </button>
      </div>
      <pre className="mt-3 overflow-x-auto rounded-xl bg-stone-950 px-4 py-3 text-xs leading-5 text-stone-100">
        {JSON.stringify(config.config, null, 2)}
      </pre>
    </div>
  );
}

function taskGraderKey(task: TaskDetail | null): string | null {
  if (task === null) return null;
  if (task.source === "local") {
    return task.grader.kind === "registered" ? task.grader.key : null;
  }
  return task.grader_key;
}

export function GradersSection({
  tasks,
  selectedTaskName,
  onSelectTask,
  graders,
  graderConfigs,
  onRefreshGraderData,
}: {
  tasks: TaskSummary[];
  selectedTaskName: string | null;
  onSelectTask: (name: string | null) => void;
  graders: GraderSummary[];
  graderConfigs: GraderConfigDraft[];
  onRefreshGraderData: () => Promise<void>;
}) {
  const [taskName, setTaskName] = useState("");
  const [graderKey, setGraderKey] = useState("");
  const [configJson, setConfigJson] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const activeTaskName = taskName.trim() === "" ? selectedTaskName : taskName;
  const taskDetail = useTaskDetail(activeTaskName);

  const selectedConfig = useMemo(
    () => graderConfigs.find((entry) => entry.task_name === activeTaskName) ?? null,
    [activeTaskName, graderConfigs],
  );

  useEffect(() => {
    if (selectedTaskName === null) return;
    setTaskName(selectedTaskName);
  }, [selectedTaskName]);

  useEffect(() => {
    if (taskName === "") return;
    const task = tasks.find((entry) => entry.name === taskName);
    if (task === undefined) return;
    const detailGraderKey = taskGraderKey(taskDetail);
    if (detailGraderKey !== null) {
      setGraderKey(detailGraderKey);
    } else if (graderKey === "" && graders.length > 0) {
      setGraderKey(graders[0]!.key);
    }
    if (selectedConfig !== null) {
      setConfigJson(JSON.stringify(selectedConfig.config, null, 2));
    } else {
      setConfigJson("{}");
    }
  }, [graderKey, graders, selectedConfig, taskDetail, taskName, tasks]);

  async function handleDelete(task_name: string) {
    try {
      const response = await fetch(`/api/grader-configs/${encodeURIComponent(task_name)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        return;
      }
      setStatus(`Deleted ${task_name}`);
      await onRefreshGraderData();
      if (taskName === task_name) {
        setConfigJson("{}");
      }
    } catch {
      // ignore delete failures; the catalog will refresh on the next poll
    }
  }

  async function handleSave() {
    setError(null);
    setStatus(null);
    if (taskName.trim() === "") {
      setError("task_name is required");
      return;
    }
    if (graderKey.trim() === "") {
      setError("grader_key is required");
      return;
    }
    const parsed = parseConfigJson(configJson);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    try {
      const response = await fetch("/api/grader-configs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_name: taskName,
          grader_key: graderKey,
          config: parsed.value,
        }),
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
          // fall back to raw body text
        }
        setError(`Config save failed (${response.status}): ${message}`);
        return;
      }
      const saved = (await response.json()) as GraderConfigDraft;
      setStatus(`Saved ${saved.task_name}`);
      await onRefreshGraderData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function resetForm() {
    setError(null);
    setStatus(null);
    if (selectedTaskName !== null) {
      setTaskName(selectedTaskName);
    } else {
      setTaskName("");
    }
    setGraderKey(taskGraderKey(taskDetail) ?? graders[0]?.key ?? "");
    setConfigJson(selectedConfig !== null ? JSON.stringify(selectedConfig.config, null, 2) : "{}");
  }

  return (
    <section className="space-y-6 p-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-stone-950">Graders</h2>
          <p className="text-sm text-stone-500">
            Inspect registered grader capabilities and manage inert local grader config JSON.
          </p>
        </div>
        <Badge label={`${graders.length} registered`} tone="slate" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <div className={sectionCardClass("p-4")}>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-stone-400">
              Registered capabilities
            </h3>
            <Badge label="Read only" tone="slate" />
          </div>
          <div className="space-y-3">
            {graders.map((grader) => (
              <ConfigCard key={grader.key} grader={grader} />
            ))}
          </div>
        </div>

        <div className="space-y-6">
          {taskDetail === null ? (
            <EmptyMessage>Select a task to author or inspect a local grader config.</EmptyMessage>
          ) : (
            <div className={sectionCardClass("p-5")}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-stone-900">Local grader config</h3>
                  <p className="text-sm text-stone-500">
                    This JSON is inert. The backend validates it before saving.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge label={taskDetail.source === "builtin" ? "Built-in" : "Saved"} tone="slate" />
                  <Badge
                    label={taskGraderKey(taskDetail) ?? "no grader"}
                    tone={taskGraderKey(taskDetail) !== null ? "sky" : "amber"}
                  />
                </div>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <label className="space-y-1">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
                    Task
                  </div>
                  <select
                    className="w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
                    value={taskName}
                    onChange={(e) => {
                      setTaskName(e.target.value);
                      onSelectTask(e.target.value === "" ? null : e.target.value);
                    }}
                  >
                    <option value="">pick a task</option>
                    {tasks.map((task) => (
                      <option key={task.name} value={task.name}>
                        {task.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="space-y-1">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
                    Grader key
                  </div>
                  <select
                    className="w-full rounded-xl border border-stone-300 px-3 py-2 text-sm"
                    value={graderKey}
                    onChange={(e) => setGraderKey(e.target.value)}
                  >
                    <option value="">pick a grader</option>
                    {graders.map((grader) => (
                      <option key={grader.key} value={grader.key}>
                        {grader.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="mt-4 block space-y-1">
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
                  Config JSON
                </div>
                <textarea
                  className="min-h-60 w-full rounded-xl border border-stone-300 px-3 py-2 font-mono text-xs leading-5"
                  value={configJson}
                  onChange={(e) => setConfigJson(e.target.value)}
                  placeholder='{"judge_model":"claude-sonnet-4-5"}'
                />
              </label>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="rounded-full bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-800"
                  onClick={() => void handleSave()}
                >
                  Save config
                </button>
                <button
                  type="button"
                  className="rounded-full border border-stone-200 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
                  onClick={resetForm}
                >
                  Reset
                </button>
                {selectedConfig !== null ? (
                  <button
                    type="button"
                    className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100"
                    onClick={() => void handleDelete(selectedConfig.task_name)}
                  >
                    Delete saved config
                  </button>
                ) : null}
                {error ? <p className="text-sm text-rose-600">{error}</p> : null}
                {status ? <p className="text-sm text-emerald-700">{status}</p> : null}
              </div>
            </div>
          )}

          <div className={sectionCardClass("p-5")}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-stone-400">
                  Saved local configs
                </h3>
                <p className="text-sm text-stone-500">
                  These are the inert JSON drafts the backend will load for matching tasks.
                </p>
              </div>
              <Badge label={`${graderConfigs.length} saved`} tone="green" />
            </div>
            <div className="mt-4 space-y-3">
              {graderConfigs.length > 0 ? (
                graderConfigs.map((config) => (
                  <LocalConfigRow
                    key={config.task_name}
                    config={config}
                    onDelete={handleDelete}
                  />
                ))
              ) : (
                <EmptyMessage>No local grader configs saved yet.</EmptyMessage>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
