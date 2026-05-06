/**
 * Right-hand panel for the selected cell. Header (target ×
 * condition + tab bar) followed by the active tab's view.
 */
import ReactMarkdown from "react-markdown";

import { EmptyMessage } from "../atoms/EmptyMessage";
import { TabButton } from "../atoms/TabButton";
import { CommitCard } from "../molecules/CommitCard";
import { EventRow } from "../molecules/EventRow";
import { ScoreRow } from "../molecules/ScoreRow";
import type {
  CellDetail,
  CellEvent,
  CommitSnapshot,
  EvalScore,
  Tab,
} from "../../lib/types";

const TABS: Tab[] = ["events", "artifact", "commits", "scores"];

export function CellPanel({
  detail,
  events,
  artifact,
  commits,
  scores,
  tab,
  onTab,
}: {
  detail: CellDetail | null;
  events: CellEvent[];
  artifact: string | null;
  commits: CommitSnapshot[];
  scores: EvalScore[] | null;
  tab: Tab;
  onTab: (t: Tab) => void;
}) {
  return (
    <>
      <header className="border-b border-stone-300 bg-white px-6 py-4">
        <h1 className="m-0 text-xl">
          {detail
            ? `${detail.target_name} × ${detail.condition_name}`
            : "…"}
        </h1>
        {detail && (
          <div className="mt-1 text-xs text-stone-600">
            run {detail.run_ts} · {events.length} events ·{" "}
            {detail.commit_count} commits · {detail.status}
          </div>
        )}
        <nav className="mt-3 flex gap-4 border-b border-transparent">
          {TABS.map((t) => (
            <TabButton
              key={t}
              label={t}
              selected={tab === t}
              onClick={() => onTab(t)}
            />
          ))}
        </nav>
      </header>
      <section className="flex-1 overflow-auto p-6">
        {tab === "events" && <EventsView events={events} />}
        {tab === "artifact" && <ArtifactView content={artifact} />}
        {tab === "commits" && <CommitsView commits={commits} />}
        {tab === "scores" && <ScoresView scores={scores} />}
      </section>
    </>
  );
}

function EventsView({ events }: { events: CellEvent[] }) {
  if (events.length === 0) {
    return <EmptyMessage>No events yet.</EmptyMessage>;
  }
  return (
    <ol className="m-0 list-none p-0">
      {events.map((e, i) => (
        <EventRow key={i} event={e} />
      ))}
    </ol>
  );
}

function ArtifactView({ content }: { content: string | null }) {
  if (content === null) {
    return <EmptyMessage>No artifact yet.</EmptyMessage>;
  }
  return (
    <article className="prose prose-stone max-w-3xl">
      <ReactMarkdown>{content}</ReactMarkdown>
    </article>
  );
}

function CommitsView({ commits }: { commits: CommitSnapshot[] }) {
  if (commits.length === 0) {
    return <EmptyMessage>No commits yet.</EmptyMessage>;
  }
  return (
    <ol className="m-0 list-none p-0">
      {commits.map((c) => (
        <CommitCard key={c.index} commit={c} />
      ))}
    </ol>
  );
}

function ScoresView({ scores }: { scores: EvalScore[] | null }) {
  if (scores === null) {
    return (
      <EmptyMessage>
        No eval scores. Wire a <code>grader_factory</code> on{" "}
        <code>run_cell</code> to populate this tab.
      </EmptyMessage>
    );
  }
  if (scores.length === 0) {
    return <EmptyMessage>Grader ran but produced no scores.</EmptyMessage>;
  }
  const avg = scores.reduce((a, s) => a + s.value, 0) / scores.length;
  return (
    <div>
      <div className="mb-4 text-sm text-stone-600">
        average:{" "}
        <span className="font-mono tabular-nums text-stone-800">
          {avg.toFixed(3)}
        </span>{" "}
        across {scores.length} dimension{scores.length === 1 ? "" : "s"}
      </div>
      <ol className="m-0 list-none p-0">
        {scores.map((s, i) => (
          <ScoreRow key={i} score={s} />
        ))}
      </ol>
    </div>
  );
}
