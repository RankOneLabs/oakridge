"""ProjectCoordinator: dispatches to incremental and/or consensus based
on the project's coordination protocol.

Reads :attr:`Project.coordination_protocol` and runs the matching
combination of :class:`IncrementalCoordinator` and
:class:`ConsensusMechanism`. The three v1 protocols:

- ``INCREMENTAL_ONLY`` — runs :class:`IncrementalCoordinator` to
  termination; no consensus phase.
- ``INCREMENTAL_THEN_CONVERGE`` — runs incremental, then resets the
  mediator's retry budgets and runs :class:`MultiRoundConsensus` for a
  final unified next-state before ship.
- ``MULTI_ROUND_FROM_START`` — skips incremental; runs
  :class:`MultiRoundConsensus` directly. Useful when the artifact starts
  empty and the goal is the ensemble's collective best output.

Per the design memo, ``ProjectCoordinator`` is the only orchestrator
external callers should reach for. ``IncrementalCoordinator`` and
the consensus mechanisms are the building blocks it composes.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from jig.core.types import TracingLogger

from legit_biz_club.coordination.consensus import (
    ConsensusMechanism,
    ConsensusResult,
    MultiRoundConsensus,
    WorkspaceEventEmitter,
)
from legit_biz_club.coordination.coordinator import (
    IncrementalCoordinator,
    IncrementalRunResult,
)
from legit_biz_club.coordination.disagreement import (
    DisagreementSurface,
    StableOrderingByAgentId,
)
from legit_biz_club.coordination.mediator import Mediator
from legit_biz_club.coordination.proposer import Proposer
from legit_biz_club.coordination.round_budget import (
    RoundBudgetPolicy,
    StringEqualConvergence,
)
from legit_biz_club.coordination.termination import (
    KCommitsOrStable,
    TerminationPolicy,
)
from legit_biz_club.core.lifecycle import ProjectState, transition_to
from legit_biz_club.core.models import Agent, CoordinationProtocol, Project


@dataclass
class ProjectRunResult:
    """Aggregated outcome of a project run.

    ``incremental`` is ``None`` when the protocol skipped the
    incremental phase (``MULTI_ROUND_FROM_START``); ``consensus`` is
    ``None`` when the protocol skipped the consensus phase
    (``INCREMENTAL_ONLY``). Both can be present under
    ``INCREMENTAL_THEN_CONVERGE``.
    """

    project: Project
    protocol: CoordinationProtocol
    incremental: IncrementalRunResult | None
    consensus: ConsensusResult | None


class ProjectCoordinator:
    """Top-level project runner. Dispatches to the matching combination
    of :class:`IncrementalCoordinator` and :class:`ConsensusMechanism`.
    """

    def __init__(
        self,
        *,
        project: Project,
        agents: list[Agent],
        proposers: dict[str, Proposer],
        mediator: Mediator,
        # incremental config
        termination_policy: TerminationPolicy | None = None,
        # consensus config (used when protocol selects a consensus phase)
        round_budget_policy: RoundBudgetPolicy | None = None,
        disagreement_surface: DisagreementSurface | None = None,
        consensus_mechanism_factory: (
            type[ConsensusMechanism] | None
        ) = None,
        # observability
        tracer: TracingLogger,
        emit: WorkspaceEventEmitter | None = None,
    ) -> None:
        self.project = project
        self.agents = agents
        self.proposers = proposers
        self.mediator = mediator
        # Default to the stability-aware policy: same upper bound as
        # KCommitsPerAgent(k=5), but short-circuits when the artifact's
        # last 3 commits are byte-identical (agents agreed, further
        # commits are no-ops). Pass an explicit KCommitsPerAgent to opt
        # into a fixed call budget for cross-condition cost comparison.
        self.termination_policy = termination_policy or KCommitsOrStable()
        self.round_budget_policy = (
            round_budget_policy or StringEqualConvergence()
        )
        self.disagreement_surface = (
            disagreement_surface or StableOrderingByAgentId()
        )
        # Default to multi-round; v1 study can swap in SingleRoundConsensus
        # via this factory hook.
        self.consensus_mechanism_factory: type[ConsensusMechanism] = (
            consensus_mechanism_factory or MultiRoundConsensus
        )
        self.tracer = tracer
        self.emit = emit

    async def run(self) -> ProjectRunResult:
        if not self.project.enrollments:
            raise ValueError(
                "project must have at least one enrollment before coordinator.run()"
            )
        # ENROLLING → ACTIVE: validates the project is in the expected state.
        # transition_to raises InvalidTransitionError for any other source state,
        # so this is both the guard and the transition.
        self.project.state = transition_to(self.project.state, ProjectState.ACTIVE)

        protocol = self.project.coordination_protocol
        incremental_result: IncrementalRunResult | None = None
        consensus_result: ConsensusResult | None = None

        try:
            if protocol in (
                CoordinationProtocol.INCREMENTAL_ONLY,
                CoordinationProtocol.INCREMENTAL_THEN_CONVERGE,
            ):
                incremental_result = await self._run_incremental()

            if protocol in (
                CoordinationProtocol.INCREMENTAL_THEN_CONVERGE,
                CoordinationProtocol.MULTI_ROUND_FROM_START,
            ):
                if protocol == CoordinationProtocol.INCREMENTAL_THEN_CONVERGE:
                    # Agents that burned their retry budget during
                    # incremental should still be eligible to land a
                    # converged / escalation-picked proposal — consensus
                    # has no retry semantics, so the budget check is
                    # meaningless for a one-shot apply.
                    await self.mediator.reset_retry_budgets()
                consensus_result = await self._run_consensus()
        except Exception:
            # Leave the project in ACTIVE; the caller sees the exception and
            # the incomplete run state. SHIPPED is only set on clean completion.
            raise

        self.project.state = transition_to(self.project.state, ProjectState.SHIPPED)
        self.project.shipped_at = datetime.now(UTC)

        return ProjectRunResult(
            project=self.project,
            protocol=protocol,
            incremental=incremental_result,
            consensus=consensus_result,
        )

    async def _run_incremental(self) -> IncrementalRunResult:
        coordinator = IncrementalCoordinator(
            project=self.project,
            agents=self.agents,
            proposers=self.proposers,
            mediator=self.mediator,
            termination_policy=self.termination_policy,
            emit=self.emit,
        )
        return await coordinator.run()

    async def _run_consensus(self) -> ConsensusResult:
        mechanism = self.consensus_mechanism_factory(
            project=self.project,
            agents=self.agents,
            proposers=self.proposers,
            mediator=self.mediator,
            round_budget_policy=self.round_budget_policy,
            disagreement_surface=self.disagreement_surface,
            tracer=self.tracer,
            emit=self.emit,
        )
        return await mechanism.execute()
