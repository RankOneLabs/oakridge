import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SidebarProject } from "./Sidebar";
import { useServerConfig } from "../hooks/useServerConfig";

interface AddSpecModalProps {
  project: SidebarProject;
  onCreated: () => void;
  onCancel: () => void;
}

interface CreateSpecInput {
  title: string;
  notes: string | null;
  planner_runtime?: string;
  planner_model?: string;
  build_runtime?: string;
  build_model?: string;
}

function encodeRoutingPair(runtime: string, model: string): string {
  return `${runtime}::${model}`;
}

function parseRoutingPair(encoded: string): { runtime: string; model: string } | null {
  const idx = encoded.indexOf("::");
  if (idx === -1) return null;
  return { runtime: encoded.slice(0, idx), model: encoded.slice(idx + 2) };
}

export function AddSpecModal({ project, onCreated, onCancel }: AddSpecModalProps) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  // null = untouched; set once user changes the select away from its initial position
  const [plannerValue, setPlannerValue] = useState<string | null>(null);
  const [buildValue, setBuildValue] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const config = useServerConfig();

  const plannerDefault = config
    ? encodeRoutingPair(config.stageDefaults.planner.runtime, config.stageDefaults.planner.model)
    : "";
  const buildDefault = config
    ? encodeRoutingPair(config.stageDefaults.build.runtime, config.stageDefaults.build.model)
    : "";

  const effectivePlannerValue = plannerValue ?? plannerDefault;
  const effectiveBuildValue = buildValue ?? buildDefault;

  const createMutation = useMutation({
    mutationFn: async (vars: CreateSpecInput) => {
      const body: {
        project_id: string;
        title: string;
        notes?: string;
        planner_runtime?: string;
        planner_model?: string;
        build_runtime?: string;
        build_model?: string;
      } = {
        project_id: project.id,
        title: vars.title,
      };
      if (vars.notes !== null) body.notes = vars.notes;
      if (vars.planner_runtime !== undefined) {
        body.planner_runtime = vars.planner_runtime;
        body.planner_model = vars.planner_model;
      }
      if (vars.build_runtime !== undefined) {
        body.build_runtime = vars.build_runtime;
        body.build_model = vars.build_model;
      }
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
      const input: CreateSpecInput = {
        title: trimmedTitle,
        notes: trimmedNotes === "" ? null : trimmedNotes,
      };
      // Include routing pair only when operator actively changed it from the default
      if (effectivePlannerValue && effectivePlannerValue !== plannerDefault) {
        const parsed = parseRoutingPair(effectivePlannerValue);
        if (parsed) {
          input.planner_runtime = parsed.runtime;
          input.planner_model = parsed.model;
        }
      }
      if (effectiveBuildValue && effectiveBuildValue !== buildDefault) {
        const parsed = parseRoutingPair(effectiveBuildValue);
        if (parsed) {
          input.build_runtime = parsed.runtime;
          input.build_model = parsed.model;
        }
      }
      await createMutation.mutateAsync(input);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    }
  }

  const pending = createMutation.isPending;
  const configLoaded = config !== null;

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
        style={{
          background: "var(--bg-surface, #1e1e1e)",
          border: "1px solid var(--border-subtle, #444)",
          borderRadius: 8,
          padding: 24,
          width: "min(480px, 90vw)",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          boxSizing: "border-box",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div id="add-spec-title" style={{ fontWeight: 600, fontSize: 15 }}>
          New plan / epic — <span style={{ opacity: 0.7 }}>{project.name}</span>
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
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span style={{ opacity: 0.8 }}>Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Context, constraints, links — anything plan_writer should know."
              rows={10}
              style={{ fontSize: 13, resize: "vertical", width: "100%", boxSizing: "border-box" }}
              disabled={pending}
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span style={{ opacity: 0.8 }}>Planner model</span>
            <select
              aria-label="Planner model"
              value={effectivePlannerValue}
              onChange={(e) => setPlannerValue(e.target.value)}
              disabled={pending || !configLoaded}
              style={{ fontSize: 13 }}
            >
              {!configLoaded && <option value="">loading models…</option>}
              {config?.runtimes.map((runtime) => (
                <optgroup key={runtime.id} label={runtime.label}>
                  {runtime.models.map((model) => (
                    <option
                      key={`${runtime.id}::${model.value}`}
                      value={`${runtime.id}::${model.value}`}
                    >
                      {model.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            <span style={{ opacity: 0.8 }}>Build model</span>
            <select
              aria-label="Build model"
              value={effectiveBuildValue}
              onChange={(e) => setBuildValue(e.target.value)}
              disabled={pending || !configLoaded}
              style={{ fontSize: 13 }}
            >
              {!configLoaded && <option value="">loading models…</option>}
              {config?.runtimes.map((runtime) => (
                <optgroup key={runtime.id} label={runtime.label}>
                  {runtime.models.map((model) => (
                    <option
                      key={`${runtime.id}::${model.value}`}
                      value={`${runtime.id}::${model.value}`}
                    >
                      {model.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {error && (
            <div style={{ color: "var(--danger-fg, #e67070)", fontSize: 13 }} role="alert">
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" onClick={onCancel} disabled={pending}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || !title.trim()}
            >
              {pending ? "Creating…" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
