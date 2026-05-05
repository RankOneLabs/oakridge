"""DisagreementSurface: pick a winner when convergence didn't fire.

Signature: ``list[Proposal] → PickResult``. A `DisagreementSurface`
strategy is consulted at the escalation step of a consensus pipeline
when the round budget exhausts without convergence. v1 ships an
**automated default** (:class:`StableOrderingByAgentId`) — the
project runs end-to-end without operator intervention.

Human-in-loop is an optional alternative strategy: the operator wires
a Python callback (or a stdin / file-watch channel) per project. There
is no kbbl operator-pick UI in v1; human-in-loop is genuinely
optional.

Design memo rationale: "operator picks every escalation" would
multiply operator load on the *common* termination path (string-equal
detection rarely fires). Pushing escalation behind a configurable
strategy lets the project run end-to-end while preserving the option
to insert a human when the eval signal isn't trustworthy.
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from pydantic import BaseModel

from legit_biz_club.coordination.proposal import Proposal


class PickResult(BaseModel):
    """The :class:`DisagreementSurface`'s verdict on a residual round.

    ``proposal`` is the winning :class:`Proposal`; ``rationale`` is a
    human-readable explanation (logged via workspace events and stored
    in the run result).
    """

    proposal: Proposal
    rationale: str


class DisagreementSurface(Protocol):
    """Pick a winning proposal from the residual round."""

    async def pick(self, proposals: Sequence[Proposal]) -> PickResult:
        """Return the winning proposal plus a rationale string.

        ``proposals`` is non-empty (guaranteed by the consensus
        pipeline; the escalation step only runs when at least one
        round has produced proposals). Implementations may raise
        :class:`ValueError` on empty input as a defensive check.
        """
        ...


class StableOrderingByAgentId:
    """v1 default: deterministic pick by agent_id sort.

    Reproducible but arbitrary — no eval signal influences the choice.
    Good enough for v1 where Phase 4 (evals) hasn't shipped yet; Phase
    4 can swap in eval-based picks via the same interface without
    touching consensus code.
    """

    async def pick(self, proposals: Sequence[Proposal]) -> PickResult:
        if not proposals:
            raise ValueError("cannot pick from empty proposal list")
        sorted_proposals = sorted(proposals, key=lambda p: p.agent_id)
        winner = sorted_proposals[0]
        return PickResult(
            proposal=winner,
            rationale=(
                f"stable-ordering-by-agent-id: picked agent_id="
                f"{winner.agent_id} from {len(proposals)} residual proposals"
            ),
        )
