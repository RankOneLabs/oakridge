import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SidebarProject } from "./Sidebar";
import type { RuntimeId } from "../../runtime-interface";
import { useServerConfig, type ServerConfig } from "../hooks/useServerConfig";

interface AddSpecModalProps {
  project: SidebarProject;
  onCreated: () => void;
  onCancel: () => void;
}

interface CreateSpecInput {
  title: string;
  notes: string | null;
  agentRuntime: RuntimeId;
}

interface AgentRuntimeSelection {
  runtimeIds: RuntimeId[];
  hasCodex: boolean;
  hasClaudeCode: boolean;
  defaultAgentRuntime: RuntimeId;
}

function selectAgentRuntimeDefaults(
  serverConfig: ServerConfig | null,
): AgentRuntimeSelection {
  const runtimeIds = serverConfig?.runtimes.map((runtime) => runtime.id) ?? ["claude-code"];
  const defaultAgentRuntime =
    serverConfig?.defaultRuntimeId && runtimeIds.includes(serverConfig.defaultRuntimeId)
      ? serverConfig.defaultRuntimeId
      : (runtimeIds[0] ?? "claude-code");
  return {
    runtimeIds,
    hasCodex: runtimeIds.includes("codex"),
    hasClaudeCode: runtimeIds.includes("claude-code"),
    defaultAgentRuntime,
  };
}

export function AddSpecModal({ project, onCreated, onCancel }: AddSpecModalProps) {
  const serverConfig = useServerConfig();
  const { runtimeIds, hasCodex, hasClaudeCode, defaultAgentRuntime } = useMemo(
    () => selectAgentRuntimeDefaults(serverConfig),
    [serverConfig],
  );
  const runtimeKey = runtimeIds.join("\0");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [notesSource, setNotesSource] = useState<"text" | "file">("text");
  const [fileName, setFileName] = useState<string | null>(null);
  const [agentRuntime, setAgentRuntime] = useState<RuntimeId>(defaultAgentRuntime);
  const [agentRuntimeTouched, setAgentRuntimeTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!runtimeIds.includes(agentRuntime)) {
      setAgentRuntime(defaultAgentRuntime);
      setAgentRuntimeTouched(false);
      return;
    }
    if (agentRuntimeTouched) return;
    setAgentRuntime(defaultAgentRuntime);
  }, [agentRuntime, agentRuntimeTouched, defaultAgentRuntime, runtimeKey]);

  const createMutation = useMutation({
    mutationFn: async (vars: CreateSpecInput) => {
      const body: { project_id: string; title: string; notes?: string; agent_runtime: RuntimeId } = {
        project_id: project.id,
        title: vars.title,
        agent_runtime: vars.agentRuntime,
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
        agentRuntime,
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
            <span style={{ opacity: 0.8 }}>Agent</span>
            <select
              value={agentRuntime}
              onChange={(e) => {
                setAgentRuntimeTouched(true);
                setAgentRuntime(e.target.value as RuntimeId);
              }}
              disabled={pending}
              aria-label="Agent"
            >
              {hasClaudeCode && <option value="claude-code">Claude Code</option>}
              {hasCodex && <option value="codex">Codex</option>}
            </select>
          </label>
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
                  onClick={() => setNotesSource("file")}
                  style={{ fontSize: 12, opacity: notesSource === "file" ? 1 : 0.6 }}
                >
                  Upload file
                </button>
              </div>
            </div>
            {notesSource === "text" ? (
              <textarea
                value={notes}
                onChange={(e) => {
                  setNotes(e.target.value);
                  setFileName(null);
                }}
                placeholder="Context, constraints, links — anything plan_writer should know."
                rows={10}
                style={{ fontSize: 13, resize: "vertical", width: "100%", boxSizing: "border-box" }}
                disabled={pending}
                aria-label="Notes"
              />
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <input
                  type="file"
                  accept=".md,.markdown,.txt,text/markdown,text/plain,text/*"
                  aria-label="Notes file"
                  disabled={pending}
                  onChange={handleFileChange}
                />
                {fileName && (
                  <div style={{ opacity: 0.7 }}>
                    Loaded {fileName} — {notes.length} chars
                  </div>
                )}
                {notes && (
                  <textarea
                    value={notes}
                    readOnly
                    rows={8}
                    style={{
                      fontSize: 13,
                      resize: "vertical",
                      width: "100%",
                      boxSizing: "border-box",
                      opacity: 0.8,
                    }}
                    aria-label="Notes preview"
                  />
                )}
              </div>
            )}
          </div>
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
