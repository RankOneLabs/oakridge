"""Round-budget policy for multi-round consensus.

Bundles two related decisions: the static cap on round count
(``max_rounds``) and the per-round convergence detection
(``is_converged``). A round-budget policy is consulted by
:class:`MultiRoundConsensus` once per round — when it returns ``True``
the pipeline short-circuits remaining rounds and skips escalation.

v1 ships :class:`StringEqualConvergence` as the default. LLM outputs
vary in whitespace, ordering, and quote style even when agents agree
on substance, so this rarely fires in practice — the loop typically
terminates at ``max_rounds`` and falls through to the
:class:`DisagreementSurface`. That's by design: the protocol's value
at v1 is in the peer-aware revision phase, not in autonomous
detection. Eval-gated round termination is a v2+ candidate behind the
same interface.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Sequence

from legit_biz_club.coordination.proposal import Proposal


class RoundBudgetPolicy(ABC):
    """Decide when a multi-round consensus loop should terminate."""

    @property
    @abstractmethod
    def max_rounds(self) -> int:
        """Hard cap on round count. The pipeline is constructed with
        exactly this many round steps; if convergence never fires, the
        last round's proposals fall through to escalation."""

    @abstractmethod
    def is_converged(self, proposals: Sequence[Proposal]) -> bool:
        """Return ``True`` if the round's proposals are equivalent
        enough to stop. Called once per round after every agent has
        proposed.

        **Contract:** when this returns ``True``, all proposals'
        ``new_content`` fields MUST be byte-identical. The consensus
        pipeline's apply step relies on this to safely pick any
        proposal from the converged round (it picks the
        lowest-agent_id one for stable ordering). v1's
        :class:`StringEqualConvergence` enforces this directly. Future
        looser-equivalence detectors (semantic, eval-equivalence) need
        a separate canonical-pick hook on the policy — a v2+ concern;
        attempting to mark non-identical proposals as converged today
        risks the apply step landing on an arbitrary non-canonical
        proposal.
        """


class StringEqualConvergence(RoundBudgetPolicy):
    """v1 default: byte-identical ``new_content`` across all proposals.

    Rarely fires (LLM outputs vary in whitespace etc.), so the typical
    termination path is round-budget exhaustion → escalation. That's
    fine — multi-round's value is in the peer-aware revision phase,
    not in autonomous convergence. ``max_rounds`` defaults to 3,
    matching the design memo's recommended budget.
    """

    def __init__(self, max_rounds: int = 3) -> None:
        if max_rounds <= 0:
            raise ValueError(f"max_rounds must be positive, got {max_rounds}")
        self._max_rounds = max_rounds

    @property
    def max_rounds(self) -> int:
        return self._max_rounds

    def is_converged(self, proposals: Sequence[Proposal]) -> bool:
        if not proposals:
            return False
        contents = {p.new_content for p in proposals}
        return len(contents) == 1
