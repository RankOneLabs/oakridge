import {
  Fragment,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

import type { Theme, SafirTask, SafirHandoff, TaskFetchState } from "../types";

type TaskQueryResult =
  | { kind: "ok"; task: SafirTask }
  | { kind: "not_found" }
  | { kind: "safir_down" }
  | { kind: "error"; status: number; message: string };

type HandoffsQueryResult =
  | { kind: "ok"; handoffs: SafirHandoff[] }
  | { kind: "safir_down" }
  | { kind: "error"; status: number; message: string };

export function TaskView({
  taskId,
  theme,
  safirWebUrl,
  onToggleTheme,
  onBack,
}: {
  taskId: number;
  theme: Theme;
  safirWebUrl: string;
  onToggleTheme: () => void;
  onBack: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const taskQuery = useQuery({
    queryKey: ["safir", "tasks", taskId],
    queryFn: async (): Promise<TaskQueryResult> => {
      const res = await fetch(`/safir/tasks/${taskId}`);
      if (res.status === 404) return { kind: "not_found" };
      if (res.status === 502) return { kind: "safir_down" };
      if (!res.ok) {
        return {
          kind: "error",
          status: res.status,
          message: `task fetch failed: HTTP ${res.status}`,
        };
      }
      const task = (await res.json()) as SafirTask;
      return { kind: "ok", task };
    },
    // 404/502 are mapped to specific kinds in the queryFn — retrying would
    // just delay the user-facing message. Network failures land in onError
    // and are treated as safir_down below.
    retry: false,
  });

  const hasTask = taskQuery.data?.kind === "ok";

  const handoffsQuery = useQuery({
    queryKey: ["safir", "tasks", taskId, "handoffs"],
    queryFn: async (): Promise<HandoffsQueryResult> => {
      const res = await fetch(`/safir/tasks/${taskId}/handoffs`);
      if (res.status === 502) return { kind: "safir_down" };
      if (!res.ok) {
        return {
          kind: "error",
          status: res.status,
          message: `handoffs fetch failed: HTTP ${res.status}`,
        };
      }
      const handoffs = (await res.json()) as SafirHandoff[];
      return { kind: "ok", handoffs };
    },
    retry: false,
    enabled: hasTask,
  });

  // Reset expanded set on taskId change so a previous task's expanded
  // handoff ids don't leak into the new view.
  useEffect(() => {
    setExpanded(new Set());
  }, [taskId]);

  const state: TaskFetchState = useMemo(() => {
    if (taskQuery.isPending || (hasTask && handoffsQuery.isPending)) {
      return { kind: "loading" };
    }
    if (taskQuery.isError || (hasTask && handoffsQuery.isError)) {
      // Network drop before kbbl could respond — treat as safir-down from
      // the operator's perspective (same as the old try/catch fallback).
      return { kind: "safir_down" };
    }
    const t = taskQuery.data;
    if (!t) return { kind: "loading" };
    if (t.kind !== "ok") return t;
    const h = handoffsQuery.data as HandoffsQueryResult | undefined;
    if (!h) return { kind: "loading" };
    if (h.kind === "safir_down") return { kind: "safir_down" };
    if (h.kind === "error") return h;
    return { kind: "ok", task: t.task, handoffs: h.handoffs };
  }, [hasTask, taskQuery.data, taskQuery.isError, taskQuery.isPending, handoffsQuery.data, handoffsQuery.isError, handoffsQuery.isPending]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className={`task-view theme-${theme}`}>
      <header className="task-view__header">
        <button type="button" className="task-view__back" onClick={onBack}>
          ← inbox
        </button>
        <span className="task-view__title">task #{taskId}</span>
        <a
          className="task-view__open-safir"
          href={`${safirWebUrl.replace(/\/+$/, "")}/tasks/${taskId}`}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open this task in safir"
          title="Open in safir"
        >
          open in safir ↗
        </a>
        <button
          type="button"
          className="task-view__theme"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? "☼" : "☾"}
        </button>
      </header>

      {state.kind === "loading" && (
        <div className="task-view__status">loading…</div>
      )}
      {state.kind === "not_found" && (
        <div className="task-view__status">
          task #{taskId} not found in safir
        </div>
      )}
      {state.kind === "safir_down" && (
        <div className="task-view__status">
          safir is unreachable — is it running on the configured port?
        </div>
      )}
      {state.kind === "error" && (
        <div className="task-view__status">{state.message}</div>
      )}
      {state.kind === "ok" && (
        <Fragment>
          <section className="task-view__meta">
            <h1>{state.task.title}</h1>
            <dl>
              <dt>project</dt>
              <dd>{state.task.project_id}</dd>
              <dt>status</dt>
              <dd>{state.task.status}</dd>
              {state.task.parent_id !== null && (
                <Fragment>
                  <dt>parent task</dt>
                  <dd>
                    <a
                      href={`#task=${state.task.parent_id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        window.location.hash = `task=${state.task.parent_id}`;
                      }}
                    >
                      #{state.task.parent_id}
                    </a>
                  </dd>
                </Fragment>
              )}
            </dl>
          </section>
          <section className="task-view__handoffs">
            <h2>handoffs ({state.handoffs.length})</h2>
            {state.handoffs.length === 0 && (
              <div className="task-view__status">no handoffs yet</div>
            )}
            {state.handoffs.map((h) => {
              const isOpen = expanded.has(h.id);
              return (
                <article
                  key={h.id}
                  className={`handoff-card${isOpen ? " handoff-card--open" : ""}`}
                >
                  <button
                    type="button"
                    className="handoff-card__summary"
                    onClick={() => toggle(h.id)}
                  >
                    <span className="handoff-card__ts">{h.produced_at}</span>
                    <span className="handoff-card__role">{h.role}</span>
                    {h.goal && (
                      <span className="handoff-card__goal">{h.goal}</span>
                    )}
                  </button>
                  {isOpen && (
                    <div className="handoff-card__body">
                      <Markdown rehypePlugins={[rehypeSanitize]}>
                        {h.raw_markdown}
                      </Markdown>
                    </div>
                  )}
                </article>
              );
            })}
          </section>
        </Fragment>
      )}
    </div>
  );
}
