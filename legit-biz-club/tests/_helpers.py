"""Test convenience helpers.

These exist to keep test boilerplate small when the framework's
non-test API surface evolves. Add helpers here when the same shape
shows up in 3+ tests.
"""
from __future__ import annotations

from typing import Any, cast

from legit_biz_club.coordination.proposer import Proposer
from legit_biz_club.core.models import Agent
from legit_biz_club.study.runner import ProposerFactory


def stub_proposer_factory(
    proposer_class: type, **proposer_kwargs: Any
) -> ProposerFactory:
    """Build a :data:`ProposerFactory` that ignores agent + context and
    constructs ``proposer_class(**proposer_kwargs)``.

    Most test proposers are stateless or closure-only — they don't
    need per-agent or per-context wiring. This helper absorbs the
    boilerplate that would otherwise repeat across every harness
    test::

        # Before
        def proposer_factory(_agent: Agent, *, context: str = "") -> Proposer:
            return _AppendingProposer()
        # After
        proposer_factory = stub_proposer_factory(_AppendingProposer)

        # With constructor args
        proposer_factory = stub_proposer_factory(_ConvergingProposer, content="x")

    When the proposer protocol grows new keyword args in the future,
    update this helper's ``_factory`` once instead of touching every
    call site.
    """

    def _factory(agent: Agent, *, context: str = "") -> Proposer:  # noqa: ARG001
        return cast(Proposer, proposer_class(**proposer_kwargs))

    return _factory
