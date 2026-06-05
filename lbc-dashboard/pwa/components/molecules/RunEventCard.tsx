import type { CellEvent, CellRunMetadata } from "../../lib/types";
import { modelDisplay } from "../../lib/modelSelectors";

// ─── pure helpers ─────────────────────────────────────────────────────────────

export function idSuffix(id: string): string {
  return id.slice(-8);
}

export function resolveModel(
  agentId: string,
  runMetadata: CellRunMetadata | null,
): string {
  if (runMetadata === null) return idSuffix(agentId);
  const agent = runMetadata.agents.find((a) => a.agent_id === agentId);
  if (agent === undefined || agent.model_id === null) return idSuffix(agentId);
  const disp = modelDisplay(agent.model_id);
  return `${disp.name} · ${idSuffix(agentId)}`;
}

// A proposal_applied before any proposal_picked is an incremental commit;
// at/after proposal_picked it's the terminal consensus apply.
export function classifyProposalApplied(
  eventIndex: number,
  allEvents: CellEvent[],
): "incremental_commit" | "terminal_apply" {
  const hasPriorPick = allEvents
    .slice(0, eventIndex)
    .some((e) => e.kind === "proposal_picked");
  return hasPriorPick ? "terminal_apply" : "incremental_commit";
}

// ─── shared sub-components ────────────────────────────────────────────────────

function JsonDisclosure({ payload }: { payload: Record<string, unknown> }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer select-none text-[11px] text-stone-400 hover:text-stone-600">
        raw JSON
      </summary>
      <pre className="mt-1 overflow-auto rounded bg-stone-50 p-2 text-[11px] text-stone-600">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </details>
  );
}

function ModelChip({ label }: { label: string }) {
  return (
    <span className="inline-block rounded bg-indigo-50 px-1.5 py-0.5 font-mono text-[11px] text-indigo-700">
      {label}
    </span>
  );
}

// ─── per-kind card renderers ──────────────────────────────────────────────────

function IncrementalStartedCard({
  event,
  runMetadata,
}: {
  event: CellEvent;
  runMetadata: CellRunMetadata | null;
}) {
  const p = event.payload;
  const agentCount = typeof p.agent_count === "number" ? p.agent_count : null;
  const retryBudget =
    typeof p.retry_budget === "number" ? p.retry_budget : null;
  const agentIds: string[] = Array.isArray(p.agent_ids)
    ? (p.agent_ids as unknown[]).filter((x): x is string => typeof x === "string")
    : (runMetadata?.agents.map((a) => a.agent_id) ?? []);

  return (
    <div>
      {agentIds.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {agentIds.map((id) => (
            <ModelChip key={id} label={resolveModel(id, runMetadata)} />
          ))}
        </div>
      )}
      <div className="text-[12px] text-stone-600">
        {agentCount !== null && (
          <span>
            {agentCount} agent{agentCount !== 1 ? "s" : ""}
          </span>
        )}
        {retryBudget !== null && <span> · retry budget {retryBudget}</span>}
      </div>
      <JsonDisclosure payload={event.payload} />
    </div>
  );
}

