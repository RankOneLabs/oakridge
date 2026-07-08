"""Factory functions for the four v1 study conditions.

A :class:`ConditionConfig` describes how to construct a
:class:`ProjectCoordinator` for one cell of the study. The runner
combines a condition with a target (the brief + artifact seed) to
materialize a full project and run it.

Per the design memo's v1 test design:

1. Single-agent baseline — n=1, INCREMENTAL_ONLY.
2. Ensemble, incremental, no convergence — n=N, INCREMENTAL_ONLY.
3. Ensemble, incremental + single-round convergence at end —
   n=N, INCREMENTAL_THEN_CONVERGE with :class:`SingleRoundConsensus`.
4. Ensemble, incremental + multi-round consensus —
   n=N, INCREMENTAL_THEN_CONVERGE with :class:`MultiRoundConsensus`.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from legit_biz_club.composition import CompositionPolicy
from legit_biz_club.coordination.consensus import (
    ConsensusMechanism,
    MultiRoundConsensus,
    SingleRoundConsensus,
)
from legit_biz_club.coordination.termination import TerminationPolicy
from legit_biz_club.core.models import CoordinationProtocol


@dataclass(frozen=True, slots=True)
class ConditionConfig:
    """One v1 study condition.

    ``name`` keys into result aggregation — keep it stable across
    runs of the same condition. ``n`` is the ensemble size;
    ``coordination_protocol`` selects which combination of phases
    runs; ``consensus_mechanism_factory`` is consulted only when the
    protocol invokes consensus (and is ignored otherwise).

    ``termination_policy_factory`` overrides the incremental-phase
    termination policy. ``None`` (default) lets
    :class:`ProjectCoordinator` pick its own default
    (:class:`KCommitsOrStable` in v1). Pass e.g.
    ``lambda: KCommitsPerAgent(k=5)`` for a fixed call budget when
    cross-condition cost comparison matters more than artifact-
    stability cost-saving.

    ``composition_policy`` governs heterogeneity enforcement during
    enrollment. Defaults to :class:`CompositionPolicy` (HETEROGENEOUS
    mode, MODEL_IDENTITY + SYSTEM_PROMPT_FRAME axes enforced for n>=3).
    Pass a custom policy to opt into homogeneous mode or restrict which
    axes are checked.
    """

    name: str
    n: int
    coordination_protocol: CoordinationProtocol
    consensus_mechanism_factory: type[ConsensusMechanism] | None = None
    termination_policy_factory: Callable[[], TerminationPolicy] | None = None
    composition_policy: CompositionPolicy = field(default_factory=CompositionPolicy)


def single_agent_baseline() -> ConditionConfig:
    """Condition 1: one agent, incremental only, no consensus."""
    return ConditionConfig(
        name="single_agent",
        n=1,
        coordination_protocol=CoordinationProtocol.INCREMENTAL_ONLY,
    )


def ensemble_incremental_only(*, n: int = 5) -> ConditionConfig:
    """Condition 2: n-agent ensemble, incremental only, no convergence."""
    if n < 1:
        raise ValueError(f"n must be positive, got {n}")
    return ConditionConfig(
        name=f"ensemble_incremental_n{n}",
        n=n,
        coordination_protocol=CoordinationProtocol.INCREMENTAL_ONLY,
    )


def ensemble_with_single_round(*, n: int = 5) -> ConditionConfig:
    """Condition 3: n-agent ensemble, incremental + single-round-then-pick."""
    if n < 2:
        # SingleRoundConsensus expects at least 2 agents — one
        # proposal isn't a "round" in any meaningful sense, and the
        # disagreement surface has nothing to pick from.
        raise ValueError(
            f"single-round convergence needs n>=2, got {n}"
        )
    return ConditionConfig(
        name=f"ensemble_single_round_n{n}",
        n=n,
        coordination_protocol=CoordinationProtocol.INCREMENTAL_THEN_CONVERGE,
        consensus_mechanism_factory=SingleRoundConsensus,
    )


def ensemble_with_multi_round(*, n: int = 5) -> ConditionConfig:
    """Condition 4: n-agent ensemble, incremental + multi-round consensus."""
    if n < 2:
        # Same n>=2 floor — multi-round protocol degenerates without
        # peers to revise against; the consensus mechanism rejects
        # n<2 at enrollment in any case.
        raise ValueError(
            f"multi-round convergence needs n>=2, got {n}"
        )
    return ConditionConfig(
        name=f"ensemble_multi_round_n{n}",
        n=n,
        coordination_protocol=CoordinationProtocol.INCREMENTAL_THEN_CONVERGE,
        consensus_mechanism_factory=MultiRoundConsensus,
    )
