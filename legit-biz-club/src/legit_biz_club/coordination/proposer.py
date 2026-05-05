"""Proposer protocol: how the coordinator asks an agent for a change.

Abstracts the "agent reads context and produces a proposal" step. The
production implementation wraps ``jig.run_agent`` with the project
brief and current artifact content as inputs; tests use a small
deterministic stub. Plugging real LLMs in is mechanical once the
interface is stable — that wiring lands in a follow-up PR rather than
this one, since v1 incremental coordination is meaningful to validate
architecturally before paying real LLM cost.
"""
from __future__ import annotations

from typing import Protocol

from legit_biz_club.coordination.proposal import Proposal
from legit_biz_club.core.models import Agent, Artifact, Brief


class Proposer(Protocol):
    """Produces a proposal for a given agent against the current artifact."""

    async def propose(
        self,
        *,
        agent: Agent,
        brief: Brief,
        artifact: Artifact,
        current_content: str,
        current_version: str,
    ) -> Proposal:
        """Return the agent's proposal for the artifact's next state.

        Implementations read ``agent`` configuration (model, system
        prompt, frame, memory), the project ``brief``, and
        ``current_content`` to produce a proposal. The proposal's
        ``based_on_version`` should be set to ``current_version`` so the
        mediator's OCC check can detect drift if the state moved
        between this read and the eventual apply.

        The Proposer must NOT apply the proposal — that's the
        mediator's job.
        """
        ...
