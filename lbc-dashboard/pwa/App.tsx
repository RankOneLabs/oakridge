/**
 * Single-component dashboard app. Cell list on the left, detail
 * panel on the right with tabs for Events / Artifact / Commits.
 *
 * Selected cell tracked in URL hash (`#cell=<cell_id>`) so refreshes
 * preserve position and bookmarks work.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";

interface CellEvent {
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

interface CellSummary {
  cell_id: string;
  run_ts: string;
  target_name: string;
  condition_name: string;
  cell_dir: string;
  status: "active" | "ended";
  last_activity_ms: number;
  event_count: number;
}

interface CellDetail extends CellSummary {
  events: CellEvent[];
  artifact_filename: string | null;
  commit_count: number;
}

interface CommitSnapshot {
  index: number;
  filename: string;
  content: string;
}

type Tab = "events" | "artifact" | "commits";

// --- hooks ---------------------------------------------------------------

function useCellList(): {
  cells: CellSummary[];
  refresh: () => Promise<void>;
} {
  const [cells, setCells] = useState<CellSummary[]>([]);
  const refresh = useCallback(async () => {
    const r = await fetch("/api/cells");
    if (!r.ok) return;
    const data = (await r.json()) as { cells: CellSummary[] };
    setCells(data.cells);
  }, []);
  useEffect(() => {
    refresh();
    // Refresh the cell list every 2s so newly-spawned cells appear
    // without manual reload. Cheap; the endpoint is stat-driven.
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);
  return { cells, refresh };
}

function useHashSelection(): [string | null, (id: string) => void] {
  const [cellId, setCellId] = useState<string | null>(() => readHash());
  useEffect(() => {
    const onHash = () => setCellId(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const select = useCallback((id: string) => {
    window.location.hash = `cell=${id}`;
  }, []);
  return [cellId, select];
}

function readHash(): string | null {
  const h = window.location.hash.slice(1);
  for (const part of h.split("&")) {
    const [k, v] = part.split("=");
    if (k === "cell" && v) return decodeURIComponent(v);
  }
  return null;
}

/**
 * Live event stream via SSE. Replays existing events on connect, then
 * appends as new ones arrive. Resets when cellId changes.
 */
function useCellEvents(cellId: string | null): CellEvent[] {
  const [events, setEvents] = useState<CellEvent[]>([]);
  const cellIdRef = useRef(cellId);
  cellIdRef.current = cellId;
  useEffect(() => {
    if (!cellId) {
      setEvents([]);
      return;
    }
    setEvents([]);
    const es = new EventSource(
      `/api/cells/${encodeURIComponent(cellId)}/events`,
    );
    es.addEventListener("message", (ev) => {
      // Guard: a slow SSE response from a previously-selected cell
      // could land after the user picked a different cell.
      if (cellIdRef.current !== cellId) return;
      try {
        const evt = JSON.parse(ev.data) as CellEvent;
        setEvents((prev) => [...prev, evt]);
      } catch {
        // Skip malformed lines.
      }
    });
    return () => es.close();
  }, [cellId]);
  return events;
}

