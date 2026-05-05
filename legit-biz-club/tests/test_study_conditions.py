"""Tests for study condition factories."""
from __future__ import annotations

import pytest

from legit_biz_club.coordination.consensus import (
    MultiRoundConsensus,
    SingleRoundConsensus,
)
from legit_biz_club.core.models import CoordinationProtocol
from legit_biz_club.study.conditions import (
    ConditionConfig,
    ensemble_incremental_only,
    ensemble_with_multi_round,
    ensemble_with_single_round,
    single_agent_baseline,
)


def test_single_agent_baseline_is_n1_incremental_only() -> None:
    cfg = single_agent_baseline()
    assert isinstance(cfg, ConditionConfig)
    assert cfg.name == "single_agent"
    assert cfg.n == 1
    assert cfg.coordination_protocol == CoordinationProtocol.INCREMENTAL_ONLY
    assert cfg.consensus_mechanism_factory is None


def test_ensemble_incremental_only_uses_protocol_and_no_mechanism() -> None:
    cfg = ensemble_incremental_only(n=5)
    assert cfg.name == "ensemble_incremental_n5"
    assert cfg.n == 5
    assert cfg.coordination_protocol == CoordinationProtocol.INCREMENTAL_ONLY
    assert cfg.consensus_mechanism_factory is None


def test_ensemble_with_single_round_selects_single_round_consensus() -> None:
    cfg = ensemble_with_single_round(n=3)
    assert cfg.name == "ensemble_single_round_n3"
    assert cfg.n == 3
    assert (
        cfg.coordination_protocol
        == CoordinationProtocol.INCREMENTAL_THEN_CONVERGE
    )
    assert cfg.consensus_mechanism_factory is SingleRoundConsensus


def test_ensemble_with_multi_round_selects_multi_round_consensus() -> None:
    cfg = ensemble_with_multi_round(n=7)
    assert cfg.name == "ensemble_multi_round_n7"
    assert cfg.n == 7
    assert (
        cfg.coordination_protocol
        == CoordinationProtocol.INCREMENTAL_THEN_CONVERGE
    )
    assert cfg.consensus_mechanism_factory is MultiRoundConsensus


def test_ensemble_incremental_rejects_zero() -> None:
    with pytest.raises(ValueError, match="n must be positive"):
        ensemble_incremental_only(n=0)


def test_single_round_requires_at_least_two_agents() -> None:
    """Single-round-then-pick degenerates with one agent — no peer
    proposals, no surface to pick from."""
    with pytest.raises(ValueError, match="single-round.*n>=2"):
        ensemble_with_single_round(n=1)


def test_multi_round_requires_at_least_two_agents() -> None:
    """Multi-round protocol degenerates without peers to revise
    against — same n>=2 floor."""
    with pytest.raises(ValueError, match="multi-round.*n>=2"):
        ensemble_with_multi_round(n=1)


def test_condition_names_stable_for_aggregation_keying() -> None:
    """Names are how result aggregation keys per-condition rollups —
    they need to be deterministic across runs."""
    assert single_agent_baseline().name == "single_agent"
    assert ensemble_incremental_only(n=5).name == "ensemble_incremental_n5"
    assert ensemble_with_single_round(n=5).name == "ensemble_single_round_n5"
    assert ensemble_with_multi_round(n=5).name == "ensemble_multi_round_n5"
