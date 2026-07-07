"""Consensus mechanisms: pluggable strategies for resolving an ensemble's
proposals into a single committed next-state.

Each mechanism builds a jig ``PipelineConfig`` internally and runs it
via ``run_pipeline``. The pipeline shape is mechanism-specific:

- :class:`MultiRoundConsensus` — N round-propose steps (one per
  ``RoundBudgetPolicy.max_rounds``), an escalation step gated on
  convergence, and an apply step. Later rounds short-circuit via
  ``skip_when`` once any round detects convergence.
- :class:`SingleRoundConsensus` — one round-propose step, an
  always-runs pick step, and an apply step. No convergence detection —
  the disagreement surface always picks. Useful as a baseline in the
  v1 study.

Both mechanisms share a base class that wires the dependencies and
extracts a structured :class:`ConsensusResult` from the pipeline's
context. Tracing, grading, and feedback hooks come from jig's
per-step machinery — Phase 4's eval surface plugs in via ``Step.grader``
without touching this module.

Workspace events emitted at lifecycle points: ``convergence_started``,
``round_completed`` (per round), ``escalation_triggered`` (when not
converged), ``proposal_picked``. The mechanism takes an optional emit
callback; tests pass a no-op.
"""
from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, cast

from jig.core.pipeline import PipelineConfig, Step, run_pipeline
from jig.core.types import TracingLogger

from legit_biz_club.coordination.disagreement import (
    DisagreementSurface,
    PickResult,
)
from legit_biz_club.coordination.events import (
    ConvergenceStartedPayload,
    EscalationTriggeredPayload,
    ProposalOutcomePayload,
    ProposalPickedPayload,
    RoundCompletedPayload,
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
    Proposal,
    ProposalOutcome,
    ProposalResult,
)
from legit_biz_club.coordination.proposer import Proposer
from legit_biz_club.coordination.round_budget import RoundBudgetPolicy
from legit_biz_club.core.models import Agent, Project

logger = logging.getLogger(__name__)


async def _no_op_emitter(
    _kind: WorkspaceEventKind, _payload: WorkspaceEventPayload
) -> None:
    await asyncio.sleep(0)


@dataclass
class ProposerFailure:
    """Structured record for one proposer failure in a consensus round."""

    agent_id: str
    error_class: str
    error_message: str


class ConsensusRoundFailed(RuntimeError):
    """Raised when a consensus round has no usable proposer output."""

    def __init__(
        self, *, round_index: int, failures: list[ProposerFailure]
    ) -> None:
        self.round_index = round_index
        self.failures = failures
        summary = ", ".join(
            f"{f.agent_id}={f.error_class}: {f.error_message}"
            for f in failures
        )
        super().__init__(
            f"consensus round {round_index} failed: all proposers failed "
            f"({summary})"
        )


@dataclass
class RoundOutcome:
    """One round's record: which round (1-indexed), the proposals it
    produced, and whether the round-budget policy declared convergence.

    ``failed_agents`` lists agent ids whose proposers raised during this
    round. ``failed_agent_errors`` carries the structured error details.
    When non-empty, ``proposals`` contains only the successful sibling
    outputs — convergence detection runs on the partial set and the
    escalation step picks from it. If every proposer fails, the round
    raises ``ConsensusRoundFailed`` instead of escalating an empty set.
    """

    round_index: int
    proposals: list[Proposal]
    converged: bool
    failed_agents: list[str] = field(default_factory=list)
    failed_agent_errors: list[ProposerFailure] = field(default_factory=list)


@dataclass
class ConsensusResult:
    """The mechanism's final verdict.

    ``converged_at_round`` is the 1-indexed round whose proposals
    matched (or ``None`` if no round converged).
    ``picked_via_escalation`` is ``True`` when the
    :class:`DisagreementSurface` actually ran and produced the
    applied pick — distinct from "no round converged" because
    :class:`SingleRoundConsensus`'s escalate step is
    ``always_runs=True`` and is authoritative even when round 1's
    proposals happen to be byte-identical. Consumers tracking
    operator-burden / escalation rate should read this flag, not
    infer from ``converged_at_round``.
    ``apply_outcome`` is the mediator's response to applying the
    picked proposal — typically ``APPLIED``, but a malformed picked
    proposal could surface as a rejection.
    """

    picked: Proposal
    rationale: str
    rounds: list[RoundOutcome]
    converged_at_round: int | None
    picked_via_escalation: bool
    apply_outcome: ProposalOutcome