function ProposalAppliedCard({
  event,
  runMetadata,
  eventIndex,
  allEvents,
}: {
  event: CellEvent;
  runMetadata: CellRunMetadata | null;
  eventIndex: number;
  allEvents: CellEvent[];
}) {
  const p = event.payload;
  const agentId = typeof p.agent_id === "string" ? p.agent_id : null;
  const proposalId =
    typeof p.proposal_id === "string" ? p.proposal_id : null;
  const newVersion =
    typeof p.new_version === "string" ? p.new_version : null;
  const kind = classifyProposalApplied(eventIndex, allEvents);

  return (
    <div>
      <div className="mb-1.5">
        <span
          className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
            kind === "terminal_apply"
              ? "bg-emerald-50 text-emerald-700"
              : "bg-amber-50 text-amber-700"
          }`}
        >
          {kind === "terminal_apply"
            ? "final consensus apply"
            : "incremental commit"}
        </span>
      </div>
      <div className="space-y-0.5 text-[12px] text-stone-600">
        {agentId !== null && (
          <div>
            model{" "}
            <span className="font-mono text-stone-800">
              {resolveModel(agentId, runMetadata)}
            </span>
            {" · "}agent{" "}
            <span className="font-mono">{idSuffix(agentId)}</span>
          </div>
        )}
        {proposalId !== null && (
          <div>
            proposal <span className="font-mono">{idSuffix(proposalId)}</span>
          </div>
        )}
        {newVersion !== null && (
          <div>
            version <span className="font-mono">{idSuffix(newVersion)}</span>
          </div>
        )}
      </div>
      <JsonDisclosure payload={event.payload} />
    </div>
  );
}

function IncrementalTerminatedCard({
  event,
  runMetadata,
}: {
  event: CellEvent;
  runMetadata: CellRunMetadata | null;
}) {
  const p = event.payload;
  const terminatedBy =
    typeof p.terminated_by === "string" ? p.terminated_by : null;
  const commitCounts: Record<string, number> =
    p.commit_counts !== null &&
    typeof p.commit_counts === "object" &&
    !Array.isArray(p.commit_counts)
      ? (p.commit_counts as Record<string, number>)
      : {};
  const commitEntries = Object.entries(commitCounts);

  return (
    <div>
      {terminatedBy !== null && (
        <div className="mb-1 text-[12px] text-stone-600">
          terminated by{" "}
          <span className="font-mono text-stone-800">{terminatedBy}</span>
        </div>
      )}
      {commitEntries.length > 0 && (
        <div className="mt-1">
          <div className="mb-0.5 text-[11px] text-stone-500">
            commits by agent
          </div>
          <div className="space-y-0.5">
            {commitEntries.map(([agentId, count]) => (
              <div
                key={agentId}
                className="flex items-center gap-2 text-[12px]"
              >
                <span className="font-mono text-stone-700">
                  {resolveModel(agentId, runMetadata)}
                </span>
                <span className="text-stone-500">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <JsonDisclosure payload={event.payload} />
    </div>
  );
}

function ConvergenceStartedCard({
  event,
  runMetadata,
}: {
  event: CellEvent;
  runMetadata: CellRunMetadata | null;
}) {
  const p = event.payload;
  const mechanism =
    typeof p.mechanism === "string" ? p.mechanism : null;
  const participatingIds: string[] = Array.isArray(p.participating_agent_ids)
    ? (p.participating_agent_ids as unknown[]).filter(
        (x): x is string => typeof x === "string",
      )
    : [];

  return (
    <div>
      {mechanism !== null && (
        <div className="mb-1.5 text-[12px] text-stone-600">
          mechanism{" "}
          <span className="font-mono text-stone-800">{mechanism}</span>
        </div>
      )}
      {participatingIds.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {participatingIds.map((id) => (
            <ModelChip key={id} label={resolveModel(id, runMetadata)} />
          ))}
        </div>
      )}
      <JsonDisclosure payload={event.payload} />
    </div>
  );
}

function RoundCompletedCard({ event }: { event: CellEvent }) {
  const p = event.payload;
  const roundIndex =
    typeof p.round_index === "number" ? p.round_index : null;
  const converged =
    typeof p.converged === "boolean" ? p.converged : null;
  const nProposals =
    typeof p.n_proposals === "number" ? p.n_proposals : null;

  return (
    <div>
      <div className="text-[12px] text-stone-600">
        {roundIndex !== null && <span>round {roundIndex}</span>}
        {converged !== null && (
          <span>
            {" · "}
            <span className={converged ? "text-emerald-700" : undefined}>
              {converged ? "converged" : "not converged"}
            </span>
          </span>
        )}
        {nProposals !== null && (
          <span>
            {" · "}
            {nProposals} proposal{nProposals !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      <JsonDisclosure payload={event.payload} />
    </div>
  );
}

function EscalationTriggeredCard({ event }: { event: CellEvent }) {
  const p = event.payload;
  const roundIndex =
    typeof p.round_index === "number" ? p.round_index : null;
  const nResidual =
    typeof p.n_residual_proposals === "number"
      ? p.n_residual_proposals
      : null;

  return (
    <div>
      <div className="text-[12px] text-stone-600">
        {roundIndex !== null && <span>after round {roundIndex}</span>}
        {nResidual !== null && (
          <span>
            {" · "}
            {nResidual} residual proposal{nResidual !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      <JsonDisclosure payload={event.payload} />
    </div>
  );
}

function ProposalPickedCard({
  event,
  runMetadata,
}: {
  event: CellEvent;
  runMetadata: CellRunMetadata | null;
}) {
  const p = event.payload;
  const agentId = typeof p.agent_id === "string" ? p.agent_id : null;
  const rationale =
    typeof p.rationale === "string" ? p.rationale : null;
  const convergedAtRound =
    typeof p.converged_at_round === "number" ? p.converged_at_round : null;

  return (
    <div>
      {agentId !== null && (
        <div className="mb-1.5">
          <ModelChip label={resolveModel(agentId, runMetadata)} />
        </div>
      )}
      <div className="space-y-0.5 text-[12px] text-stone-600">
        {convergedAtRound !== null && (
          <div>converged at round {convergedAtRound}</div>
        )}
        {rationale !== null && <div className="italic">{rationale}</div>}
      </div>
      <JsonDisclosure payload={event.payload} />
    </div>
  );
}

function CellFailedCard({ event }: { event: CellEvent }) {
  const p = event.payload;
  const error = typeof p.error === "string" ? p.error : null;
  const traceback =
    typeof p.traceback === "string" ? p.traceback : null;

  return (
    <div>
      {error !== null && (
        <div className="mb-1.5 rounded bg-red-50 px-2 py-1 text-[12px] text-red-700">
          {error}
        </div>
      )}
      {traceback !== null && (
        <details className="mb-1">
          <summary className="cursor-pointer select-none text-[11px] text-stone-400 hover:text-stone-600">
            traceback
          </summary>
          <pre className="mt-1 overflow-auto rounded bg-stone-50 p-2 text-[11px] text-stone-600">
            {traceback}
          </pre>
        </details>
      )}
      <JsonDisclosure payload={event.payload} />
    </div>
  );
}

function FallbackCard({ event }: { event: CellEvent }) {
  return <JsonDisclosure payload={event.payload} />;
}

// ─── main export ──────────────────────────────────────────────────────────────

export interface RunEventCardProps {
  event: CellEvent;
  runMetadata: CellRunMetadata | null;
  eventIndex: number;
  allEvents: CellEvent[];
}

function cardFor(
  event: CellEvent,
  runMetadata: CellRunMetadata | null,
  eventIndex: number,
  allEvents: CellEvent[],
) {
  switch (event.kind) {
    case "incremental_started":
      return (
        <IncrementalStartedCard event={event} runMetadata={runMetadata} />
      );
    case "proposal_applied":
      return (
        <ProposalAppliedCard
          event={event}
          runMetadata={runMetadata}
          eventIndex={eventIndex}
          allEvents={allEvents}
        />
      );
    case "incremental_terminated":
      return (
        <IncrementalTerminatedCard event={event} runMetadata={runMetadata} />
      );
    case "convergence_started":
      return (
        <ConvergenceStartedCard event={event} runMetadata={runMetadata} />
      );
    case "round_completed":
      return <RoundCompletedCard event={event} />;
    case "escalation_triggered":
      return <EscalationTriggeredCard event={event} />;
    case "proposal_picked":
      return (
        <ProposalPickedCard event={event} runMetadata={runMetadata} />
      );
    case "cell_failed":
      return <CellFailedCard event={event} />;
    default:
      return <FallbackCard event={event} />;
  }
}

export function RunEventCard({
  event,
  runMetadata,
  eventIndex,
  allEvents,
}: RunEventCardProps) {
  const ts = new Date(event.ts).toLocaleTimeString();
  return (
    <li className="border-b border-stone-100 py-2 text-[13px]">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="text-[11px] text-stone-500">{ts}</span>
        <span className="font-semibold text-stone-700">{event.kind}</span>
      </div>
      {cardFor(event, runMetadata, eventIndex, allEvents)}
    </li>
  );
}
