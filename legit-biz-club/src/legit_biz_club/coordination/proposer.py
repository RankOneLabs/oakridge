"""Proposer protocol: how the coordinator asks an agent for a change.

Abstracts the "agent reads context and produces a proposal" step. The
production implementation (:class:`JigProposer`) dispatches a jig
``LLMClient`` via ``jig.llm.factory.from_model`` and calls
``LLMClient.complete()`` directly with a structured user message
assembled from the project brief and current artifact content. Tests
use a small deterministic stub.

A single :class:`Proposer` protocol covers both incremental and
convergence modes. Incremental mode and convergence round 1 pass
``peer_proposals=None`` (independence); convergence rounds 2+ pass the
prior round's proposals so agents can revise with peer context.
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
        peer_proposals: list[Proposal] | None = None,
    ) -> Proposal:
        """Return the agent's proposal for the artifact's next state.

        Implementations read ``agent`` configuration (model, system
        prompt, frame, memory), the project ``brief``, and
        ``current_content`` to produce a proposal. The proposal's
        ``based_on_version`` should be set to ``current_version`` so the
        mediator's OCC check can detect drift if the state moved
        between this read and the eventual apply.

        ``peer_proposals`` is the prior convergence round's proposals
        (``None`` for incremental commits and convergence round 1).
        When supplied, implementations should expose them to the agent
        as substrate context — read like the canonical state, not like
        messages from peers — so revision happens through the
        artifact-mediated channel rather than direct exchange.

        The Proposer must NOT apply the proposal — that's the
        mediator's job.
        """
        ...
