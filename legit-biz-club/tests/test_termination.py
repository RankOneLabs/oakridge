"""Tests for the termination policies."""
from __future__ import annotations

import pytest

from legit_biz_club import KCommitsPerAgent


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
