import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SidebarProject } from "./Sidebar";
import type { RuntimeId } from "../../runtime-interface";
import { defaultPlannerModelForRuntime, defaultWorkerModelForRuntime } from "../../runtime";
import {
  defaultRuntimeIdForConfig,
  runtimeDescriptorsForConfig,
  useServerConfig,
} from "../hooks/useServerConfig";
import type {
  RuntimeDescriptor,
  RuntimeModelSelection,
} from "../types";

interface AddSpecModalProps {
  project: SidebarProject;
  onCreated: () => void;
  onCancel: () => void;
}

interface CreateSpecInput {
  title: string;
  notes: string | null;
  plannerModelSelection: RuntimeModelSelection;
  workerModelSelection: RuntimeModelSelection;
}

type Role = "planner" | "worker";

function isModelAllowed(runtime: RuntimeDescriptor, model: string): boolean {
  if (runtime.models.length === 0) return true;
  return runtime.models.some((option) => option.value === model);
}

function getRoleDefaultModel(role: Role, runtime: RuntimeDescriptor): string {
  const preferred =
    role === "planner"
      ? defaultPlannerModelForRuntime(runtime.id)
      : defaultWorkerModelForRuntime(runtime.id);
  if (isModelAllowed(runtime, preferred)) return preferred;
  if (isModelAllowed(runtime, "")) return "";
  return runtime.models[0]?.value ?? preferred;
}

function getRuntimeForSelection(
  runtimeDescriptors: RuntimeDescriptor[],
  defaultRuntimeId: RuntimeId,
  runtimeId: RuntimeId,
): RuntimeDescriptor {
  return (
    runtimeDescriptors.find((runtime) => runtime.id === runtimeId) ??
    runtimeDescriptors.find((runtime) => runtime.id === defaultRuntimeId) ??
    runtimeDescriptors[0]
  );
}

function initialSelectionForRole(
  role: Role,
  runtimeDescriptors: RuntimeDescriptor[],
  defaultRuntimeId: RuntimeId,
): RuntimeModelSelection {
  const runtime = getRuntimeForSelection(runtimeDescriptors, defaultRuntimeId, defaultRuntimeId);
  return {
    runtime: runtime.id,
    model: getRoleDefaultModel(role, runtime),
  };
}

function coerceSelection(
  role: Role,
  selection: RuntimeModelSelection,
  runtimeDescriptors: RuntimeDescriptor[],
  defaultRuntimeId: RuntimeId,
  runtimeTouched: boolean,
): RuntimeModelSelection {
  const nextRuntime = runtimeTouched
    ? getRuntimeForSelection(runtimeDescriptors, defaultRuntimeId, selection.runtime)
    : getRuntimeForSelection(runtimeDescriptors, defaultRuntimeId, defaultRuntimeId);
  const nextModel = isModelAllowed(nextRuntime, selection.model)
    ? selection.model
    : getRoleDefaultModel(role, nextRuntime);
  if (nextRuntime.id === selection.runtime && nextModel === selection.model) {
    return selection;
  }
  return {
    runtime: nextRuntime.id,
    model: nextModel,
  };
}

function modelOptionsForRuntime(runtime: RuntimeDescriptor): RuntimeDescriptor["models"] {
  if (runtime.models.length === 0) return [];
  if (runtime.models.some((option) => option.value === "")) return runtime.models;
  return [{ value: "", label: "default" }, ...runtime.models];
}

