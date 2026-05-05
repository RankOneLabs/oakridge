"""Incremental coordination mode.

The default day-to-day coordination mode per the design memo. Agents
take turns proposing changes against the current artifact state; the
mediator validates via OCC, applies or rejects, and tracks per-agent
retry budgets and commit counts. Termination is policy-driven —
v1 ships ``KCommitsPerAgent`` (default K=5).

Convergence rounds and escalation are separate modes (later PRs).
"""

from legit_biz_club.coordination.coordinator import (
    IncrementalCoordinator,
    IncrementalRunResult,
    WorkspaceEventEmitter,
)
from legit_biz_club.coordination.mediator import Mediator
from legit_biz_club.coordination.proposal import (
    Proposal,
    ProposalOutcome,
    ProposalResult,
)
from legit_biz_club.coordination.proposer import Proposer
from legit_biz_club.coordination.termination import (
    KCommitsPerAgent,
    TerminationPolicy,
)
from legit_biz_club.coordination.version import compute_version

__all__ = [
    "IncrementalCoordinator",
    "IncrementalRunResult",
    "KCommitsPerAgent",
    "Mediator",
    "Proposal",
    "ProposalOutcome",
    "ProposalResult",
    "Proposer",
    "TerminationPolicy",
    "WorkspaceEventEmitter",
    "compute_version",
]
