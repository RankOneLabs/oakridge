"""legit-biz-club: the workspace layer of oakridge.

Multi-agent collaboration over a shared artifact, mediated by a project layer.
Built on jig (agent kit) and consumed by kbbl (operator surface).
"""

from legit_biz_club.composition import (
    CompositionMode,
    CompositionPolicy,
    HeterogeneityAxis,
    HeterogeneityCheckFailed,
    HeterogeneityViolation,
    check_heterogeneity,
)
from legit_biz_club.coordination import (
    IncrementalCoordinator,
    IncrementalRunResult,
    KCommitsPerAgent,
    Mediator,
    Proposal,
    ProposalOutcome,
    ProposalResult,
    Proposer,
    TerminationPolicy,
    WorkspaceEventEmitter,
    compute_version,
)
from legit_biz_club.core import (
    Agent,
    Artifact,
    ArtifactType,
    Brief,
    CoordinationProtocol,
    Enrollment,
    InvalidTransitionError,
    Project,
    ProjectState,
    transition_to,
)

__all__ = [
    "Agent",
    "Artifact",
    "ArtifactType",
    "Brief",
    "CompositionMode",
    "CompositionPolicy",
    "CoordinationProtocol",
    "Enrollment",
    "HeterogeneityAxis",
    "HeterogeneityCheckFailed",
    "HeterogeneityViolation",
    "IncrementalCoordinator",
    "IncrementalRunResult",
    "InvalidTransitionError",
    "KCommitsPerAgent",
    "Mediator",
    "Project",
    "ProjectState",
    "Proposal",
    "ProposalOutcome",
    "ProposalResult",
    "Proposer",
    "TerminationPolicy",
    "WorkspaceEventEmitter",
    "check_heterogeneity",
    "compute_version",
    "transition_to",
]