export function AddSpecModal({ project, onCreated, onCancel }: AddSpecModalProps) {
  const serverConfig = useServerConfig();
  const runtimeDescriptors = useMemo(
    () => runtimeDescriptorsForConfig(serverConfig),
    [serverConfig],
  );
  const defaultRuntimeId = useMemo(
    () => defaultRuntimeIdForConfig(serverConfig),
    [serverConfig],
  );
  const runtimeKey = useMemo(
    () =>
      runtimeDescriptors
        .map((runtime) => `${runtime.id}:${runtime.models.map((model) => model.value).join(",")}`)
        .join("\0"),
    [runtimeDescriptors],
  );
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [notesSource, setNotesSource] = useState<"text" | "file">("text");
  const [fileName, setFileName] = useState<string | null>(null);
  const [plannerSelection, setPlannerSelection] = useState<RuntimeModelSelection>(() =>
    initialSelectionForRole("planner", runtimeDescriptors, defaultRuntimeId),
  );
  const [workerSelection, setWorkerSelection] = useState<RuntimeModelSelection>(() =>
    initialSelectionForRole("worker", runtimeDescriptors, defaultRuntimeId),
  );
  const [plannerRuntimeTouched, setPlannerRuntimeTouched] = useState(false);
  const [workerRuntimeTouched, setWorkerRuntimeTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    setPlannerSelection((current) =>
      coerceSelection(
        "planner",
        current,
        runtimeDescriptors,
        defaultRuntimeId,
        plannerRuntimeTouched,
      ),
    );
  }, [defaultRuntimeId, plannerRuntimeTouched, runtimeKey, runtimeDescriptors]);

  useEffect(() => {
    setWorkerSelection((current) =>
      coerceSelection(
        "worker",
        current,
        runtimeDescriptors,
        defaultRuntimeId,
        workerRuntimeTouched,
      ),
    );
  }, [defaultRuntimeId, runtimeKey, runtimeDescriptors, workerRuntimeTouched]);

  const createMutation = useMutation({
    mutationFn: async (vars: CreateSpecInput) => {
      const body: {
        project_id: string;
        title: string;
        notes?: string;
        planner_model_selection: RuntimeModelSelection;
        worker_model_selection: RuntimeModelSelection;
      } = {
        project_id: project.id,
        title: vars.title,
        planner_model_selection: vars.plannerModelSelection,
        worker_model_selection: vars.workerModelSelection,
      };
      if (vars.notes !== null) body.notes = vars.notes;
      const res = await fetch("/specs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const respBody = (await res.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(
          typeof respBody?.error === "string"
            ? respBody.error
            : `server returned ${res.status}`,
        );
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["specs", { projectId: project.id }],
      });
    },
  });

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      setNotes(text);
      setFileName(file.name);
    } catch {
      setError("could not read file");
      setNotes("");
      setFileName(null);
    } finally {
      e.target.value = "";
    }
  }

  async function submit() {
    if (createMutation.isPending) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("title is required");
      return;
    }
    setError(null);
    try {
      const trimmedNotes = notes.trim();
      await createMutation.mutateAsync({
        title: trimmedTitle,
        notes: trimmedNotes === "" ? null : trimmedNotes,
        plannerModelSelection: plannerSelection,
        workerModelSelection: workerSelection,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    }
  }

  const pending = createMutation.isPending;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={() => {
        if (!pending) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-spec-title"
        className="add-spec-modal"
        style={{
          background: "var(--bg-surface, #1e1e1e)",
          border: "1px solid var(--border-subtle, #444)",
          borderRadius: 8,
          padding: 24,
          width: "min(560px, 90vw)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          boxSizing: "border-box",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div id="add-spec-title" style={{ fontWeight: 600, fontSize: 15 }}>
          New plan / epic -- <span style={{ opacity: 0.7 }}>{project.name}</span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{ display: "flex", flexDirection: "column", gap: 16 }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span style={{ opacity: 0.8 }}>Title</span>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short one-line summary"
              spellCheck={false}
              disabled={pending}
              autoFocus
            />
          </label>

          <div className="add-spec-modal__roles">
            <section className="add-spec-modal__role">
              <div className="add-spec-modal__role-title">Planner</div>
              <label className="add-spec-modal__field">
                <span>Runtime</span>
                <select
                  value={plannerSelection.runtime}
                  onChange={(e) => {
                    const nextRuntimeId = e.target.value as RuntimeId;
                    const nextRuntime = getRuntimeForSelection(
                      runtimeDescriptors,
                      defaultRuntimeId,
                      nextRuntimeId,
                    );
                    setPlannerRuntimeTouched(true);
                    setPlannerSelection({
                      runtime: nextRuntime.id,
                      model: getRoleDefaultModel("planner", nextRuntime),
                    });
                  }}
                  disabled={pending}
                  aria-label="Planner runtime"
                >
                  {runtimeDescriptors.map((runtime) => (
                    <option key={runtime.id} value={runtime.id}>
                      {runtime.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="add-spec-modal__field">
                <span>Model</span>
                {modelOptionsForRuntime(
                  getRuntimeForSelection(runtimeDescriptors, defaultRuntimeId, plannerSelection.runtime),
                ).length > 0 ? (
                  <select
                    value={plannerSelection.model}
                    onChange={(e) =>
                      setPlannerSelection((current) => ({
                        ...current,
                        model: e.target.value,
                      }))
                    }
                    disabled={pending}
                    aria-label="Planner model"
                  >
                    {modelOptionsForRuntime(
                      getRuntimeForSelection(runtimeDescriptors, defaultRuntimeId, plannerSelection.runtime),
                    ).map((option) => (
                      <option key={option.value || "default"} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={plannerSelection.model}
                    onChange={(e) =>
                      setPlannerSelection((current) => ({
                        ...current,
                        model: e.target.value,
                      }))
                    }
                    disabled={pending}
                    aria-label="Planner model"
                    spellCheck={false}
                  />
                )}
              </label>
            </section>

            <section className="add-spec-modal__role">
              <div className="add-spec-modal__role-title">Worker</div>
              <label className="add-spec-modal__field">
                <span>Runtime</span>
                <select
                  value={workerSelection.runtime}
                  onChange={(e) => {
                    const nextRuntimeId = e.target.value as RuntimeId;
                    const nextRuntime = getRuntimeForSelection(
                      runtimeDescriptors,
                      defaultRuntimeId,
                      nextRuntimeId,
                    );
                    setWorkerRuntimeTouched(true);
                    setWorkerSelection({
                      runtime: nextRuntime.id,
                      model: getRoleDefaultModel("worker", nextRuntime),
                    });
                  }}
                  disabled={pending}
                  aria-label="Worker runtime"
                >
                  {runtimeDescriptors.map((runtime) => (
                    <option key={runtime.id} value={runtime.id}>
                      {runtime.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="add-spec-modal__field">
                <span>Model</span>
                {modelOptionsForRuntime(
                  getRuntimeForSelection(runtimeDescriptors, defaultRuntimeId, workerSelection.runtime),
                ).length > 0 ? (
                  <select
                    value={workerSelection.model}
                    onChange={(e) =>
                      setWorkerSelection((current) => ({
                        ...current,
                        model: e.target.value,
                      }))
                    }
                    disabled={pending}
                    aria-label="Worker model"
                  >
                    {modelOptionsForRuntime(
                      getRuntimeForSelection(runtimeDescriptors, defaultRuntimeId, workerSelection.runtime),
                    ).map((option) => (
                      <option key={option.value || "default"} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={workerSelection.model}
                    onChange={(e) =>
                      setWorkerSelection((current) => ({
                        ...current,
                        model: e.target.value,
                      }))
                    }
                    disabled={pending}
                    aria-label="Worker model"
                    spellCheck={false}
                  />
                )}
              </label>
            </section>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ opacity: 0.8 }}>Notes (optional)</span>
              <div role="group" aria-label="Notes source" style={{ display: "flex", gap: 4 }}>
                <button
                  type="button"
                  aria-pressed={notesSource === "text"}
                  disabled={pending}
                  onClick={() => setNotesSource("text")}
                  style={{ fontSize: 12, opacity: notesSource === "text" ? 1 : 0.6 }}
                >
                  Write
                </button>
                <button
                  type="button"
                  aria-pressed={notesSource === "file"}
                  disabled={pending}
                  onClick={() => {
                    setNotesSource("file");
                    if (fileName === null) setNotes("");
                  }}
                  style={{ fontSize: 12, opacity: notesSource === "file" ? 1 : 0.6 }}
                >
                  Upload file
                </button>
              </div>
            </div>
            {notesSource === "text" ? (
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={6}
                placeholder="Optional context, assumptions, or constraints"
                disabled={pending}
                aria-label="Notes"
              />
            ) : (
              <>
                <input
                  type="file"
                  accept=".md,.txt,.json,.yaml,.yml,.csv,.adoc,.rst,text/plain,text/markdown,application/json"
                  onChange={handleFileChange}
                  disabled={pending}
                  aria-label="Notes file"
                />
                {fileName !== null && (
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    Loaded {fileName} — {notes.length} chars
                  </div>
                )}
                <textarea
                  value={notes}
                  readOnly
                  rows={6}
                  placeholder="Uploaded file contents preview"
                  aria-label="Notes preview"
                />
              </>
            )}
          </div>
          {error && (
            <div role="alert" style={{ color: "var(--danger-fg)" }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" onClick={onCancel} disabled={pending}>
              Cancel
            </button>
            <button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