function useArtifact(cellId: string | null, refreshKey: number): string | null {
  const [content, setContent] = useState<string | null>(null);
  useEffect(() => {
    if (!cellId) {
      setContent(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/cells/${encodeURIComponent(cellId)}/artifact`)
      .then((r) => (r.ok ? r.json() : { content: null }))
      .then((data) => {
        if (!cancelled) setContent(data.content as string | null);
      })
      .catch(() => {
        if (!cancelled) setContent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cellId, refreshKey]);
  return content;
}

function useCommits(
  cellId: string | null,
  refreshKey: number,
): CommitSnapshot[] {
  const [commits, setCommits] = useState<CommitSnapshot[]>([]);
  useEffect(() => {
    if (!cellId) {
      setCommits([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/cells/${encodeURIComponent(cellId)}/commits`)
      .then((r) => (r.ok ? r.json() : { commits: [] }))
      .then((data) => {
        if (!cancelled) setCommits(data.commits as CommitSnapshot[]);
      })
      .catch(() => {
        if (!cancelled) setCommits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [cellId, refreshKey]);
  return commits;
}

// --- detail (returned by /api/cells/:id, refetched per event arrival) ---

function useCellDetail(
  cellId: string | null,
  refreshKey: number,
): CellDetail | null {
  const [detail, setDetail] = useState<CellDetail | null>(null);
  useEffect(() => {
    if (!cellId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/cells/${encodeURIComponent(cellId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setDetail(data as CellDetail | null);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cellId, refreshKey]);
  return detail;
}

// --- view ----------------------------------------------------------------

export function App() {
  const { cells } = useCellList();
  const [selectedId, select] = useHashSelection();
  const events = useCellEvents(selectedId);
  // Use the event count as the artifact/commits refresh-key — when a
  // new event lands the artifact may have changed, so re-fetch.
  const refreshKey = events.length;
  const detail = useCellDetail(selectedId, refreshKey);
  const artifact = useArtifact(selectedId, refreshKey);
  const commits = useCommits(selectedId, refreshKey);
  const [tab, setTab] = useState<Tab>("events");

  // Auto-select the first cell on initial load if nothing's hashed.
  useEffect(() => {
    if (selectedId === null && cells.length > 0) {
      select(cells[0].cell_id);
    }
  }, [selectedId, cells, select]);

  return (
    <div style={styles.app}>
      <aside style={styles.sidebar}>
        <h2 style={styles.sidebarTitle}>cells</h2>
        <ul style={styles.cellList}>
          {cells.map((c) => (
            <CellRow
              key={c.cell_id}
              cell={c}
              selected={c.cell_id === selectedId}
              onSelect={() => select(c.cell_id)}
            />
          ))}
        </ul>
        {cells.length === 0 && (
          <p style={styles.empty}>
            No cells yet. Run a project from{" "}
            <code>scripts/run_one_project.py</code>.
          </p>
        )}
      </aside>
      <main style={styles.main}>
        {selectedId === null ? (
          <p style={styles.empty}>Select a cell on the left.</p>
        ) : (
          <CellPanel
            detail={detail}
            events={events}
            artifact={artifact}
            commits={commits}
            tab={tab}
            onTab={setTab}
          />
        )}
      </main>
    </div>
  );
}

function CellRow({
  cell,
  selected,
  onSelect,
}: {
  cell: CellSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li
      onClick={onSelect}
      style={{
        ...styles.cellRow,
        background: selected ? "#dee5ef" : "transparent",
      }}
    >
      <div style={styles.cellRowTop}>
        <span style={styles.cellRowName}>{cell.target_name}</span>
        <span
          style={{
            ...styles.statusPill,
            background: cell.status === "active" ? "#3a7" : "#aaa",
          }}
        >
          {cell.status}
        </span>
      </div>
      <div style={styles.cellRowSub}>
        {cell.condition_name} · {cell.event_count} events
      </div>
      <div style={styles.cellRowSub}>{cell.run_ts}</div>
    </li>
  );
}

function CellPanel({
  detail,
  events,
  artifact,
  commits,
  tab,
  onTab,
}: {
  detail: CellDetail | null;
  events: CellEvent[];
  artifact: string | null;
  commits: CommitSnapshot[];
  tab: Tab;
  onTab: (t: Tab) => void;
}) {
  return (
    <>
      <header style={styles.header}>
        <h1 style={styles.headerTitle}>
          {detail ? `${detail.target_name} × ${detail.condition_name}` : "…"}
        </h1>
        {detail && (
          <div style={styles.headerSub}>
            run {detail.run_ts} · {events.length} events ·{" "}
            {detail.commit_count} commits · {detail.status}
          </div>
        )}
        <nav style={styles.tabs}>
          {(["events", "artifact", "commits"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => onTab(t)}
              style={{
                ...styles.tab,
                fontWeight: tab === t ? "bold" : "normal",
                borderBottom:
                  tab === t ? "2px solid #2c5282" : "2px solid transparent",
              }}
            >
              {t}
            </button>
          ))}
        </nav>
      </header>
      <section style={styles.body}>
        {tab === "events" && <EventsView events={events} />}
        {tab === "artifact" && <ArtifactView content={artifact} />}
        {tab === "commits" && <CommitsView commits={commits} />}
      </section>
    </>
  );
}

function EventsView({ events }: { events: CellEvent[] }) {
  if (events.length === 0) return <p style={styles.empty}>No events yet.</p>;
  return (
    <ol style={styles.eventList}>
      {events.map((e, i) => (
        <li key={i} style={styles.eventRow}>
          <span style={styles.eventTs}>
            {new Date(e.ts).toLocaleTimeString()}
          </span>
          <span style={styles.eventKind}>{e.kind}</span>
          <pre style={styles.eventPayload}>
            {JSON.stringify(e.payload, null, 2)}
          </pre>
        </li>
      ))}
    </ol>
  );
}

function ArtifactView({ content }: { content: string | null }) {
  if (content === null) {
    return <p style={styles.empty}>No artifact yet.</p>;
  }
  return (
    <article style={styles.artifact}>
      <ReactMarkdown>{content}</ReactMarkdown>
    </article>
  );
}

function CommitsView({ commits }: { commits: CommitSnapshot[] }) {
  if (commits.length === 0) return <p style={styles.empty}>No commits yet.</p>;
  return (
    <ol style={styles.commitsList}>
      {commits.map((c) => (
        <li key={c.index} style={styles.commitRow}>
          <h3 style={styles.commitName}>{c.filename}</h3>
          <pre style={styles.commitContent}>{c.content}</pre>
        </li>
      ))}
    </ol>
  );
}

// --- styles --------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: "flex",
    fontFamily:
      "-apple-system, system-ui, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    height: "100vh",
    margin: 0,
  },
  sidebar: {
    width: 280,
    borderRight: "1px solid #ccc",
    background: "#f5f7fa",
    overflow: "auto",
    padding: "12px 0",
  },
  sidebarTitle: {
    margin: "0 16px 12px",
    fontSize: 14,
    color: "#555",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  cellList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  cellRow: {
    cursor: "pointer",
    padding: "10px 16px",
    borderBottom: "1px solid #e6ebf2",
    fontSize: 13,
  },
  cellRowTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cellRowName: { fontWeight: 600 },
  cellRowSub: { fontSize: 11, color: "#666", marginTop: 2 },
  statusPill: {
    fontSize: 10,
    color: "white",
    padding: "2px 6px",
    borderRadius: 3,
    textTransform: "uppercase",
  },
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    padding: "16px 24px",
    borderBottom: "1px solid #ccc",
    background: "white",
  },
  headerTitle: { margin: 0, fontSize: 20 },
  headerSub: { fontSize: 12, color: "#666", marginTop: 4 },
  tabs: {
    display: "flex",
    gap: 16,
    marginTop: 12,
    borderBottom: "1px solid transparent",
  },
  tab: {
    background: "none",
    border: "none",
    padding: "6px 0",
    fontSize: 14,
    cursor: "pointer",
    color: "#333",
  },
  body: {
    flex: 1,
    overflow: "auto",
    padding: 24,
  },
  empty: { color: "#888", padding: 24, fontStyle: "italic" },
  eventList: { listStyle: "none", margin: 0, padding: 0 },
  eventRow: {
    padding: "8px 0",
    borderBottom: "1px solid #eee",
    fontSize: 13,
  },
  eventTs: { color: "#888", fontSize: 11, marginRight: 8 },
  eventKind: { fontWeight: 600 },
  eventPayload: {
    fontSize: 11,
    background: "#f5f7fa",
    padding: 8,
    margin: "4px 0 0",
    overflow: "auto",
  },
  artifact: { lineHeight: 1.6, maxWidth: 760 },
  commitsList: { listStyle: "none", margin: 0, padding: 0 },
  commitRow: { marginBottom: 24 },
  commitName: { fontSize: 14, color: "#555" },
  commitContent: {
    fontSize: 12,
    background: "#f5f7fa",
    padding: 12,
    overflow: "auto",
  },
};
