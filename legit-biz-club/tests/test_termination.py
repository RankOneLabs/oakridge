"""Tests for the termination policies."""
from __future__ import annotations

import pytest

from legit_biz_club import KCommitsOrStable, KCommitsPerAgent


def test_kcommits_terminates_when_all_at_k() -> None:
    policy = KCommitsPerAgent(k=3)
    assert policy.should_terminate({"a": 3, "b": 3, "c": 3}) is True


def test_kcommits_holds_when_one_below_k() -> None:
    policy = KCommitsPerAgent(k=3)
    assert policy.should_terminate({"a": 3, "b": 2, "c": 3}) is False


def test_kcommits_terminates_when_all_above_k() -> None:
    policy = KCommitsPerAgent(k=3)
    assert policy.should_terminate({"a": 5, "b": 4, "c": 3}) is True


def test_kcommits_empty_does_not_terminate() -> None:
    policy = KCommitsPerAgent(k=3)
    assert policy.should_terminate({}) is False


def test_kcommits_rejects_non_positive_k() -> None:
    with pytest.raises(ValueError):
        KCommitsPerAgent(k=0)
    with pytest.raises(ValueError):
        KCommitsPerAgent(k=-1)


def test_kcommits_default_k_is_5() -> None:
    policy = KCommitsPerAgent()
    assert policy.k == 5


# --- KCommitsOrStable ---------------------------------------------------


def test_kcommits_or_stable_terminates_on_k_ceiling() -> None:
    """k-commits ceiling fires regardless of whether content has stabilized."""
    policy = KCommitsOrStable(k=3, stable_n=2)
    # Last 3 versions all unique; k-ceiling should still fire.
    assert (
        policy.should_terminate(
            {"a": 3, "b": 3}, recent_versions=["v1", "v2", "v3"]
        )
        is True
    )


def test_kcommits_or_stable_terminates_on_stable_tail() -> None:
    """stable_n consecutive no-ops fire even when k isn't reached."""
    policy = KCommitsOrStable(k=10, stable_n=2)
    # 4 commits, last 3 byte-identical → 2 consecutive no-ops.
    assert (
        policy.should_terminate(
            {"a": 2, "b": 2}, recent_versions=["v1", "X", "X", "X"]
        )
        is True
    )


def test_kcommits_or_stable_does_not_fire_on_one_no_op() -> None:
    """stable_n=2 requires TWO consecutive no-ops; one isn't enough."""
    policy = KCommitsOrStable(k=10, stable_n=2)
    # Last 2 versions same = 1 no-op; not enough.
    assert (
        policy.should_terminate(
            {"a": 2}, recent_versions=["v1", "X", "X"]
        )
        is False
    )


def test_kcommits_or_stable_does_not_fire_on_flapping_content() -> None:
    """A->B->A doesn't count — agents disagreed in between."""
    policy = KCommitsOrStable(k=10, stable_n=2)
    assert (
        policy.should_terminate(
            {"a": 3}, recent_versions=["v1", "X", "Y", "X"]
        )
        is False
    )


def test_kcommits_or_stable_holds_below_threshold() -> None:
    """Empty / short recent_versions doesn't fire — need stable_n+1 to evaluate."""
    policy = KCommitsOrStable(k=10, stable_n=2)
    assert policy.should_terminate({"a": 1}, recent_versions=[]) is False
    assert (
        policy.should_terminate({"a": 1}, recent_versions=["X"]) is False
    )
    assert (
        policy.should_terminate({"a": 2}, recent_versions=["X", "X"])
        is False
    )


def test_kcommits_or_stable_rejects_non_positive_args() -> None:
    with pytest.raises(ValueError, match="k must be positive"):
        KCommitsOrStable(k=0)
    with pytest.raises(ValueError, match="stable_n must be positive"):
        KCommitsOrStable(stable_n=0)


def test_kcommits_or_stable_defaults() -> None:
    policy = KCommitsOrStable()
    assert policy.k == 5
    assert policy.stable_n == 2
