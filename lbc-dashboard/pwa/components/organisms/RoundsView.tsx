import { EmptyMessage } from "../atoms/EmptyMessage";
import { modelDisplay } from "../../lib/modelSelectors";
import { buildRunTimeline } from "../../lib/runTimelineSelectors";
import type { RunTimelineInput } from "../../lib/runTimelineSelectors";
import type { AgentModelSummary } from "../../lib/types";

interface RoundsViewProps {
  input: RunTimelineInput;
}

function agentModel(
  agentId: string,
  agents: AgentModelSummary[],
): string {
  const entry = agents.find((a) => a.agent_id === agentId);
  if (entry === undefined || entry.model_id === null) return agentId.slice(-8);
  return modelDisplay(entry.model_id).name;
}

export function RoundsView({ input }: RoundsViewProps) {
  const timeline = buildRunTimeline(input);
  const agents = input.metadata?.agents ?? [];

  const hasAnyData =
    timeline.incremental_updates.length > 0 ||
    timeline.consensus_rounds.length > 0 ||
    timeline.escalation !== null ||
    timeline.picked_proposal !== null;

  if (!hasAnyData) {
    return (
      <EmptyMessage>
        No multi-round consensus data for this cell — either it ran as{" "}
        <code>single_agent</code> or is a historical cell recorded before
        round events were emitted.
      </EmptyMessage>
    );
  }

  const rawPicked = timeline.picked_proposal?.payload ?? {};
  const pickedAgentId =
    typeof (rawPicked as Record<string, unknown>).agent_id === "string"
      ? ((rawPicked as Record<string, unknown>).agent_id as string)
      : null;
  const pickedRationale =
    typeof (rawPicked as Record<string, unknown>).rationale === "string"
      ? ((rawPicked as Record<string, unknown>).rationale as string)
      : null;
  const pickedConvergedAt =
    typeof (rawPicked as Record<string, unknown>).converged_at_round === "number"
      ? ((rawPicked as Record<string, unknown>).converged_at_round as number)
      : null;

  return (
    <div className="space-y-6">
      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
        <strong>Note:</strong> The harness does not persist full per-round
        proposal bodies. This view shows that rounds occurred and which
        proposal was finally applied — not every round&apos;s full output.
      </div>

      <PhaseSummary
        nIncrementalUpdates={timeline.incremental_updates.length}
        nConsensusRounds={timeline.consensus_rounds.length}
        hasEscalation={timeline.escalation !== null}
        hasPick={timeline.picked_proposal !== null}
      />

      {timeline.incremental_updates.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-stone-700">
            Incremental Updates
          </h2>
          <ol className="m-0 list-none space-y-2 p-0">
            {timeline.incremental_updates.map((u) => {
              const raw = u.event.payload as Record<string, unknown>;
              const agentId = typeof raw.agent_id === "string" ? raw.agent_id : null;
              const newVersion = typeof raw.new_version === "string" ? raw.new_version : null;
              return (
                <li
                  key={u.applyIndex}
                  className="rounded border border-stone-200 bg-white px-4 py-2 text-sm"
                >
                  <span className="font-mono text-stone-500">
                    #{u.applyIndex + 1}
                  </span>{" "}
                  <span className="text-stone-700">
                    {agentId !== null ? agentModel(agentId, agents) : "—"}
                  </span>
                  {newVersion !== null && (
                    <span className="ml-2 font-mono text-xs text-stone-500">
                      → {newVersion}
                    </span>
                  )}
                  {u.commit !== null && (
                    <span className="ml-2 text-xs text-stone-400">
                      commit v{String(u.commit.index).padStart(4, "0")}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {timeline.consensus_rounds.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-stone-700">
            Consensus Rounds
          </h2>
          <ol className="m-0 list-none space-y-2 p-0">
            {timeline.consensus_rounds.map((r, i) => (
              <li
                key={i}
                className="flex items-center gap-3 rounded border border-stone-200 bg-white px-4 py-2 text-sm"
              >
                <span className="font-mono text-stone-500">
                  Round {r.roundIndex}
                </span>
                <span
                  className={
                    r.converged
                      ? "text-emerald-700"
                      : "text-stone-500"
                  }
                >
                  {r.converged ? "converged" : "no consensus"}
                </span>
                <span className="text-xs text-stone-400">
                  {r.nProposals} proposal{r.nProposals === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {timeline.escalation !== null && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-stone-700">
            Escalation
          </h2>
          <div className="rounded border border-orange-200 bg-orange-50 px-4 py-2 text-sm text-orange-800">
            Consensus was not reached; a proposal was escalated for final
            selection.
          </div>
        </section>
      )}

      {timeline.picked_proposal !== null && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-stone-700">
            Final Pick
          </h2>
          <div className="rounded border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm">
            <div className="text-indigo-800">
              <span className="font-medium">
                {pickedAgentId !== null ? agentModel(pickedAgentId, agents) : "—"}
              </span>
              {pickedConvergedAt !== null && (
                <span className="ml-2 text-xs text-indigo-600">
                  converged at round {pickedConvergedAt}
                </span>
              )}
            </div>
            {pickedRationale !== null && pickedRationale !== "" && (
              <p className="mt-1 text-indigo-700">{pickedRationale}</p>
            )}
            {timeline.final_apply !== null && (
              <FinalApply event={timeline.final_apply} agents={agents} />
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function PhaseSummary({
  nIncrementalUpdates,
  nConsensusRounds,
  hasEscalation,
  hasPick,
}: {
  nIncrementalUpdates: number;
  nConsensusRounds: number;
  hasEscalation: boolean;
  hasPick: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-3 text-sm">
      <Chip label="Incremental" value={`${nIncrementalUpdates} updates`} />
      <Chip label="Consensus" value={`${nConsensusRounds} round${nConsensusRounds === 1 ? "" : "s"}`} />
      {hasEscalation && <Chip label="Escalated" value="yes" highlight />}
      {hasPick && <Chip label="Pick" value="resolved" />}
    </div>
  );
}

function Chip({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <span
      className={`rounded px-2 py-1 ${
        highlight
          ? "bg-orange-100 text-orange-800"
          : "bg-stone-100 text-stone-700"
      }`}
    >
      <span className="font-medium">{label}:</span> {value}
    </span>
  );
}

function FinalApply({
  event,
  agents,
}: {
  event: { payload: Record<string, unknown> };
  agents: AgentModelSummary[];
}) {
  const raw = event.payload;
  const agentId = typeof raw.agent_id === "string" ? raw.agent_id : null;
  const newVersion = typeof raw.new_version === "string" ? raw.new_version : null;
  return (
    <div className="mt-2 border-t border-indigo-200 pt-2 text-xs text-indigo-600">
      Applied by {agentId !== null ? agentModel(agentId, agents) : "—"}
      {newVersion !== null && (
        <span className="ml-1 font-mono">→ {newVersion}</span>
      )}
    </div>
  );
}
