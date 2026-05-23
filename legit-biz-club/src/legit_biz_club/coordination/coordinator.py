"""Incremental coordinator: drives the round-robin propose-mediate loop.

For v1, agents take turns proposing. Round-robin (rather than parallel
``asyncio.gather``) keeps the design predictable — only one proposal
in flight at a time, no contention between proposals beyond OCC. Easy
to reason about, easy to test.

The loop stops when the termination policy fires OR every agent has
exhausted their retry budget — whichever comes first. Workspace events
are emitted at start, on each proposal outcome, and at termination,
via the supplied :data:`WorkspaceEventEmitter` callback. Tests can
pass a no-op emitter; production wires it to the kbbl adapter's
``post_workspace_event``.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from legit_biz_club.coordination.events import (
    IncrementalStartedPayload,
    IncrementalTerminatedPayload,
    ProposalOutcomePayload,
)
from legit_biz_club.coordination.events import (
    WorkspaceEventEmitter as WorkspaceEventEmitter,
)
from legit_biz_club.coordination.events import (
    WorkspaceEventKind as WorkspaceEventKind,
)
from legit_biz_club.coordination.events import (
    WorkspaceEventPayload as WorkspaceEventPayload,
)
from legit_biz_club.coordination.mediator import Mediator
from legit_biz_club.coordination.proposal import (
    ProposalOutcome,
    ProposalResult,
)
from legit_biz_club.coordination.proposer import Proposer
from legit_biz_club.coordination.termination import TerminationPolicy
from legit_biz_club.core.models import Agent, Project

logger = logging.getLogger(__name__)

async def _no_op_emitter(
    _kind: WorkspaceEventKind, _payload: WorkspaceEventPayload
) -> None:
    """Default emitter that does nothing — keeps the constructor easy."""
    await asyncio.sleep(0)


@dataclass
class IncrementalRunResult:
    """Outcome of an incremental coordination run."""

    project: Project
    outcomes: list[ProposalOutcome]
    final_commit_counts: dict[str, int]
    final_retry_remaining: dict[str, int]
    terminated_by: str
    """``policy`` or ``all_exhausted``."""


_RESULT_TO_EVENT_KIND: dict[ProposalResult, WorkspaceEventKind] = {
    ProposalResult.APPLIED: "proposal_applied",
    ProposalResult.REJECTED_OCC: "proposal_rejected_occ",
    ProposalResult.REJECTED_VALIDATION: "proposal_rejected_validation",
    ProposalResult.BUDGET_EXHAUSTED: "agent_budget_exhausted",
}


class IncrementalCoordinator:
    """Drives the incremental coordination mode end-to-end."""

    def __init__(
        self,
        *,
        project: Project,
        agents: list[Agent],
        proposers: dict[str, Proposer],
        mediator: Mediator,
        termination_policy: TerminationPolicy,
        emit: WorkspaceEventEmitter | None = None,
    ) -> None:
        agent_ids = {a.id for a in agents}
        if agent_ids != set(proposers.keys()):
            raise ValueError(
                "proposers must be keyed by agent_id for every enrolled agent"
            )
        # Project enrollments are the source of truth for who's in the
        # ensemble. If the agents list is a subset, ``KCommitsPerAgent``
        # would terminate after only the subset reaches K — violating
        # the documented "every enrolled agent" contract. Catch the
        # mismatch at construction so it can't surface as a misleading
        # early-termination at run time.
        enrollment_ids = {e.agent_id for e in project.enrollments}
        if agent_ids != enrollment_ids:
            raise ValueError(
                "agents must match project.enrollments exactly "
                f"(agents={sorted(agent_ids)}, "
                f"enrollments={sorted(enrollment_ids)})"
            )
        # Mediator must know about every enrolled agent or its retry/
        # commit dicts will silently report 0 budget for the missing
        # agent, which ``_agent_exhausted`` then treats as already-done.
        # The run could terminate via "all_exhausted" without ever
        # giving an enrolled agent a turn. Same fail-loud principle as
        # above.
        mediator_ids = set(mediator.retry_remaining.keys())
        if agent_ids != mediator_ids:
            raise ValueError(
                "mediator must be initialized with the same agent ids "
                "as the coordinator's agents "
                f"(agents={sorted(agent_ids)}, "
                f"mediator={sorted(mediator_ids)})"
            )
        self.project = project
        self.agents = agents
        self.proposers = proposers
        self.mediator = mediator
        self.termination_policy = termination_policy
        self._emit = emit or _no_op_emitter

    async def run(self) -> IncrementalRunResult:
        outcomes: list[ProposalOutcome] = []
        # Recent applied versions, in apply order — feeds the
        # termination policy so stability-aware policies (e.g.,
        # KCommitsOrStable) can short-circuit when the artifact has
        # been byte-identical for N consecutive applies.
        applied_versions: list[str] = []
        await self._safe_emit(
            "incremental_started",
            IncrementalStartedPayload(
                agent_ids=[a.id for a in self.agents],
                retry_budget=next(
                    iter(self.mediator.retry_remaining.values()), 0
                ),
            ),
        )
        terminated_by: str
        while True:
            if self.termination_policy.should_terminate(
                self.mediator.commit_counts, applied_versions
            ):
                terminated_by = "policy"
                break
            if self._all_exhausted():
                terminated_by = "all_exhausted"
                break
            mid_round_terminated = False
            for agent in self.agents:
                if self._agent_exhausted(agent.id):
                    continue
                outcome = await self._step(agent)
                outcomes.append(outcome)
                if outcome.new_version is not None:
                    applied_versions.append(outcome.new_version)
                await self._emit_outcome(outcome)
                # Re-check policy mid-round on commit_counts only —
                # NOT applied_versions. Stability checks fire only at
                # round boundary so every agent in a round gets to
                # propose; otherwise stability triggered by an earlier
                # sequence would skip later agents in the same round
                # and make commit_counts agent-order-dependent. The
                # cost-saving payoff (skip the rest of an unproductive
                # round) still kicks in next round-top check.
                if self.termination_policy.should_terminate(
                    self.mediator.commit_counts
                ):
                    mid_round_terminated = True
                    break
            if mid_round_terminated:
                # Outer-loop top will re-detect and break with terminated_by="policy".
                continue
        await self._safe_emit(
            "incremental_terminated",
            IncrementalTerminatedPayload(
                terminated_by=terminated_by,
                commit_counts=dict(self.mediator.commit_counts),
            ),
        )
        return IncrementalRunResult(
            project=self.project,
            outcomes=outcomes,
            final_commit_counts=dict(self.mediator.commit_counts),
            final_retry_remaining=dict(self.mediator.retry_remaining),
            terminated_by=terminated_by,
        )

    async def _step(self, agent: Agent) -> ProposalOutcome:
        proposer = self.proposers[agent.id]
        content, version = await self.mediator.current_state()
        proposal = await proposer.propose(
            agent=agent,
            brief=self.project.brief,
            artifact=self.project.artifact,
            current_content=content,
            current_version=version,
        )
        # A buggy Proposer that returns the wrong agent_id would land
        # as REJECTED_VALIDATION in the mediator, which doesn't decrement
        # the retry budget — the loop could spin indefinitely emitting
        # rejection events. Treat this as a programmer error and raise
        # so the coordinator stops rather than chasing its tail.
        if proposal.agent_id != agent.id:
            raise ValueError(
                f"Proposer for agent {agent.id} returned a proposal with "
                f"agent_id={proposal.agent_id!r}; this is a programmer "
                "error in the Proposer implementation"
            )
        return await self.mediator.apply(proposal)

    def _agent_exhausted(self, agent_id: str) -> bool:
        return self.mediator.retry_remaining.get(agent_id, 0) <= 0

    def _all_exhausted(self) -> bool:
        return all(
            self.mediator.retry_remaining.get(a.id, 0) <= 0
            for a in self.agents
        )

    async def _emit_outcome(self, outcome: ProposalOutcome) -> None:
        await self._safe_emit(
            _RESULT_TO_EVENT_KIND[outcome.result],
            ProposalOutcomePayload(
                agent_id=outcome.proposal.agent_id,
                proposal_id=outcome.proposal.id,
                reason=outcome.reason,
                new_version=outcome.new_version,
            ),
        )

    async def _safe_emit(
        self, kind: WorkspaceEventKind, payload: WorkspaceEventPayload
    ) -> None:
        """Emit, but never abort the coordination loop on emit failure.

        In production ``self._emit`` is wired to an HTTP call (the kbbl
        adapter's ``post_workspace_event``); a transient kbbl outage
        would otherwise stop the whole project mid-run even though the
        underlying proposal already mediated successfully. Workspace
        events are best-effort observability — losing one is recoverable
        (legit-biz-club is the source of truth for project state); losing
        the rest of the run is not.
        """
        try:
            await self._emit(kind, payload)
        except Exception as e:
            logger.warning(
                "workspace event emit failed for kind=%s: %s",
                kind,
                e,
            )
