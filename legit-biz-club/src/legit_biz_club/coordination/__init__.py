"""Coordination — incremental commits and consensus mechanisms.

Two coordination modes wired into a top-level :class:`ProjectCoordinator`
that dispatches based on the project's :class:`CoordinationProtocol`:

- **Incremental** (the day-to-day mode): agents take turns proposing
  changes against the current artifact state; the mediator validates
  via OCC, applies or rejects, and tracks per-agent retry budgets and
  commit counts. Termination is policy-driven — v1 ships
  :class:`KCommitsPerAgent` (default K=5).
- **Consensus** (rounds with peer-aware revision): each
  :class:`ConsensusMechanism` builds a jig ``run_pipeline`` internally.
  v1 ships :class:`MultiRoundConsensus` (default) and
  :class:`SingleRoundConsensus` (baseline). When the round budget
  exhausts without convergence, the :class:`DisagreementSurface` picks
  — automated by default; human-in-loop is an optional alternative
  strategy.

Real LLM calls flow through :class:`JigProposer`, which dispatches an
``LLMClient`` via ``jig.llm.factory.from_model`` and calls
``LLMClient.complete()`` directly (one shot per propose() call — no
tool-loop, no agent-state). The model's JSON envelope is parsed into
a :class:`Proposal`. Tests substitute a stub :class:`LLMClient` to
avoid real API calls.
"""

from legit_biz_club.coordination.consensus import (
    ConsensusMechanism,
    ConsensusResult,
    MultiRoundConsensus,
    RoundOutcome,
    SingleRoundConsensus,
)
from legit_biz_club.coordination.coordinator import (
    IncrementalCoordinator,
    IncrementalRunResult,
)
from legit_biz_club.coordination.disagreement import (
    DisagreementSurface,
    PickResult,
    StableOrderingByAgentId,
)
from legit_biz_club.coordination.events import (
    WorkspaceEventEmitter,
    WorkspaceEventKind,
    WorkspaceEventPayload,
)
from legit_biz_club.coordination.jig_proposer import (
    JigProposer,
    ProposerOutputParseError,
    make_proposers,
)
from legit_biz_club.coordination.mediator import Mediator
from legit_biz_club.coordination.project_coordinator import (
    ProjectCoordinator,
    ProjectRunResult,
)
from legit_biz_club.coordination.proposal import (
    Proposal,
    ProposalOutcome,
    ProposalResult,
)
from legit_biz_club.coordination.proposer import Proposer
from legit_biz_club.coordination.round_budget import (
    RoundBudgetPolicy,
    StringEqualConvergence,
)
from legit_biz_club.coordination.termination import (
    KCommitsOrStable,
    KCommitsPerAgent,
    TerminationPolicy,
)
from legit_biz_club.coordination.version import compute_version

__all__ = [
    "ConsensusMechanism",
    "ConsensusResult",
    "DisagreementSurface",
    "IncrementalCoordinator",
    "IncrementalRunResult",
    "JigProposer",
    "KCommitsOrStable",
    "KCommitsPerAgent",
    "Mediator",
    "MultiRoundConsensus",
    "PickResult",
    "ProjectCoordinator",
    "ProjectRunResult",
    "Proposal",
    "ProposalOutcome",
    "ProposalResult",
    "Proposer",
    "ProposerOutputParseError",
    "RoundBudgetPolicy",
    "RoundOutcome",
    "SingleRoundConsensus",
    "StableOrderingByAgentId",
    "StringEqualConvergence",
    "TerminationPolicy",
    "WorkspaceEventEmitter",
    "WorkspaceEventKind",
    "WorkspaceEventPayload",
    "compute_version",
    "make_proposers",
]
