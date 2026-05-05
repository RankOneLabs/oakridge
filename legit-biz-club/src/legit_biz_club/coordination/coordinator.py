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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from legit_biz_club.coordination.mediator import Mediator
from legit_biz_club.coordination.proposal import (
    ProposalOutcome,
    ProposalResult,
)
from legit_biz_club.coordination.proposer import Proposer
from legit_biz_club.coordination.termination import TerminationPolicy
from legit_biz_club.core.models import Agent, Project

WorkspaceEventEmitter = Callable[[str, dict[str, object]], Awaitable[None]]
"""Callback for emitting workspace events.

Signature: ``(kind, payload) -> awaitable``. The coordinator supplies
``kind`` and ``payload``; the project_id is the caller's responsibility
(typically closed over). Pass a no-op for tests that don't care about
events.
"""


async def _no_op_emitter(_kind: str, _payload: dict[str, object]) -> None:
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


_RESULT_TO_EVENT_KIND: dict[ProposalResult, str] = {
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
        if {a.id for a in agents} != set(proposers.keys()):
            raise ValueError(
                "proposers must be keyed by agent_id for every enrolled agent"
            )
        self.project = project
        self.agents = agents
        self.proposers = proposers
        self.mediator = mediator
        self.termination_policy = termination_policy
        self._emit = emit or _no_op_emitter

    async def run(self) -> IncrementalRunResult:
        outcomes: list[ProposalOutcome] = []
        await self._emit(
            "incremental_started",
            {
                "agent_ids": [a.id for a in self.agents],
                "retry_budget": next(
                    iter(self.mediator.retry_remaining.values()), 0
                ),
            },
        )
        terminated_by: str
        while True:
            if self.termination_policy.should_terminate(
                self.mediator.commit_counts
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
                await self._emit_outcome(outcome)
                # Re-check policy mid-round so we don't burn extra
                # proposals after the policy fires.
                if self.termination_policy.should_terminate(
                    self.mediator.commit_counts
                ):
                    mid_round_terminated = True
                    break
            if mid_round_terminated:
                # Outer-loop top will re-detect and break with terminated_by="policy".
                continue
        await self._emit(
            "incremental_terminated",
            {
                "terminated_by": terminated_by,
                "commit_counts": dict(self.mediator.commit_counts),
            },
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
        return await self.mediator.apply(proposal)

    def _agent_exhausted(self, agent_id: str) -> bool:
        return self.mediator.retry_remaining.get(agent_id, 0) <= 0

    def _all_exhausted(self) -> bool:
        return all(
            self.mediator.retry_remaining.get(a.id, 0) <= 0
            for a in self.agents
        )

    async def _emit_outcome(self, outcome: ProposalOutcome) -> None:
        await self._emit(
            _RESULT_TO_EVENT_KIND[outcome.result],
            {
                "agent_id": outcome.proposal.agent_id,
                "proposal_id": outcome.proposal.id,
                "reason": outcome.reason,
                "new_version": outcome.new_version,
            },
        )