class ConsensusMechanism(ABC):
    """Pluggable strategy for resolving an ensemble's proposals."""

    def __init__(
        self,
        *,
        project: Project,
        agents: list[Agent],
        proposers: dict[str, Proposer],
        mediator: Mediator,
        round_budget_policy: RoundBudgetPolicy,
        disagreement_surface: DisagreementSurface,
        tracer: TracingLogger,
        emit: WorkspaceEventEmitter | None = None,
    ) -> None:
        # Validate uniqueness BEFORE the set-based comparisons below.
        # Without these checks, a duplicated agent_id in the input
        # lists would silently collapse to a single entry under
        # set(...) and pass the equality checks — biasing round
        # participation and the convergence detector.
        agent_id_list = [a.id for a in agents]
        if len(agent_id_list) != len(set(agent_id_list)):
            raise ValueError(
                f"agents must contain unique agent ids (got {agent_id_list})"
            )
        enrollment_id_list = [e.agent_id for e in project.enrollments]
        if len(enrollment_id_list) != len(set(enrollment_id_list)):
            raise ValueError(
                "project.enrollments must contain unique agent ids "
                f"(got {enrollment_id_list})"
            )
        agent_ids = set(agent_id_list)
        if agent_ids != set(proposers.keys()):
            raise ValueError(
                "proposers must be keyed by agent_id for every enrolled agent"
            )
        if agent_ids != set(enrollment_id_list):
            raise ValueError(
                "agents must match project.enrollments exactly"
            )
        if agent_ids != set(mediator.retry_remaining.keys()):
            raise ValueError(
                "mediator must be initialized with the same agent ids"
            )
        self.project = project
        self.agents = agents
        self.proposers = proposers
        self.mediator = mediator
        self.round_budget_policy = round_budget_policy
        self.disagreement_surface = disagreement_surface
        self.tracer = tracer
        self._emit = emit or _no_op_emitter

    async def execute(self) -> ConsensusResult:
        """Run the mechanism's pipeline and return the structured result."""
        await self._safe_emit(
            "convergence_started",
            ConvergenceStartedPayload(
                mechanism=type(self).__name__,
                agent_ids=[a.id for a in self.agents],
            ),
        )
        config = self._build_pipeline()
        pipeline_result = await run_pipeline(config, input=self.project.id)
        result = self._extract_result(pipeline_result.step_outputs)
        await self._safe_emit(
            "proposal_picked",
            ProposalPickedPayload(
                agent_id=result.picked.agent_id,
                proposal_id=result.picked.id,
                rationale=result.rationale,
                converged_at_round=result.converged_at_round,
            ),
        )
        # Mirror the incremental coordinator's per-commit event so an
        # operator surface tracking artifact changes via
        # `proposal_applied` sees the consensus commit too. Without
        # this, the final commit of an INCREMENTAL_THEN_CONVERGE
        # project is invisible to a `proposal_applied`-only consumer.
        # Emit only on a successful apply — apply failures already log
        # at warning level inside the apply step and aren't a
        # kbbl-facing event in this protocol (no retry semantics in
        # consensus).
        if result.apply_outcome.result == ProposalResult.APPLIED:
            await self._safe_emit(
                "proposal_applied",
                ProposalOutcomePayload(
                    agent_id=result.picked.agent_id,
                    proposal_id=result.picked.id,
                    reason=result.apply_outcome.reason,
                    new_version=result.apply_outcome.new_version,
                ),
            )
        return result

    @abstractmethod
    def _build_pipeline(self) -> PipelineConfig:
        """Construct the mechanism's jig PipelineConfig."""

    def _extract_result(
        self, step_outputs: dict[str, Any]
    ) -> ConsensusResult:
        rounds: list[RoundOutcome] = []
        converged_at_round: int | None = None
        for key, value in step_outputs.items():
            if not key.startswith("round_"):
                continue
            outcome: RoundOutcome = value
            rounds.append(outcome)
            if outcome.converged and converged_at_round is None:
                converged_at_round = outcome.round_index

        # The "apply" step's output is a dict with keys "outcome",
        # "picked", and "rationale". The mediator's ProposalOutcome,
        # the picked Proposal, and the human-readable rationale string.
        apply_payload = step_outputs["apply"]
        apply_outcome: ProposalOutcome = apply_payload["outcome"]
        picked: Proposal = apply_payload["picked"]
        rationale: str = apply_payload["rationale"]

        # The escalate step writes ctx["escalate"] only when it
        # actually runs. SingleRoundConsensus's escalate is
        # always_runs=True; multi-round's is skip_when=converged.
        # So ``"escalate" in step_outputs`` is the authoritative
        # signal for "the DisagreementSurface produced the pick" —
        # independent of whether a round happened to converge.
        picked_via_escalation = "escalate" in step_outputs

        return ConsensusResult(
            picked=picked,
            rationale=rationale,
            rounds=sorted(rounds, key=lambda r: r.round_index),
            converged_at_round=converged_at_round,
            picked_via_escalation=picked_via_escalation,
            apply_outcome=apply_outcome,
        )

    # ------ shared step factories ------

    def _make_round_step(self, round_index: int) -> Step:
        async def fn(ctx: dict[str, Any]) -> RoundOutcome:
            # First round populates the starting state in ctx so all
            # later rounds operate on the same baseline (per the design
            # memo: every round proposes from the same starting state).
            if "initial_content" not in ctx:
                content, version = await self.mediator.current_state()
                ctx["initial_content"] = content
                ctx["initial_version"] = version

            content = ctx["initial_content"]
            version = ctx["initial_version"]

            # Round 1: independence (no peer context). Rounds 2+: peer
            # proposals from the prior round, with each agent's OWN
            # prior proposal filtered out — "peers" means other agents,
            # not self. The pipeline's skip_when already guarantees we
            # don't reach round N+1 if round N converged.
            prior_proposals: list[Proposal] | None = None
            if round_index > 1:
                prior: RoundOutcome = ctx[f"round_{round_index - 1}"]
                prior_proposals = list(prior.proposals)

            raw_results = await asyncio.gather(
                *[
                    self.proposers[agent.id].propose(
                        agent=agent,
                        brief=self.project.brief,
                        artifact=self.project.artifact,
                        current_content=content,
                        current_version=version,
                        peer_proposals=(
                            None
                            if prior_proposals is None
                            else [
                                p
                                for p in prior_proposals
                                if p.agent_id != agent.id
                            ]
                        ),
                    )
                    for agent in self.agents
                ],
                return_exceptions=True,
            )
            proposals: list[Proposal] = []
            failed_agents: list[str] = []
            failed_agent_errors: list[ProposerFailure] = []
            for agent, result in zip(self.agents, raw_results, strict=True):
                if isinstance(result, BaseException):
                    logger.warning(
                        "proposer for agent %s failed in round %d: %s: %s",
                        agent.id,
                        round_index,
                        type(result).__name__,
                        result,
                    )
                    failed_agents.append(agent.id)
                    failed_agent_errors.append(
                        ProposerFailure(
                            agent_id=agent.id,
                            error_class=type(result).__name__,
                            error_message=str(result),
                        )
                    )
                else:
                    proposals.append(result)
            if not proposals and failed_agent_errors:
                raise ConsensusRoundFailed(
                    round_index=round_index,
                    failures=failed_agent_errors,
                )
            if failed_agents:
                self._validate_successful_proposals_match_live_agents(
                    proposals, failed_agents
                )
            else:
                self._validate_proposals_match_agents(proposals)

            converged = self.round_budget_policy.is_converged(proposals)
            outcome = RoundOutcome(
                round_index=round_index,
                proposals=proposals,
                converged=converged,
                failed_agents=failed_agents,
                failed_agent_errors=failed_agent_errors,
            )
            await self._safe_emit(
                "round_completed",
                RoundCompletedPayload(
                    round_index=round_index,
                    converged=converged,
                    n_proposals=len(proposals),
                ),
            )
            if converged:
                # Mark ctx so later round steps and the escalate step skip.
                ctx["converged"] = True
                ctx["converged_at_round"] = round_index
            return outcome

        skip_if_already_converged = (
            (lambda c: bool(c.get("converged", False)))
            if round_index > 1
            else None
        )
        return Step(
            name=f"round_{round_index}",
            fn=fn,
            skip_when=skip_if_already_converged,
        )

    def _make_escalate_step(self, *, always_runs: bool) -> Step:
        """Build the escalation step.

        ``always_runs=True`` for single-round-then-pick (no convergence
        detection — the surface always picks). ``always_runs=False``
        for multi-round (skip when any round converged).
        """

        async def fn(ctx: dict[str, Any]) -> PickResult:
            # Find the most recent round's proposals.
            last_round: RoundOutcome | None = None
            for round_idx in range(
                self.round_budget_policy.max_rounds, 0, -1
            ):
                key = f"round_{round_idx}"
                if key in ctx:
                    last_round = ctx[key]
                    break
            if last_round is None:
                raise RuntimeError(
                    "escalate step ran with no prior round outcomes — "
                    "pipeline construction bug"
                )
            await self._safe_emit(
                "escalation_triggered",
                EscalationTriggeredPayload(
                    round_index=last_round.round_index,
                    n_residual_proposals=len(last_round.proposals),
                ),
            )
            return await self.disagreement_surface.pick(last_round.proposals)

        skip_when = (
            None
            if always_runs
            else (lambda c: bool(c.get("converged", False)))
        )
        return Step(name="escalate", fn=fn, skip_when=skip_when)

    def _make_apply_step(self) -> Step:
        """Build the final apply step.

        Resolution order: if a :class:`DisagreementSurface` produced a
        pick (the ``escalate`` step ran), that pick is authoritative —
        the surface's strategy is what the project configured for
        choosing the winner, and bypassing it would silently override
        the operator's intent. If escalation didn't run (multi-round
        converged early via ``skip_when``), pick the converged round's
        lowest-agent_id proposal (all identical by definition).

        The "escalation wins when present" rule is what keeps
        :class:`SingleRoundConsensus` honest: that mechanism's escalate
        step is ``always_runs=True``, so the surface always gets to
        pick — even if round 1 happened to converge.
        """

        async def fn(ctx: dict[str, Any]) -> dict[str, Any]:
            picked: Proposal
            rationale: str
            if "escalate" in ctx:
                pick_result: PickResult = ctx["escalate"]
                picked = pick_result.proposal
                rationale = pick_result.rationale
            elif ctx.get("converged"):
                converged_idx: int = ctx["converged_at_round"]
                round_outcome: RoundOutcome = ctx[f"round_{converged_idx}"]
                # Per the RoundBudgetPolicy.is_converged contract,
                # convergence guarantees byte-identical new_content
                # across all proposals in this round. lowest-agent_id
                # is just stable-ordering for traceability — any
                # proposal in the round would yield the same applied
                # content.
                picked = min(
                    round_outcome.proposals, key=lambda p: p.agent_id
                )
                rationale = f"converged at round {converged_idx}"
            else:
                # Pipeline construction bug: neither escalate ran nor
                # any round converged. Surface as a hard failure.
                raise RuntimeError(
                    "apply step reached without a converged round or "
                    "an escalation pick — pipeline construction bug"
                )
            outcome = await self.mediator.apply(picked)
            if outcome.result != ProposalResult.APPLIED:
                logger.warning(
                    "consensus apply did not succeed: result=%s reason=%s",
                    outcome.result,
                    outcome.reason,
                )
            return {
                "outcome": outcome,
                "picked": picked,
                "rationale": rationale,
            }

        return Step(name="apply", fn=fn)

    def _validate_proposals_match_agents(
        self, proposals: list[Proposal]
    ) -> None:
        """A buggy Proposer that returns the wrong agent_id can't be
        retried meaningfully (the mediator would REJECTED_VALIDATION
        it and the consensus loop has no retry semantics). Surface as
        a programmer error immediately.

        Multiset comparison rather than set membership: catches both
        the unknown-id case (agent_id not enrolled) AND the
        duplicate-id case (same enrolled agent_id twice with one
        missing). The latter would silently skew convergence detection
        and the disagreement-surface pick — fail loud instead.
        """
        expected = sorted(a.id for a in self.agents)
        actual = sorted(p.agent_id for p in proposals)
        if expected != actual:
            raise ValueError(
                "proposal agent_ids don't match enrolled agents — "
                f"expected {expected}, got {actual} — "
                "programmer error in one of the Proposers"
            )

    def _validate_successful_proposals_match_live_agents(
        self, proposals: list[Proposal], failed_agents: list[str]
    ) -> None:
        """Validate partial-round proposal ids after some proposers fail.

        A partial round cannot require a full multiset match against all
        enrolled agents, but successful outputs still must be unique,
        enrolled, and not claim an agent id whose proposer failed.
        """
        enrolled_agent_ids = {agent.id for agent in self.agents}
        failed_agent_ids = set(failed_agents)
        seen_agent_ids: set[str] = set()
        for proposal in proposals:
            if proposal.agent_id not in enrolled_agent_ids:
                raise ValueError(
                    "successful proposal agent_id is not enrolled — "
                    f"got {proposal.agent_id!r}; enrolled={sorted(enrolled_agent_ids)}"
                )
            if proposal.agent_id in failed_agent_ids:
                raise ValueError(
                    "successful proposal agent_id claims a failed agent — "
                    f"got {proposal.agent_id!r}; failed={sorted(failed_agent_ids)}"
                )
            if proposal.agent_id in seen_agent_ids:
                raise ValueError(
                    "duplicate successful proposal agent_id in partial round — "
                    f"got {proposal.agent_id!r}"
                )
            seen_agent_ids.add(proposal.agent_id)

    async def _safe_emit(
        self, kind: WorkspaceEventKind, payload: WorkspaceEventPayload
    ) -> None:
        """Same safe-emit pattern as IncrementalCoordinator: catch and
        log emit failures so a transient kbbl outage can't abort
        consensus mid-run after a proposal already mediated."""
        try:
            emit = cast(
                Callable[
                    [WorkspaceEventKind, WorkspaceEventPayload],
                    Awaitable[None],
                ],
                self._emit,
            )
            await emit(kind, payload)
        except Exception as e:
            logger.warning(
                "workspace event emit failed for kind=%s: %s", kind, e
            )


class MultiRoundConsensus(ConsensusMechanism):
    """v1 default. Builds N round steps + escalate + apply pipeline."""

    def _build_pipeline(self) -> PipelineConfig:
        steps: list[Step] = []
        for i in range(1, self.round_budget_policy.max_rounds + 1):
            steps.append(self._make_round_step(i))
        steps.append(self._make_escalate_step(always_runs=False))
        steps.append(self._make_apply_step())
        return PipelineConfig(
            name="multi_round_consensus",
            steps=steps,
            tracer=self.tracer,
        )


class SingleRoundConsensus(ConsensusMechanism):
    """Single-round-then-pick baseline.

    No convergence detection — the disagreement surface always picks,
    regardless of whether the proposals happen to match. Useful as the
    v1 study's baseline against multi-round.
    """

    def _build_pipeline(self) -> PipelineConfig:
        return PipelineConfig(
            name="single_round_consensus",
            steps=[
                self._make_round_step(1),
                self._make_escalate_step(always_runs=True),
                self._make_apply_step(),
            ],
            tracer=self.tracer,
        )
