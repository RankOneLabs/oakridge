import {
  Fragment,
  useEffect,
  useState,
} from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

import type { Theme, SafirTask, SafirHandoff, TaskFetchState } from "../types";

async function fetchTaskAndHandoffs(taskId: number): Promise<TaskFetchState> {
  try {
    const [taskRes, handoffsRes] = await Promise.all([
      fetch(`/safir/tasks/${taskId}`),
      fetch(`/safir/tasks/${taskId}/handoffs`),
    ]);
    if (taskRes.status === 404) return { kind: "not_found" };
    if (taskRes.status === 502 || handoffsRes.status === 502) {
      return { kind: "safir_down" };
    }
    if (!taskRes.ok) {
      return {
        kind: "error",
        status: taskRes.status,
        message: `task fetch failed: HTTP ${taskRes.status}`,
      };
    }
    if (!handoffsRes.ok) {
      return {
        kind: "error",
        status: handoffsRes.status,
        message: `handoffs fetch failed: HTTP ${handoffsRes.status}`,
      };
    }
    const task = (await taskRes.json()) as SafirTask;
    const handoffs = (await handoffsRes.json()) as SafirHandoff[];
    return { kind: "ok", task, handoffs };
  } catch {
    // Network failure before kbbl could even respond — treat the same as
    // safir-down from the operator's perspective.
    return { kind: "safir_down" };
  }
}

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
  const [state, setState] = useState<TaskFetchState>({ kind: "loading" });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    setExpanded(new Set());
    fetchTaskAndHandoffs(taskId).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

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
